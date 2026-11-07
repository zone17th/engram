import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CSP_NONCE_HEADER = 'x-nonce';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';
export const PERMISSIONS_POLICY_HEADER_VALUE =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)';

const SHA256_TOKEN_RE = /^'sha256-[A-Za-z0-9+/]+={0,2}'$/;

export type CspHashManifest = {
  version: number;
  routes: Record<string, string[]>;
};

let cachedManifest: CspHashManifest | null | undefined;
let manifestErrorLogged = false;
let missingRouteErrorLogged = false;

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

function logMissingRouteOnce(route: string): void {
  if (missingRouteErrorLogged) return;
  missingRouteErrorLogged = true;
  console.error(`[csp] Missing CSP hash entry for route "${route}"; falling back to fail-closed script-src 'self'.`);
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
  if (!hashes || hashes.length === 0) {
    logMissingRouteOnce(normalized);
    return [];
  }
  return hashes;
}

export function resetCspManifestCacheForTests(): void {
  cachedManifest = undefined;
  manifestErrorLogged = false;
  missingRouteErrorLogged = false;
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
