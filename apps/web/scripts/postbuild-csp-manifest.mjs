import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const SRC_ATTR_RE = /(?:^|\s)src\s*=/i;
const TYPE_ATTR_RE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
]);

/**
 * Extracts CSP `'sha256-<base64>'` tokens for every executable inline `<script>`
 * in an HTML string, preserving deterministic deduplicated order.
 */
export function extractInlineScriptHashes(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const seen = new Set();
  const hashes = [];

  for (const match of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (SRC_ATTR_RE.test(attrs)) continue;
    if (body.length === 0) continue;

    const typeMatch = attrs.match(TYPE_ATTR_RE);
    const rawType = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').trim().toLowerCase();
    if (!EXECUTABLE_SCRIPT_TYPES.has(rawType)) continue;

    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    const token = `'sha256-${digest}'`;
    if (!seen.has(token)) {
      seen.add(token);
      hashes.push(token);
    }
  }
  return hashes;
}

// Maps a `.next/server/app/.../*.html` relative path to the public route pathname(s)
// seen by `middleware.ts` (`localePrefix: 'as-needed'`, defaultLocale `'en'`).
export function htmlRelativePathToRoutes(relativeHtmlPath, defaultLocale = 'en') {
  const posixRel = relativeHtmlPath.split(path.sep).join('/').replace(/^\/+/, '');
  if (!posixRel.endsWith('.html')) return [];

  const withoutExt = posixRel.slice(0, -'.html'.length);
  const rawSegments = withoutExt.split('/').filter(Boolean);
  // Strip Next route groups `(marketing)`
  const segments = rawSegments.filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')));
  if (segments.length === 0) return [];

  // Skip internal Next error/not-found shells and `/app/*` (which uses per-request nonces)
  if (segments[0].startsWith('_') || segments[0] === 'app') {
    return [];
  }
  if (segments[segments.length - 1] === 'index') {
    segments.pop();
  }
  const rawRoute = '/' + segments.join('/');
  const normalizedRaw = rawRoute === '' ? '/' : rawRoute;

  const routes = new Set([normalizedRaw]);
  if (normalizedRaw === `/${defaultLocale}`) {
    routes.add('/');
  } else if (normalizedRaw.startsWith(`/${defaultLocale}/`)) {
    const unprefixed = normalizedRaw.slice(`/${defaultLocale}`.length);
    routes.add(unprefixed || '/');
  }
  return [...routes].sort();
}

function walkFiles(dirPath, predicate) {
  if (!fs.existsSync(dirPath)) return [];
  const results = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

export function generateCspAndBuildManifests({
  webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  nextDir = path.join(webRoot, '.next'),
  outDir = path.join(webRoot, 'public', '.well-known'),
  defaultLocale = 'en',
} = {}) {
  const serverAppDir = path.join(nextDir, 'server', 'app');
  const staticDir = path.join(nextDir, 'static');

  const htmlFiles = walkFiles(serverAppDir, (file) => file.endsWith('.html'));
  const routeMap = new Map();

  for (const htmlFile of htmlFiles) {
    const relPath = path.relative(serverAppDir, htmlFile);
    const routes = htmlRelativePathToRoutes(relPath, defaultLocale);
    if (routes.length === 0) continue;

    const html = fs.readFileSync(htmlFile, 'utf8');
    const hashes = extractInlineScriptHashes(html);
    for (const route of routes) {
      const existing = routeMap.get(route) ?? [];
      const merged = [...new Set([...existing, ...hashes])];
      routeMap.set(route, merged);
    }
  }

  const sortedRoutes = {};
  for (const route of [...routeMap.keys()].sort()) {
    sortedRoutes[route] = routeMap.get(route);
  }

  const cspManifest = {
    version: 1,
    routes: sortedRoutes,
  };

  const chunkFiles = walkFiles(
    staticDir,
    (file) => file.endsWith('.js') || file.endsWith('.wasm'),
  );
  const chunks = {};
  for (const chunkFile of chunkFiles) {
    const relStatic = path.relative(staticDir, chunkFile).split(path.sep).join('/');
    const publicChunkPath = `/_next/static/${relStatic}`;
    const bytes = fs.readFileSync(chunkFile);
    const hex = createHash('sha256').update(bytes).digest('hex');
    chunks[publicChunkPath] = `sha256-${hex}`;
  }

  let buildId = null;
  const buildIdPath = path.join(nextDir, 'BUILD_ID');
  if (fs.existsSync(buildIdPath)) {
    buildId = fs.readFileSync(buildIdPath, 'utf8').trim() || null;
  }

  const buildManifest = {
    version: 1,
    build_id: buildId,
    chunks,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const cspManifestPath = path.join(outDir, 'csp-hashes.json');
  const buildManifestPath = path.join(outDir, 'build-manifest.json');
  fs.writeFileSync(cspManifestPath, `${JSON.stringify(cspManifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(buildManifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`, 'utf8');

  return {
    cspManifest,
    buildManifest,
    cspManifestPath,
    buildManifestPath,
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { cspManifest, buildManifest, cspManifestPath, buildManifestPath } =
    generateCspAndBuildManifests();
  const routeCount = Object.keys(cspManifest.routes).length;
  const chunkCount = Object.keys(buildManifest.chunks).length;
  if (routeCount === 0) {
    console.error('[postbuild-csp-manifest] No prerendered marketing HTML routes found in .next/server/app');
    process.exit(1);
  }
  if (chunkCount === 0) {
    console.error('[postbuild-csp-manifest] No JS/WASM chunks found in .next/static');
    process.exit(1);
  }
  console.log(
    `[postbuild-csp-manifest] Wrote ${routeCount} route(s) to ${path.relative(process.cwd(), cspManifestPath)} and ${chunkCount} chunk(s) to ${path.relative(process.cwd(), buildManifestPath)}`,
  );
}
