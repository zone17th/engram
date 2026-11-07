#!/usr/bin/env node
// Generates CycloneDX 1.5 SBOM at docs/phases/evidence/p06-sbom.json from:
//   1. infra/image-pins.env (verifying every pin carries an immutable @sha256:<64hex> digest)
//   2. apps/api/go.mod + apps/api/go.sum (Go module inventory + h1 SHA-256 checksums)
//   3. pnpm-lock.yaml (workspace JS dependency inventory + SRI integrity hashes)
//
// Zero external dependencies; deterministic output for a given lockfile/pin state.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, 'docs', 'phases', 'evidence', 'p06-sbom.json');

function b64ToHex(b64) {
  return Buffer.from(b64, 'base64').toString('hex');
}

function deterministicUuid(seedText) {
  const hex = createHash('sha256').update(seedText).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function parseImagePins(content) {
  const components = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) {
      throw new Error(`infra/image-pins.env:${i + 1}: malformed entry "${line}"`);
    }
    const key = line.slice(0, eqIdx).trim();
    const rawVal = line
      .slice(eqIdx + 1)
      .replace(/#.*$/, '')
      .trim();
    const match = /^([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(rawVal);
    if (!match) {
      throw new Error(
        `infra/image-pins.env:${i + 1}: "${key}" must be pinned with @sha256:<64hex>, got "${rawVal}"`,
      );
    }
    const [, imageName, sha256Hex] = match;
    const bomRef = `oci:${key}:${imageName}@sha256:${sha256Hex}`;
    components.push({
      type: 'container',
      'bom-ref': bomRef,
      name: imageName,
      version: `sha256:${sha256Hex}`,
      purl: `pkg:oci/${encodeURIComponent(imageName)}@sha256:${sha256Hex}`,
      hashes: [{ alg: 'SHA-256', content: sha256Hex }],
      properties: [{ name: 'engram:image_pin_key', value: key }],
    });
  }
  if (components.length === 0) {
    throw new Error('infra/image-pins.env: no pinned images found');
  }
  return components;
}

export function parseGoModules(goModContent, goSumContent) {
  const sumMap = new Map();
  for (const rawLine of goSumContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [mod, ver, hashToken] = parts;
    if (ver.endsWith('/go.mod')) continue;
    if (hashToken.startsWith('h1:')) {
      sumMap.set(`${mod}@${ver}`, b64ToHex(hashToken.slice(3)));
    }
  }

  const components = [];
  const deps = [];
  const goVerMatch = /^go\s+(\S+)/m.exec(goModContent);
  if (goVerMatch) {
    const goVer = goVerMatch[1];
    components.push({
      type: 'platform',
      'bom-ref': `golang:stdlib@${goVer}`,
      name: 'golang',
      version: goVer,
      purl: `pkg:generic/golang@${goVer}`,
    });
  }

  const lines = goModContent.split(/\r?\n/);
  let inRequire = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('require (')) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      continue;
    }
    let reqLine = null;
    if (inRequire) {
      reqLine = line;
    } else if (line.startsWith('require ')) {
      reqLine = line.slice('require '.length).trim();
    }
    if (!reqLine) continue;

    const indirect = /\/\/\s*indirect\b/.test(reqLine);
    const clean = reqLine.replace(/\/\/.*$/, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length < 2) continue;
    const [mod, ver] = parts;
    const key = `${mod}@${ver}`;
    const sha256Hex = sumMap.get(key);
    const bomRef = `golang:${mod}@${ver}`;
    const comp = {
      type: 'library',
      'bom-ref': bomRef,
      name: mod,
      version: ver,
      scope: 'required',
      purl: `pkg:golang/${mod}@${ver}`,
      properties: [{ name: 'engram:direct', value: indirect ? 'false' : 'true' }],
    };
    if (sha256Hex) {
      comp.hashes = [{ alg: 'SHA-256', content: sha256Hex }];
    }
    components.push(comp);
    if (!indirect) {
      deps.push(bomRef);
    }
  }
  return { components, directRefs: deps };
}

export function parsePnpmLockPackages(lockContent) {
  const components = [];
  const seen = new Set();
  const lines = lockContent.split(/\r?\n/);
  let inPackages = false;
  let currentPkg = null;

  const flushCurrent = () => {
    if (!currentPkg) return;
    const { name, version, integrity } = currentPkg;
    const key = `${name}@${version}`;
    if (!seen.has(key)) {
      seen.add(key);
      const bomRef = `npm:${name}@${version}`;
      const encodedName = name.startsWith('@')
        ? `%40${name.slice(1)}`
        : name;
      const comp = {
        type: 'library',
        'bom-ref': bomRef,
        name,
        version,
        purl: `pkg:npm/${encodedName}@${version}`,
      };
      if (integrity) {
        const sriMatch = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
        if (sriMatch) {
          const algMap = {
            sha256: 'SHA-256',
            sha384: 'SHA-384',
            sha512: 'SHA-512',
          };
          comp.hashes = [{ alg: algMap[sriMatch[1]], content: b64ToHex(sriMatch[2]) }];
        }
      }
      components.push(comp);
    }
    currentPkg = null;
  };

  for (const rawLine of lines) {
    if (/^packages:\s*$/.test(rawLine)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^[a-zA-Z0-9_-]+:/.test(rawLine)) {
      flushCurrent();
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;

    const headerMatch = /^ {2}'?(@?[^@'\s]+)@([^:'\s]+)'?:\s*(\{\})?\s*$/.exec(rawLine);
    if (headerMatch) {
      flushCurrent();
      const [, name, rawVersion] = headerMatch;
      const cleanVersion = rawVersion.replace(/\(.*/, '');
      currentPkg = { name, version: cleanVersion, integrity: null };
      continue;
    }

    if (currentPkg) {
      const integrityMatch = /integrity:\s*([^\s,}]+)/.exec(rawLine);
      if (integrityMatch && !currentPkg.integrity) {
        currentPkg.integrity = integrityMatch[1].replace(/^['"]|['"]$/g, '');
      }
    }
  }
  flushCurrent();
  return components;
}

export function parsePnpmLockImporters(lockContent) {
  const importers = new Map();
  const lines = lockContent.split(/\r?\n/);
  let inImporters = false;
  let currentImporter = null;
  let currentSection = null;
  let currentDepName = null;

  for (const rawLine of lines) {
    if (/^importers:\s*$/.test(rawLine)) {
      inImporters = true;
      continue;
    }
    if (inImporters && /^[a-zA-Z0-9_-]+:/.test(rawLine)) {
      inImporters = false;
      currentImporter = null;
      currentSection = null;
      currentDepName = null;
      continue;
    }
    if (!inImporters) continue;

    const importerMatch = /^ {2}'?([^':\s]+)'?:\s*(\{\})?\s*$/.exec(rawLine);
    if (importerMatch) {
      currentImporter = importerMatch[1];
      if (!importers.has(currentImporter)) {
        importers.set(currentImporter, []);
      }
      currentSection = null;
      currentDepName = null;
      continue;
    }
    if (!currentImporter) continue;

    const sectionMatch = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.exec(
      rawLine,
    );
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      currentDepName = null;
      continue;
    }
    if (!currentSection) continue;

    const depHeaderMatch = /^ {6}'?(@?[^':\s]+)'?:\s*$/.exec(rawLine);
    if (depHeaderMatch) {
      currentDepName = depHeaderMatch[1];
      continue;
    }

    if (currentDepName) {
      const versionMatch = /^ {8}version:\s*(.+?)\s*$/.exec(rawLine);
      if (versionMatch) {
        const rawVersion = versionMatch[1].replace(/^['"]|['"]$/g, '');
        if (rawVersion.startsWith('link:')) {
          const relTarget = rawVersion.slice('link:'.length);
          const targetImporter = posix.normalize(posix.join(currentImporter, relTarget));
          importers.get(currentImporter).push({
            name: currentDepName,
            version: rawVersion,
            bomRef: `engram:${targetImporter}`,
            isWorkspaceLink: true,
          });
        } else {
          const cleanVersion = rawVersion.replace(/\(.*/, '');
          importers.get(currentImporter).push({
            name: currentDepName,
            version: cleanVersion,
            bomRef: `npm:${currentDepName}@${cleanVersion}`,
            isWorkspaceLink: false,
          });
        }
        currentDepName = null;
      }
    }
  }
  return importers;
}

export function validateSbomGraph(sbom, lockImporters = null) {
  const declaredRefs = new Set();
  if (sbom.metadata?.component?.['bom-ref']) {
    declaredRefs.add(sbom.metadata.component['bom-ref']);
  }
  for (const comp of sbom.components ?? []) {
    if (comp['bom-ref']) {
      declaredRefs.add(comp['bom-ref']);
    }
  }
  const unresolved = [];
  const depMap = new Map();
  for (const edge of sbom.dependencies ?? []) {
    depMap.set(edge.ref, new Set(edge.dependsOn ?? []));
    if (!declaredRefs.has(edge.ref)) {
      unresolved.push(edge.ref);
    }
    for (const target of edge.dependsOn ?? []) {
      if (!declaredRefs.has(target)) {
        unresolved.push(target);
      }
    }
  }
  if (unresolved.length > 0) {
    throw new Error(`SBOM contains unresolved dependency refs: ${[...new Set(unresolved)].join(', ')}`);
  }

  const mismatches = [];
  if (lockImporters) {
    for (const [importerKey, deps] of lockImporters.entries()) {
      if (deps.length === 0) continue;
      const refKey = `engram:${importerKey}`;
      const edgeSet = depMap.get(refKey) ?? new Set();
      for (const dep of deps) {
        if (!edgeSet.has(dep.bomRef)) {
          mismatches.push({ importer: importerKey, name: dep.name, expected: dep.bomRef });
        }
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`SBOM importer direct dependency mismatches: ${JSON.stringify(mismatches)}`);
  }
  return {
    declaredCount: declaredRefs.size,
    unresolvedRefs: [],
    directDependencyMismatches: [],
  };
}

export function generateSbom({ rootDir = ROOT } = {}) {
  const pinsPath = resolve(rootDir, 'infra', 'image-pins.env');
  const goModPath = resolve(rootDir, 'apps', 'api', 'go.mod');
  const goSumPath = resolve(rootDir, 'apps', 'api', 'go.sum');
  const pnpmLockPath = resolve(rootDir, 'pnpm-lock.yaml');
  const webPkgPath = resolve(rootDir, 'apps', 'web', 'package.json');
  const sharedTypesPkgPath = resolve(rootDir, 'packages', 'shared-types', 'package.json');
  const cryptoVectorsPkgPath = resolve(rootDir, 'packages', 'crypto-vectors', 'package.json');

  const pinsContent = readFileSync(pinsPath, 'utf8').replace(/\r\n/g, '\n');
  const goModContent = readFileSync(goModPath, 'utf8').replace(/\r\n/g, '\n');
  const goSumContent = readFileSync(goSumPath, 'utf8').replace(/\r\n/g, '\n');
  const pnpmLockContent = readFileSync(pnpmLockPath, 'utf8').replace(/\r\n/g, '\n');
  const webPkg = JSON.parse(readFileSync(webPkgPath, 'utf8'));
  const sharedTypesPkg = JSON.parse(readFileSync(sharedTypesPkgPath, 'utf8'));
  const cryptoVectorsPkg = JSON.parse(readFileSync(cryptoVectorsPkgPath, 'utf8'));

  const workspaceComponents = [
    {
      type: 'application',
      'bom-ref': 'engram:apps/api',
      name: 'github.com/zone17th/engram/apps/api',
      version: '0.6.0-beta',
    },
    {
      type: 'application',
      'bom-ref': 'engram:apps/web',
      name: webPkg.name ?? '@engram/web',
      version: webPkg.version ?? '0.1.0',
    },
    {
      type: 'library',
      'bom-ref': 'engram:packages/crypto-vectors',
      name: cryptoVectorsPkg.name ?? '@engram/crypto-vectors',
      version: cryptoVectorsPkg.version ?? '0.1.0',
    },
    {
      type: 'library',
      'bom-ref': 'engram:packages/shared-types',
      name: sharedTypesPkg.name ?? '@engram/shared-types',
      version: sharedTypesPkg.version ?? '0.1.0',
    },
  ];

  const imageComponents = parseImagePins(pinsContent);
  const { components: goComponents, directRefs: goDirectRefs } = parseGoModules(
    goModContent,
    goSumContent,
  );
  const npmComponents = parsePnpmLockPackages(pnpmLockContent);
  const lockImporters = parsePnpmLockImporters(pnpmLockContent);

  const allComponents = [
    ...workspaceComponents,
    ...imageComponents,
    ...goComponents,
    ...npmComponents,
  ].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

  const seed = createHash('sha256')
    .update(pinsContent)
    .update('\0')
    .update(goModContent)
    .update('\0')
    .update(goSumContent)
    .update('\0')
    .update(pnpmLockContent)
    .digest('hex');

  const importerDirectRefs = (importerKey) =>
    [...new Set((lockImporters.get(importerKey) ?? []).map((dep) => dep.bomRef))].sort();

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(seed)}`,
    version: 1,
    metadata: {
      tools: [
        {
          vendor: 'engram',
          name: 'gen-release-artifacts.mjs',
          version: '1.0.0',
        },
      ],
      component: {
        type: 'application',
        'bom-ref': 'engram:monorepo',
        name: 'engram',
        version: '0.6.0-beta',
      },
      properties: [
        { name: 'engram:inputs_sha256', value: seed },
        { name: 'engram:workspace_components_count', value: String(workspaceComponents.length) },
        { name: 'engram:image_pins_count', value: String(imageComponents.length) },
        { name: 'engram:go_modules_count', value: String(goComponents.length) },
        { name: 'engram:npm_packages_count', value: String(npmComponents.length) },
      ],
    },
    components: allComponents,
    dependencies: [
      {
        ref: 'engram:monorepo',
        dependsOn: [
          ...workspaceComponents.map((c) => c['bom-ref']),
          ...imageComponents.map((c) => c['bom-ref']),
        ].sort(),
      },
      {
        ref: 'engram:apps/api',
        dependsOn: [...new Set(goDirectRefs)].sort(),
      },
      {
        ref: 'engram:apps/web',
        dependsOn: importerDirectRefs('apps/web'),
      },
      {
        ref: 'engram:packages/crypto-vectors',
        dependsOn: importerDirectRefs('packages/crypto-vectors'),
      },
      {
        ref: 'engram:packages/shared-types',
        dependsOn: importerDirectRefs('packages/shared-types'),
      },
    ],
  };

  validateSbomGraph(sbom, lockImporters);
  return sbom;
}

function main() {
  const args = process.argv.slice(2);
  let outPath = DEFAULT_OUT;
  let verifyOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && args[i + 1]) {
      outPath = resolve(process.cwd(), args[i + 1]);
      i += 1;
    } else if (args[i] === '--verify') {
      verifyOnly = true;
    }
  }

  if (verifyOnly) {
    const committed = JSON.parse(readFileSync(outPath, 'utf8'));
    const lockContent = readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const lockImporters = parsePnpmLockImporters(lockContent);
    const report = validateSbomGraph(committed, lockImporters);
    const webEdge = (committed.dependencies ?? []).find((d) => d.ref === 'engram:apps/web');
    const webPostcssRefs = (webEdge?.dependsOn ?? []).filter((r) => r.startsWith('npm:postcss@'));
    const importerPostcss = (lockImporters.get('apps/web') ?? []).find((d) => d.name === 'postcss');
    console.log(
      JSON.stringify({
        components: committed.components.length,
        declaredCount: report.declaredCount,
        unresolvedRefs: report.unresolvedRefs,
        directDependencyMismatches: report.directDependencyMismatches,
        webPostcssRefs,
        importerPostcssRef: importerPostcss?.bomRef ?? null,
        webPostcssMatchesImporter:
          webPostcssRefs.length === 1 && webPostcssRefs[0] === importerPostcss?.bomRef,
      }),
    );
    return;
  }

  const sbom = generateSbom({ rootDir: ROOT });
  const dir = dirname(outPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  console.log(
    `generated CycloneDX SBOM: ${relative(ROOT, outPath).replace(/\\/g, '/')} (${sbom.components.length} components)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
