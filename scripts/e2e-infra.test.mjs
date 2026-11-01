import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPortAvailable } from './e2e.mjs';
import { collectArtifacts } from './sanitize-e2e-artifacts.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function listenOnFreePort(server) {
  return new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolvePort(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

test('loopback preflight accepts a free port and rejects an occupied port', async () => {
  const server = createServer();
  const port = await listenOnFreePort(server);
  try {
    await assert.rejects(assertPortAvailable(port), /already in use/);
  } finally {
    await closeServer(server);
  }
  await assertPortAvailable(port);
});

test('harness does not parse or kill arbitrary port owners', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'e2e.mjs'), 'utf8');
  assert.doesNotMatch(source, /\b(?:netstat|freeLoopbackPort|listeningPids)\b/);
  assert.match(source, /await assertPortAvailable\(8080\)/);
  assert.match(source, /await assertPortAvailable\(3000\)/);
  assert.match(source, /if \(child && child\.exitCode !== null\)/);
  assert.match(source, /finally \{[\s\S]*await stopAll\(\)/);
});

test('origin and diagnostic settings stay explicit and safe', () => {
  const config = readFileSync(join(ROOT, 'apps', 'web', 'playwright.config.ts'), 'utf8');
  const compose = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(config, /trace: 'off'/);
  assert.match(config, /video: 'off'/);
  assert.match(config, /screenshot: 'off'/);
  assert.match(config, /reuseExistingServer: false/);
  assert.match(config, /noSnippets: true/);
  assert.equal((compose.match(/APP_ORIGIN: \$\{APP_ORIGIN:-http:\/\/127\.0\.0\.1:3000\}/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /curl --fail --silent http:\/\/localhost:3000/);
  assert.match(workflow, /--env APP_ORIGIN/);
  assert.match(workflow, /sanitize-e2e-artifacts\.mjs/);
  // Shared host mount must be writable by distroless nonroot (compose init as root).
  assert.match(compose, /mail-sink-perms:[\s\S]*chmod 0777 \/sink/);
  assert.doesNotMatch(workflow, /path:\s*\|[\s\S]*apps\/web\/test-results\s*$/m);
});

test('artifact staging omits reports and keeps only public a11y screenshots', () => {
  mkdirSync(join(ROOT, '.data'), { recursive: true });
  const tempRoot = mkdtempSync(join(ROOT, '.data', 'e2e-infra-test-'));
  const reportRoot = join(tempRoot, 'report');
  const resultsRoot = join(tempRoot, 'results');
  const outputRoot = join(tempRoot, '.data', 'out');
  try {
    mkdirSync(join(reportRoot, 'data'), { recursive: true });
    mkdirSync(join(resultsRoot, 'a11y-login-mobile-390'), { recursive: true });
    mkdirSync(join(resultsRoot, 'a11y-login-tablet-768'), { recursive: true });
    mkdirSync(join(resultsRoot, 'a11y-login-desktop-1440'), { recursive: true });
    writeFileSync(
      join(reportRoot, 'index.html'),
      'https://127.0.0.1/callback#token=proof email=user@example.test login-password-12 ' +
        'cHJpdmF0ZSB0cmFjZSB0b2tlbj1wcm9vZg==',
    );
    writeFileSync(join(reportRoot, 'data', 'trace.zip'), 'private trace');
    writeFileSync(join(resultsRoot, 'a11y-login-mobile-390', 'login-en-light.png'), 'safe-mobile');
    writeFileSync(join(resultsRoot, 'a11y-login-tablet-768', 'login-en-light.png'), 'safe-tablet');
    writeFileSync(join(resultsRoot, 'a11y-login-desktop-1440', 'login-en-light.png'), 'safe-desktop');
    writeFileSync(join(resultsRoot, 'a11y-login-mobile-390', 'settings-account.png'), 'private');

    const result = collectArtifacts({ root: tempRoot, resultsRoot, outputRoot });
    assert.equal(result.screenshots.length, 3);
    const manifest = readFileSync(join(outputRoot, 'manifest.json'), 'utf8');
    assert.doesNotMatch(manifest, /token=proof|user@example\.test|login-password-12|cHJpdmF0ZQ/);
    assert.equal(existsSync(join(outputRoot, 'report')), false);
    assert.equal(existsSync(join(outputRoot, 'playwright-report')), false);
    assert.equal(existsSync(join(outputRoot, 'a11y-screenshots', 'mobile-390-login-en-light.png')), true);
    assert.equal(existsSync(join(outputRoot, 'a11y-screenshots', 'tablet-768-login-en-light.png')), true);
    assert.equal(existsSync(join(outputRoot, 'a11y-screenshots', 'desktop-1440-login-en-light.png')), true);
    assert.equal(existsSync(join(outputRoot, 'a11y-screenshots', 'mobile-390-settings-account.png')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('artifact staging refuses an output directory outside workspace .data', () => {
  assert.throws(
    () => collectArtifacts({ root: ROOT, outputRoot: resolve(ROOT, 'e2e-artifacts-outside-data') }),
    /outside/,
  );
});

const ORPHAN_SPEC_ALLOWLIST = new Set(['transport.spec.ts', 'visual.spec.ts', 'crypto-worker.dev.spec.ts']);

function expandBracePatterns(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match) return [pattern];
  const [full, body] = match;
  const index = match.index;
  const prefix = pattern.slice(0, index);
  const suffix = pattern.slice(index + full.length);
  const results = [];
  for (const part of body.split(',')) {
    results.push(...expandBracePatterns(`${prefix}${part}${suffix}`));
  }
  return results;
}

function expandSingleGlobToRegExp(glob) {
  let regex = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i += 1;
        }
      } else {
        regex += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function compileIncludeMatchers(includePatterns) {
  const regexes = [];
  for (const pattern of includePatterns) {
    for (const expanded of expandBracePatterns(pattern)) {
      regexes.push(expandSingleGlobToRegExp(expanded));
    }
  }
  return (relPath) => regexes.some((re) => re.test(relPath));
}

function walkFilesRecursive(dir, filterDir = () => true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (filterDir(entry.name, full)) out.push(...walkFilesRecursive(full, filterDir));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function readRegExpLiteralAt(source, startIndex) {
  let index = startIndex;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '/') return null;
  index += 1;
  let pattern = '';
  let inCharClass = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      pattern += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (ch === '[') inCharClass = true;
    else if (ch === ']') inCharClass = false;
    else if (ch === '/' && !inCharClass) {
      index += 1;
      let flags = '';
      while (index < source.length && /[gimsuy]/.test(source[index])) {
        flags += source[index];
        index += 1;
      }
      return new RegExp(pattern, flags);
    }
    pattern += ch;
    index += 1;
  }
  return null;
}

function parseDefaultPlaywrightProjects(configSource) {
  const projects = [];
  // Strip conditional spread blocks `...(process.env.E2E_... ? [ ... ] : [])` which require opt-in env vars.
  const defaultConfigSource = configSource.replace(/\.\.\.\(process\.env\.[A-Z0-9_]+[\s\S]*?:\s*\[\]\),?/g, '');
  const projectHeaderRegex = /\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?testMatch:\s*/g;
  for (const match of defaultConfigSource.matchAll(projectHeaderRegex)) {
    const name = match[1];
    const regexStart = match.index + match[0].length;
    const testMatch = readRegExpLiteralAt(defaultConfigSource, regexStart);
    assert.ok(testMatch, `failed to parse testMatch RegExp for Playwright project "${name}"`);
    projects.push({ name, testMatch });
  }
  return projects;
}

test('every e2e/*.spec.ts matches at least one default Playwright project except the fixed allowlist', () => {
  const webRoot = join(ROOT, 'apps', 'web');
  const e2eDir = join(webRoot, 'e2e');
  const allSpecs = readdirSync(e2eDir)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();

  const configSource = readFileSync(join(webRoot, 'playwright.config.ts'), 'utf8');
  const projects = parseDefaultPlaywrightProjects(configSource);
  assert.ok(projects.length > 0, 'expected default Playwright projects');
  assert.ok(
    projects.some((project) => project.name === 'content'),
    'expected Playwright project "content"',
  );
  const configMatched = new Set();
  for (const spec of allSpecs) {
    const rel = `e2e/${spec}`;
    for (const project of projects) {
      const matchers = Array.isArray(project.testMatch) ? project.testMatch : [project.testMatch];
      for (const matcher of matchers) {
        if (matcher instanceof RegExp && (matcher.test(rel) || matcher.test(spec))) {
          configMatched.add(spec);
        }
      }
    }
  }

  // Verify via `playwright test --list` (default env) whenever @playwright/test is installed.
  const cliPath = join(webRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  if (existsSync(cliPath)) {
    const env = { ...process.env };
    delete env.E2E_VAULT_PROD;
    delete env.E2E_CRYPTO_DEV;
    const listed = spawnSync(process.execPath, [cliPath, 'test', '--list', '--reporter=json'], {
      cwd: webRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, `playwright test --list failed: ${listed.stderr || listed.stdout}`);
    const report = JSON.parse(listed.stdout);
    const cliMatched = new Set();
    function collectSpecs(suites) {
      for (const suite of suites ?? []) {
        if (suite.file) cliMatched.add(suite.file.replace(/^.*[/\\]/, ''));
        collectSpecs(suite.suites);
      }
    }
    collectSpecs(report.suites);
    assert.deepEqual([...cliMatched].sort(), [...configMatched].sort());
  }

  const unallowlistedOrphans = allSpecs.filter((spec) => !configMatched.has(spec) && !ORPHAN_SPEC_ALLOWLIST.has(spec));
  assert.deepEqual(
    unallowlistedOrphans,
    [],
    `Orphan e2e spec files not matched by any default project: ${unallowlistedOrphans.join(', ')}`,
  );

  const allowlistedButMatched = [...ORPHAN_SPEC_ALLOWLIST].filter((spec) => configMatched.has(spec));
  assert.deepEqual(
    allowlistedButMatched,
    [],
    `Allowlisted special-config specs unexpectedly matched a default project: ${allowlistedButMatched.join(', ')}`,
  );

  // Ensure non-content projects never match content-*.spec.ts files.
  for (const project of projects) {
    if (project.name === 'content') continue;
    const matchers = Array.isArray(project.testMatch) ? project.testMatch : [project.testMatch];
    for (const matcher of matchers) {
      if (matcher instanceof RegExp) {
        assert.equal(
          matcher.test('e2e/content-a11y.spec.ts') || matcher.test('content-a11y.spec.ts'),
          false,
          `project "${project.name}" must not match content-*.spec.ts`,
        );
      }
    }
  }
});

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function validateDockerfileContentBuildFlag(dockerfileSource) {
  const stageHeaderRegex = /^FROM\s+\S+(?:\s+AS\s+([A-Za-z0-9._-]+))?\s*$/gm;
  const headers = [...dockerfileSource.matchAll(stageHeaderRegex)];
  assert.ok(headers.length > 0, 'Dockerfile must contain at least one FROM stage');

  const stages = headers.map((header, idx) => {
    const start = header.index + header[0].length;
    const end = idx + 1 < headers.length ? headers[idx + 1].index : dockerfileSource.length;
    return {
      name: header[1] ?? null,
      body: dockerfileSource.slice(start, end),
    };
  });

  const buildStageRegex = /^\s*RUN\b[^\r\n]*\b(?:pnpm\b[^\r\n]*\bbuild|next\s+build)\b/m;
  const buildStages = stages.filter((stage) => buildStageRegex.test(stage.body));
  assert.equal(buildStages.length, 1, 'expected exactly one Dockerfile build stage running next/pnpm build');

  const buildStage = buildStages[0];
  assert.equal(buildStage.name, 'build', 'expected the Dockerfile build stage to be named AS build');

  const buildRunMatch = buildStage.body.match(buildStageRegex);
  const beforeBuildRun = buildStage.body.slice(0, buildRunMatch.index);

  const argDeclarations = [
    ...beforeBuildRun.matchAll(/^\s*ARG\s+NEXT_PUBLIC_CONTENT_ENABLED(?:=([^\s#]+))?\s*$/gm),
  ];
  assert.equal(
    argDeclarations.length,
    1,
    'build stage must declare ARG NEXT_PUBLIC_CONTENT_ENABLED=false once before the build RUN line',
  );
  assert.equal(
    argDeclarations[0][1],
    'false',
    'build stage ARG NEXT_PUBLIC_CONTENT_ENABLED must default to false before the build RUN line',
  );

  const envDeclarations = [
    ...beforeBuildRun.matchAll(/^\s*ENV\s+NEXT_PUBLIC_CONTENT_ENABLED(?:=|\s+)([^\s#]+)\s*$/gm),
  ];
  assert.equal(
    envDeclarations.length,
    1,
    'build stage must declare ENV NEXT_PUBLIC_CONTENT_ENABLED=${NEXT_PUBLIC_CONTENT_ENABLED} once before the build RUN line',
  );
  assert.match(
    envDeclarations[0][1],
    /^\$\{NEXT_PUBLIC_CONTENT_ENABLED\}|\$NEXT_PUBLIC_CONTENT_ENABLED$/,
    'build stage ENV NEXT_PUBLIC_CONTENT_ENABLED must reference NEXT_PUBLIC_CONTENT_ENABLED build arg',
  );
  assert.ok(
    argDeclarations[0].index < envDeclarations[0].index,
    'build stage ARG NEXT_PUBLIC_CONTENT_ENABLED=false must precede ENV NEXT_PUBLIC_CONTENT_ENABLED',
  );
}

function extractYamlIndentedSubblock(lines, startIndex, parentIndent) {
  const extracted = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const raw = lines[i];
    const clean = stripYamlComment(raw);
    if (!clean.trim()) continue;
    const indent = clean.match(/^ */)[0].length;
    if (indent <= parentIndent) break;
    extracted.push({ indent, text: clean.trim(), rawLine: raw });
  }
  return extracted;
}

function parseComposeWebBuildArgs(composeSource) {
  const lines = composeSource.split(/\r?\n/);
  const servicesIdx = lines.findIndex((line) => stripYamlComment(line).trim() === 'services:');
  assert.notEqual(servicesIdx, -1, 'compose file must contain top-level services: block');
  const servicesIndent = lines[servicesIdx].match(/^ */)[0].length;

  let webIdx = -1;
  let webIndent = -1;
  for (let i = servicesIdx + 1; i < lines.length; i += 1) {
    const clean = stripYamlComment(lines[i]);
    if (!clean.trim()) continue;
    const indent = clean.match(/^ */)[0].length;
    if (indent <= servicesIndent) break;
    if (clean.trim() === 'web:') {
      webIdx = i;
      webIndent = indent;
      break;
    }
  }
  assert.notEqual(webIdx, -1, 'compose services must define web:');
  const webLines = extractYamlIndentedSubblock(lines, webIdx + 1, webIndent);

  const buildEntryIdx = webLines.findIndex((entry) => entry.indent === webIndent + 2 && entry.text === 'build:');
  assert.notEqual(buildEntryIdx, -1, 'compose services.web must define build:');
  const buildIndent = webLines[buildEntryIdx].indent;
  const buildLines = [];
  for (let i = buildEntryIdx + 1; i < webLines.length; i += 1) {
    if (webLines[i].indent <= buildIndent) break;
    buildLines.push(webLines[i]);
  }

  const argsEntryIdx = buildLines.findIndex((entry) => entry.indent === buildIndent + 2 && entry.text === 'args:');
  assert.notEqual(argsEntryIdx, -1, 'compose services.web.build must define args:');
  const argsIndent = buildLines[argsEntryIdx].indent;
  const argsMap = new Map();
  for (let i = argsEntryIdx + 1; i < buildLines.length; i += 1) {
    const entry = buildLines[i];
    if (entry.indent <= argsIndent) break;
    if (entry.indent === argsIndent + 2) {
      const kv = entry.text.match(/^(?:-\s*)?([A-Za-z0-9_]+)\s*(?::|=)\s*(.+)$/);
      if (kv) {
        argsMap.set(kv[1], kv[2].trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }
  return argsMap;
}

function validateComposeWebContentBuildArg(composeSource) {
  const argsMap = parseComposeWebBuildArgs(composeSource);
  assert.equal(
    argsMap.get('NEXT_PUBLIC_CONTENT_ENABLED'),
    '${NEXT_PUBLIC_CONTENT_ENABLED:-false}',
    'compose services.web.build.args.NEXT_PUBLIC_CONTENT_ENABLED must be ${NEXT_PUBLIC_CONTENT_ENABLED:-false}',
  );
}

function parseYamlEnvBlock(lines, startIndex, envHeaderIndent) {
  const env = new Map();
  for (let i = startIndex; i < lines.length; i += 1) {
    const clean = stripYamlComment(lines[i]);
    if (!clean.trim()) continue;
    const indent = clean.match(/^ */)[0].length;
    if (indent <= envHeaderIndent) break;
    if (indent === envHeaderIndent + 2) {
      const kv = clean.trim().match(/^([A-Za-z0-9_]+):\s*(.+)$/);
      if (kv) {
        env.set(kv[1], kv[2].trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }
  return env;
}

function parseCiJobModel(jobBody) {
  const lines = jobBody.split(/\r?\n/);
  let jobEnv = new Map();
  let stepsHeaderIdx = -1;
  let stepsHeaderIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const clean = stripYamlComment(lines[i]);
    if (!clean.trim()) continue;
    const indent = clean.match(/^ */)[0].length;
    if (indent === 4 && clean.trim() === 'env:') {
      jobEnv = parseYamlEnvBlock(lines, i + 1, indent);
    } else if (indent === 4 && clean.trim() === 'steps:') {
      stepsHeaderIdx = i;
      stepsHeaderIndent = indent;
      break;
    }
  }
  assert.notEqual(stepsHeaderIdx, -1, 'CI job must define steps:');

  const stepChunks = [];
  let currentStepLines = null;
  for (let i = stepsHeaderIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    const clean = stripYamlComment(raw);
    if (clean.trim()) {
      const indent = clean.match(/^ */)[0].length;
      if (indent <= stepsHeaderIndent) break;
      if (indent === 6 && clean.trim().startsWith('- ')) {
        if (currentStepLines) stepChunks.push(currentStepLines);
        currentStepLines = [raw.replace(/^ {6}-\s/, '        ')];
        continue;
      }
    }
    if (currentStepLines) currentStepLines.push(raw);
  }
  if (currentStepLines) stepChunks.push(currentStepLines);

  const steps = stepChunks.map((stepLines) => {
    let name = '';
    let stepEnv = new Map();
    const runLines = [];
    for (let i = 0; i < stepLines.length; i += 1) {
      const clean = stripYamlComment(stepLines[i]);
      if (!clean.trim()) continue;
      const indent = clean.match(/^ */)[0].length;
      const trimmed = clean.trim();
      if (indent === 8 && trimmed.startsWith('name:')) {
        name = trimmed.slice('name:'.length).trim().replace(/^['"]|['"]$/g, '');
      } else if (indent === 8 && trimmed === 'env:') {
        stepEnv = parseYamlEnvBlock(stepLines, i + 1, indent);
      } else if (indent === 8 && trimmed.startsWith('run:')) {
        const inline = trimmed.slice('run:'.length).trim();
        if (inline && inline !== '|' && inline !== '>') {
          runLines.push(inline);
        } else {
          for (let j = i + 1; j < stepLines.length; j += 1) {
            const runClean = stripYamlComment(stepLines[j]);
            if (!runClean.trim()) continue;
            const runIndent = runClean.match(/^ */)[0].length;
            if (runIndent <= indent) break;
            runLines.push(runClean.trim());
          }
        }
      }
    }
    const effectiveEnv = new Map(jobEnv);
    for (const [k, v] of stepEnv) effectiveEnv.set(k, v);
    return { name, jobEnv, stepEnv, effectiveEnv, runLines, runText: runLines.join('\n') };
  });

  return { jobEnv, steps };
}

function validateCiContentAndBrowserJobs(workflowSource) {
  const browserJobMatch = workflowSource.match(/  e2e-browser:\r?\n([\s\S]*?)(?=\r?\n  [a-z0-9-]+:|$)/);
  assert.ok(browserJobMatch, 'missing e2e-browser job in ci.yml');
  const browserJobBody = browserJobMatch[1];
  const browserModel = parseCiJobModel(browserJobBody);

  const browserComposeUpSteps = browserModel.steps.filter((step) =>
    /\bdocker\s+compose\b[\s\S]*\bup\b[\s\S]*--build\b/.test(step.runText),
  );
  assert.equal(browserComposeUpSteps.length, 1, 'expected one docker compose up --build step in e2e-browser');
  assert.equal(
    browserComposeUpSteps[0].effectiveEnv.get('NEXT_PUBLIC_CONTENT_ENABLED'),
    'true',
    'e2e-browser stack-start (docker compose up --build) step must have effective NEXT_PUBLIC_CONTENT_ENABLED=true',
  );

  const browserPlaywrightLines = browserModel.steps
    .flatMap((step) => step.runLines)
    .filter((line) => line.includes('playwright test') && !line.includes('vault-prod'));
  assert.equal(browserPlaywrightLines.length, 1, 'expected one main playwright test command in e2e-browser');
  const browserCmd = browserPlaywrightLines[0];
  assert.match(browserCmd, /--project(?:=|\s+)auth\b/);
  assert.match(browserCmd, /--project(?:=|\s+)mobile-390\b/);
  assert.match(browserCmd, /--project(?:=|\s+)tablet-768\b/);
  assert.match(browserCmd, /--project(?:=|\s+)desktop-1440\b/);
  assert.match(browserCmd, /--project(?:=|\s+)vault\b/);
  assert.doesNotMatch(browserCmd, /--project(?:=|\s+)content\b/);

  const contentJobMatch = workflowSource.match(
    /  [a-z0-9-]+:\r?\n    name:\s*Content e2e \(email verification required\)\r?\n([\s\S]*?)(?=\r?\n  [a-z0-9-]+:|$)/,
  );
  assert.ok(contentJobMatch, 'missing "Content e2e (email verification required)" job in ci.yml');
  const contentJobBody = contentJobMatch[1];
  assert.match(contentJobBody, /timeout-minutes:\s*30\b/);
  assert.match(contentJobBody, /sanitize-e2e-artifacts\.mjs/);

  const contentModel = parseCiJobModel(contentJobBody);
  const contentComposeUpSteps = contentModel.steps.filter((step) =>
    /\bdocker\s+compose\b[\s\S]*\bup\b[\s\S]*--build\b/.test(step.runText),
  );
  assert.equal(contentComposeUpSteps.length, 1, 'expected one docker compose up --build step in Content e2e job');
  assert.equal(
    contentComposeUpSteps[0].effectiveEnv.get('NEXT_PUBLIC_CONTENT_ENABLED'),
    'true',
    'Content e2e stack-start (docker compose up --build) step must have effective NEXT_PUBLIC_CONTENT_ENABLED=true',
  );
  assert.equal(
    contentComposeUpSteps[0].effectiveEnv.get('AUTH_FAKE_OAUTH'),
    'false',
    'Content e2e stack-start step must have effective AUTH_FAKE_OAUTH=false',
  );

  const contentPlaywrightLines = contentModel.steps
    .flatMap((step) => step.runLines)
    .filter((line) => line.includes('playwright test'));
  assert.equal(contentPlaywrightLines.length, 1, 'expected one playwright test command in Content e2e job');
  assert.match(contentPlaywrightLines[0], /--project(?:=|\s+)content\b/);
}

test('Content e2e CI job, Browser project filter, and NEXT_PUBLIC_CONTENT_ENABLED defaults stay aligned', () => {
  const dockerfile = readFileSync(join(ROOT, 'apps', 'web', 'Dockerfile'), 'utf8');
  const compose = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  validateDockerfileContentBuildFlag(dockerfile);
  validateComposeWebContentBuildArg(compose);
  validateCiContentAndBrowserJobs(workflow);
});

test('NEXT_PUBLIC_CONTENT_ENABLED build guards reject runtime-only declarations and comments', () => {
  const dockerfile = readFileSync(join(ROOT, 'apps', 'web', 'Dockerfile'), 'utf8');
  const compose = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  // (1) Remove build-stage ARG/ENV while keeping runtime stage declarations.
  const dockerfileWithoutBuildStageFlag = dockerfile.replace(
    /FROM \$\{NODE_IMAGE\} AS build[\s\S]*?RUN pnpm --filter @engram\/web build/,
    (stage) =>
      stage
        .replace(/^ARG NEXT_PUBLIC_CONTENT_ENABLED=false\r?\n/m, '')
        .replace(/^ENV NEXT_PUBLIC_CONTENT_ENABLED=\$\{NEXT_PUBLIC_CONTENT_ENABLED\}\r?\n/m, ''),
  );
  assert.notEqual(dockerfileWithoutBuildStageFlag, dockerfile);
  assert.throws(
    () => validateDockerfileContentBuildFlag(dockerfileWithoutBuildStageFlag),
    /build stage must declare ARG NEXT_PUBLIC_CONTENT_ENABLED=false/,
  );

  // (2) Change only the build-stage default to true while runtime stage keeps false.
  const dockerfileBuildStageDefaultTrue = dockerfile.replace(
    /FROM \$\{NODE_IMAGE\} AS build[\s\S]*?RUN pnpm --filter @engram\/web build/,
    (stage) => stage.replace(/^ARG NEXT_PUBLIC_CONTENT_ENABLED=false$/m, 'ARG NEXT_PUBLIC_CONTENT_ENABLED=true'),
  );
  assert.notEqual(dockerfileBuildStageDefaultTrue, dockerfile);
  assert.throws(
    () => validateDockerfileContentBuildFlag(dockerfileBuildStageDefaultTrue),
    /build stage ARG NEXT_PUBLIC_CONTENT_ENABLED must default to false/,
  );

  // (3) Remove compose services.web.build.args entry while keeping services.web.environment entry.
  const composeWithoutBuildArg = compose.replace(
    /(build:\r?\n\s+context:\s+\.\.\r?\n\s+dockerfile:\s+apps\/web\/Dockerfile\r?\n\s+args:\r?\n[\s\S]*?)^\s+NEXT_PUBLIC_CONTENT_ENABLED:\s*\$\{NEXT_PUBLIC_CONTENT_ENABLED:-false\}\r?\n/m,
    '$1',
  );
  assert.notEqual(composeWithoutBuildArg, compose);
  assert.match(composeWithoutBuildArg, /environment:[\s\S]*NEXT_PUBLIC_CONTENT_ENABLED:\s*\$\{NEXT_PUBLIC_CONTENT_ENABLED:-false\}/);
  assert.throws(
    () => validateComposeWebContentBuildArg(composeWithoutBuildArg),
    /compose services\.web\.build\.args\.NEXT_PUBLIC_CONTENT_ENABLED/,
  );

  // (4) Remove Browser stack-start step flag while keeping Playwright step flag.
  const workflowWithoutBrowserStackFlag = workflow.replace(
    /(- name: Build and start the stack\r?\n\s+env:\r?\n\s+AUTH_FAKE_OAUTH: 'true'\r?\n\s+AUTH_REQUIRE_EMAIL_VERIFICATION: 'false'\r?\n)\s+NEXT_PUBLIC_CONTENT_ENABLED: 'true'\r?\n/,
    '$1',
  );
  assert.notEqual(workflowWithoutBrowserStackFlag, workflow);
  assert.throws(
    () => validateCiContentAndBrowserJobs(workflowWithoutBrowserStackFlag),
    /e2e-browser stack-start .* NEXT_PUBLIC_CONTENT_ENABLED=true/,
  );

  // (5) Remove Content job-level NEXT_PUBLIC_CONTENT_ENABLED while keeping Playwright-step flag.
  const workflowWithoutContentStackFlag = workflow.replace(
    /(  e2e-content-verify-true:[\s\S]*?AUTH_REQUIRE_EMAIL_VERIFICATION: 'true'\r?\n)\s+NEXT_PUBLIC_CONTENT_ENABLED: 'true'\r?\n/,
    '$1',
  );
  assert.notEqual(workflowWithoutContentStackFlag, workflow);
  assert.throws(
    () => validateCiContentAndBrowserJobs(workflowWithoutContentStackFlag),
    /Content e2e stack-start .* NEXT_PUBLIC_CONTENT_ENABLED=true/,
  );

  // (6) Override Content stack-start step flag to false while job/Playwright step has true.
  const workflowWithContentStackFlagFalse = workflow.replace(
    /(  e2e-content-verify-true:[\s\S]*?- name: Build and start the stack\r?\n)(\s+run: docker compose)/,
    "$1        env:\n          NEXT_PUBLIC_CONTENT_ENABLED: 'false'\n$2",
  );
  assert.notEqual(workflowWithContentStackFlagFalse, workflow);
  assert.throws(
    () => validateCiContentAndBrowserJobs(workflowWithContentStackFlagFalse),
    /Content e2e stack-start .* NEXT_PUBLIC_CONTENT_ENABLED=true/,
  );

  // (7) Comment lines mentioning `playwright test` inside e2e-browser do not break command detection.
  const workflowWithPlaywrightComment = workflow.replace(
    /- name: Run browser checks in pinned Playwright image\r?\n/,
    (match) => `${match}        # Note: playwright test runs in container below\n`,
  );
  assert.notEqual(workflowWithPlaywrightComment, workflow);
  validateCiContentAndBrowserJobs(workflowWithPlaywrightComment);
});

test('every *.test.ts(x) under apps/web runs at runtime exactly once (vitest include XOR one tests/ shim)', () => {
  const webRoot = join(ROOT, 'apps', 'web');
  const vitestConfigSource = readFileSync(join(webRoot, 'vitest.config.ts'), 'utf8');
  const includeBlockMatch = vitestConfigSource.match(/include\s*:\s*\[([\s\S]*?)\]/);
  assert.ok(includeBlockMatch, 'unable to locate test.include array in apps/web/vitest.config.ts');
  const includePatterns = [...includeBlockMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(includePatterns.length > 0, 'test.include in apps/web/vitest.config.ts must not be empty');

  const matchesInclude = compileIncludeMatchers(includePatterns);

  const allTestFiles = walkFilesRecursive(
    webRoot,
    (dirName) => dirName !== 'node_modules' && dirName !== 'e2e' && dirName !== '.next' && dirName !== 'test-results',
  )
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => relative(webRoot, file).split('\\').join('/'))
    .sort();

  // Parse shims in apps/web/tests/ that import other *.test.ts(x) files.
  const shimImportsByTarget = new Map();
  const testsDir = join(webRoot, 'tests');
  for (const file of walkFilesRecursive(testsDir)) {
    if (!/\.test\.tsx?$/.test(file)) continue;
    const shimRel = relative(webRoot, file).split('\\').join('/');
    const source = readFileSync(file, 'utf8');
    const importRegex = /^\s*import\s+['"]([^'"]+\.test(?:\.tsx?)?)['"]\s*;?\s*$/gm;
    for (const match of source.matchAll(importRegex)) {
      const spec = match[1];
      const resolvedBase = resolve(dirname(file), spec);
      const candidates = [resolvedBase, `${resolvedBase}.ts`, `${resolvedBase}.tsx`];
      const targetFull = candidates.find((candidate) => existsSync(candidate));
      assert.ok(targetFull, `shim ${shimRel} imports missing test target ${spec}`);
      const targetRel = relative(webRoot, targetFull).split('\\').join('/');
      const existing = shimImportsByTarget.get(targetRel) ?? [];
      existing.push(shimRel);
      shimImportsByTarget.set(targetRel, existing);
    }
  }

  const violations = [];
  for (const testFile of allTestFiles) {
    const inInclude = matchesInclude(testFile);
    const shims = shimImportsByTarget.get(testFile) ?? [];
    if (inInclude && shims.length > 0) {
      violations.push(`${testFile}: matched by vitest include AND imported by shim(s) ${shims.join(', ')}`);
    } else if (!inInclude && shims.length === 0) {
      violations.push(`${testFile}: neither matched by vitest include nor imported by any shim in tests/`);
    } else if (!inInclude && shims.length > 1) {
      violations.push(`${testFile}: imported by multiple shims (${shims.join(', ')})`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `apps/web unit test coverage must be exact (include XOR one shim):\n${violations.join('\n')}`,
  );
});
