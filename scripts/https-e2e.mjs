// Acceptance harness for the P02 transport suite (docs/phases/evidence/P02.md).
// Cookie Secure/SameSite, HSTS-adjacent headers and logout cleanup can only be
// observed over TLS, so this brings up a second stack behind
// scripts/https-e2e-proxy.mjs instead of reusing the plain-HTTP ports of
// scripts/e2e.mjs. Ports are disjoint from that harness so both can be run in
// sequence without either one adopting the other's leftovers.
import { existsSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPortAvailable,
  parseEnvFile,
  runOnce,
  spawnCommand,
  terminate,
  waitFor,
} from './e2e.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(ROOT, 'apps', 'api');
const MAIL_SINK = resolve(ROOT, '.data', 'mail-sink');
const CERT_DIR = resolve(ROOT, '.data', 'certs');

const WEB_PORT = 13000;
const API_PORT = 18081;
const TLS_PORT = 13443;
const BASE_URL = `https://127.0.0.1:${TLS_PORT}`;
const API_UPSTREAM = `http://127.0.0.1:${API_PORT}`;
const WEB_UPSTREAM = `http://127.0.0.1:${WEB_PORT}`;

/** The proxy serves a self-signed local certificate, so the readiness probe must not verify it. */
function waitForTls(url, { retries = 60, delayMs = 1000, child } = {}) {
  const target = new URL(url);
  return new Promise((resolveReady, rejectReady) => {
    let attempt = 0;
    const tick = () => {
      attempt += 1;
      if (child?.exitCode !== null && child?.exitCode !== undefined) {
        rejectReady(new Error(`TLS proxy exited (${child.exitCode}) before becoming ready`));
        return;
      }
      const req = httpsRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'GET',
          rejectUnauthorized: false,
          timeout: 3000,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolveReady();
            return;
          }
          retry(`status ${res.statusCode}`);
        },
      );
      req.once('error', (error) => retry(error.message));
      req.once('timeout', () => {
        req.destroy();
        retry('timeout');
      });
      req.end();
    };
    const retry = (reason) => {
      if (attempt >= retries) {
        rejectReady(new Error(`TLS proxy not ready after ${retries} attempts: ${reason}`));
        return;
      }
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes('--skip-build');
  const certFile = process.env.TLS_CERT_FILE ?? resolve(CERT_DIR, 'local-cert.pem');
  const keyFile = process.env.TLS_KEY_FILE ?? resolve(CERT_DIR, 'local-key.pem');
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    console.error(
      `missing local test certificate: expected ${certFile} and ${keyFile}.\n` +
        'Generate a throwaway pair under .data/certs (gitignored); never commit a private key.',
    );
    return 1;
  }
  mkdirSync(MAIL_SINK, { recursive: true });

  const env = {
    ...parseEnvFile(resolve(ROOT, '.env')),
    ...process.env,
    APP_ENV: process.env.APP_ENV && process.env.APP_ENV !== 'production' ? process.env.APP_ENV : 'development',
    APP_ORIGIN: BASE_URL,
    HTTP_ADDR: `127.0.0.1:${API_PORT}`,
    API_UPSTREAM,
    AUTH_FAKE_OAUTH: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    AUTH_MAIL_SINK_DIR: MAIL_SINK,
    E2E_STACK: '1',
    E2E_VERIFY: 'false',
    BASE_URL,
    E2E_API_URL: API_UPSTREAM,
    MAIL_SINK_DIR: MAIL_SINK,
    TLS_CERT_FILE: certFile,
    TLS_KEY_FILE: keyFile,
    TLS_PROXY_PORT: String(TLS_PORT),
    HTTPS_TEST_WEB_UPSTREAM: WEB_UPSTREAM,
    HTTPS_TEST_API_UPSTREAM: API_UPSTREAM,
  };

  const children = [];
  let cleanupPromise;
  const stopAll = () => {
    if (cleanupPromise) return cleanupPromise;
    const owned = children.splice(0);
    cleanupPromise = Promise.all(owned.map((child) => terminate(child)))
      .then(() => undefined)
      .finally(() => {
        cleanupPromise = undefined;
      });
    return cleanupPromise;
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  try {
    for (const port of [API_PORT, WEB_PORT, TLS_PORT]) {
      await assertPortAvailable(port);
    }

    const db = await runOnce('docker', [
      'compose',
      '--env-file',
      'infra/image-pins.env',
      '-f',
      'infra/docker-compose.yml',
      'up',
      '-d',
      '--wait',
      'db',
    ]);
    if (db !== 0) return db;
    const migrate = await runOnce('go', ['run', './cmd/migrate', 'up'], { cwd: API_DIR, env });
    if (migrate !== 0) return migrate;
    if (!skipBuild) {
      const build = await runOnce('pnpm', ['--filter', '@engram/web', 'build'], { env });
      if (build !== 0) return build;
    }

    console.log(`\n=== P02 HTTPS transport (${BASE_URL}) ===`);
    const api = spawnCommand('go', ['run', './cmd/api'], { cwd: API_DIR, env, detached: true });
    const worker = spawnCommand('go', ['run', './cmd/worker'], { cwd: API_DIR, env, detached: true });
    const web = spawnCommand(
      'pnpm',
      ['--filter', '@engram/web', 'exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', String(WEB_PORT)],
      { env, detached: true },
    );
    const proxy = spawnCommand('node', ['scripts/https-e2e-proxy.mjs'], { env, detached: true });
    children.push(api, worker, web, proxy);

    await waitFor(`${API_UPSTREAM}/api/v1/healthz`, { label: 'API healthz', child: api });
    await waitFor(`${WEB_UPSTREAM}/api/v1/healthz`, { label: 'web proxy healthz', retries: 180, child: web });
    await waitForTls(`${BASE_URL}/api/v1/healthz`, { child: proxy });
    if (worker.exitCode !== null) {
      throw new Error(`worker process exited (${worker.exitCode}) before Playwright started`);
    }

    const code = await runOnce(
      'pnpm',
      ['--filter', '@engram/web', 'exec', 'playwright', 'test', '--config=playwright.transport.config.ts'],
      { env },
    );
    console.log(`playwright transport exit ${code}`);
    return code;
  } catch (error) {
    console.error(error.message);
    return 1;
  } finally {
    await stopAll();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
