import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { routing } from '../../i18n/routing';

export const CSP_NONCE_HEADER = 'x-nonce';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';
export const PERMISSIONS_POLICY_HEADER_VALUE =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)';
export const STATIC_DOTTED_PATH_SOURCE = '/:path((?!api|_next|_vercel).*\\..*)';
export const STATIC_DOTTED_CSP_HEADER_VALUE =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

const SHA256_TOKEN_RE = /^'sha256-[A-Za-z0-9+/]+={0,2}'$/;

/**
 * Manifest key for the hashes of Next's static not-found shell. Used for every
 * non-/app path without its own entry (404s) so the 404 page can hydrate.
 * Written by `scripts/postbuild-csp-manifest.mjs` (keep the two in sync).
 */
export const NOT_FOUND_ROUTE_KEY = '/__not_found__';

// Prerendered marketing pages (locale prefix stripped); `/docs` ships with P06 Task 7.
const EXPECTED_SSG_ROUTES: Readonly<Record<string, true>> = {
  '/': true,
  '/privacy': true,
  '/terms': true,
  '/docs': true,
};
const UNKNOWN_ROUTE_WARN_INTERVAL_MS = 60_000;

export type CspHashManifest = {
  version: number;
  routes: Record<string, string[]>;
};

let cachedManifest: CspHashManifest | null | undefined;
let manifestErrorLogged = false;
const missingSsgRoutesLogged = new Set<string>();
let lastUnknownRouteWarnAt = 0;

export function generateCspNonce(): string {
  return randomBytes(16).toString('base64');
}

export function normalizeCspPathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
}

export function isAppRoute(pathname: string): boolean {
  const normalized = normalizeCspPathname(pathname);
  return normalized === '/app' || normalized.startsWith('/app/');
}

export function isResetPasswordRoute(pathname: string): boolean {
  return normalizeCspPathname(pathname) === '/app/auth/reset-password';
}

export function isTurnstileAuthRoute(pathname: string): boolean {
  const normalized = normalizeCspPathname(pathname);
  if (isResetPasswordRoute(normalized)) return false;
  return normalized === '/app/auth' || normalized.startsWith('/app/auth/');
}

function validateManifest(raw: unknown): CspHashManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { version?: unknown; routes?: unknown };
  if (!obj.routes || typeof obj.routes !== 'object' || Array.isArray(obj.routes)) {
    return null;
  }
  const routes: Record<string, string[]> = {};
  for (const [routeKey, value] of Object.entries(obj.routes as Record<string, unknown>)) {
    if (!Array.isArray(value)) return null;
    const validHashes: string[] = [];
    for (const token of value) {
      if (typeof token !== 'string' || !SHA256_TOKEN_RE.test(token)) {
        return null;
      }
      validHashes.push(token);
    }
    routes[normalizeCspPathname(routeKey)] = validHashes;
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    routes,
  };
}

function logManifestErrorOnce(message: string): void {
  if (manifestErrorLogged) return;
  manifestErrorLogged = true;
  console.error(message);
}

function stripLocalePrefix(normalizedPathname: string): string {
  for (const locale of routing.locales) {
    const prefix = `/${locale}`;
    if (normalizedPathname === prefix) return '/';
    if (normalizedPathname.startsWith(`${prefix}/`)) return normalizedPathname.slice(prefix.length);
  }
  return normalizedPathname;
}

/** Marketing routes that are prerendered at build time and must exist in the manifest. */
export function isExpectedSsgRoute(pathname: string): boolean {
  return Object.hasOwn(EXPECTED_SSG_ROUTES, stripLocalePrefix(normalizeCspPathname(pathname)));
}

/**
 * A missing *expected* SSG route is a build defect: logged once per distinct route
 * (bounded by `EXPECTED_SSG_ROUTES` x locales). Any other missing route is a plain
 * 404/scanner hit: at most one warning per `UNKNOWN_ROUTE_WARN_INTERVAL_MS`, so a
 * scanner cannot suppress the SSG log nor flood the console.
 */
function logMissingRoute(route: string): void {
  if (isExpectedSsgRoute(route)) {
    if (missingSsgRoutesLogged.has(route)) return;
    missingSsgRoutesLogged.add(route);
    console.error(
      `[csp] Missing CSP hash entry for expected SSG route "${route}"; falling back to fail-closed script-src 'self'.`,
    );
    return;
  }
  const now = Date.now();
  if (now - lastUnknownRouteWarnAt < UNKNOWN_ROUTE_WARN_INTERVAL_MS) return;
  lastUnknownRouteWarnAt = now;
  console.warn(`[csp] No CSP hash entry for route "${route}" (not an SSG route); serving the not-found shell CSP.`);
}

/**
 * Reads `public/.well-known/csp-hashes.json` from disk once per process and caches
 * it in module-global memory (N-10: no network hop through origin/nginx).
 */
export function loadCspHashManifest(cwd: string = process.cwd()): CspHashManifest | null {
  if (cachedManifest !== undefined) {
    return cachedManifest;
  }
  const manifestPath = path.join(cwd, 'public/.well-known/csp-hashes.json');
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = validateManifest(JSON.parse(content));
    if (!parsed) {
      cachedManifest = null;
      logManifestErrorOnce(
        `[csp] Invalid CSP hash manifest schema at ${manifestPath}; falling back to fail-closed script-src 'self'.`,
      );
      return null;
    }
    cachedManifest = parsed;
    return cachedManifest;
  } catch (error) {
    cachedManifest = null;
    const reason = error instanceof Error ? error.message : String(error);
    logManifestErrorOnce(
      `[csp] Failed to read CSP hash manifest at ${manifestPath} (${reason}); falling back to fail-closed script-src 'self'.`,
    );
    return null;
  }
}

export function getRouteScriptHashes(pathname: string, cwd: string = process.cwd()): string[] {
  const manifest = loadCspHashManifest(cwd);
  if (!manifest) return [];
  const normalized = normalizeCspPathname(pathname);
  const hashes = manifest.routes[normalized];
  if (hashes && hashes.length > 0) return hashes;

  logMissingRoute(normalized);
  // Expected SSG route: fail closed. Anything else is answered by Next's static
  // not-found shell, so it gets that shell's hashes and can hydrate.
  if (isExpectedSsgRoute(normalized)) return [];
  return manifest.routes[NOT_FOUND_ROUTE_KEY] ?? [];
}

export function resetCspManifestCacheForTests(): void {
  cachedManifest = undefined;
  manifestErrorLogged = false;
  missingSsgRoutesLogged.clear();
  lastUnknownRouteWarnAt = 0;
}

export function buildAppNonceCsp(options: {
  nonce: string;
  allowTurnstile?: boolean;
  isDev?: boolean;
}): string {
  const { nonce, allowTurnstile = false, isDev = false } = options;
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'wasm-unsafe-eval'"];
  if (isDev) {
    scriptSources.push("'unsafe-eval'");
  }
  if (allowTurnstile) {
    scriptSources.push(TURNSTILE_ORIGIN);
  }

  const connectSources = ["'self'"];
  if (allowTurnstile) {
    connectSources.push(TURNSTILE_ORIGIN);
  }
  if (isDev) {
    connectSources.push('ws:', 'wss:');
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
  ];
  if (allowTurnstile) {
    directives.push(`frame-src ${TURNSTILE_ORIGIN}`);
  }
  directives.push(
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  );
  return directives.join('; ');
}

export function buildMarketingHashCsp(options: {
  hashes: readonly string[];
  isDev?: boolean;
}): string {
  const { hashes, isDev = false } = options;
  const validHashes = hashes.filter((h) => SHA256_TOKEN_RE.test(h));
  const scriptSources = ["'self'", ...validHashes];
  if (isDev) {
    scriptSources.push("'unsafe-inline'", "'unsafe-eval'");
  }

  const connectSources = ["'self'"];
  if (isDev) {
    connectSources.push('ws:', 'wss:');
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "worker-src 'self' blob:",
  ].join('; ');
}

export function buildCspForPathname(
  pathname: string,
  options: {
    nonce?: string;
    isDev?: boolean;
    cwd?: string;
  } = {},
): { csp: string; nonce?: string } {
  const isDev = options.isDev ?? process.env.NODE_ENV === 'development';
  const normalized = normalizeCspPathname(pathname);
  if (isAppRoute(normalized)) {
    const nonce = options.nonce ?? generateCspNonce();
    return {
      nonce,
      csp: buildAppNonceCsp({
        nonce,
        allowTurnstile: isTurnstileAuthRoute(normalized),
        isDev,
      }),
    };
  }
  const hashes = isDev ? [] : getRouteScriptHashes(normalized, options.cwd);
  return {
    csp: buildMarketingHashCsp({
      hashes,
      isDev,
    }),
  };
}
