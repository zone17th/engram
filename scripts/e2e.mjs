import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(ROOT, 'apps', 'api');
const MAIL_SINK = resolve(ROOT, '.data', 'mail-sink');
const BASE_URL = 'http://127.0.0.1:3000';
const API_HEALTH = 'http://127.0.0.1:8080/api/v1/healthz';

export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function pnpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'pnpm', args };
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ].filter((path) => path && /\.(?:c?js)$/i.test(path) && existsSync(path));
  if (candidates.length > 0) {
    return { command: process.execPath, args: [candidates[0], ...args] };
  }
  try {
    const pnpmCmd = execFileSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((path) => path.trim())
      .find((path) => path);
    if (pnpmCmd) {
      const pnpmRoot = resolve(dirname(pnpmCmd), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
      if (existsSync(pnpmRoot)) return { command: process.execPath, args: [pnpmRoot, ...args] };
    }
  } catch {
    // cmd shim
  }
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', ['pnpm', ...args].map(quote).join(' ')] };
}

export function spawnCommand(command, args, options = {}) {
  const invocation = command === 'pnpm' ? pnpmInvocation(args) : { command, args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    detached: options.detached ?? false,
    windowsHide: true,
  });
  child.once('error', (error) => {
    child.spawnError = error;
  });
  return child;
}

/** Bind and release the exact loopback address before spawning an owned server. */
export function assertPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen({ host, port }, () => {
      probe.close((error) => (error ? rejectPort(error) : resolvePort()));
    });
  }).catch((error) => {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(`required ${host}:${port} is already in use; stop that service before running e2e`);
    }
    throw new Error(`could not probe ${host}:${port}: ${error.message}`);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('error', () => finish(true));
    child.once('exit', () => finish(true));
  });
}

/** Terminate only a process this script spawned, including its own child tree. */
export async function terminate(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill is scoped to this child PID; port preflight never kills an existing PID.
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  if (await waitForExit(child, 5_000)) return;
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
  await waitForExit(child, 5_000);
}

export function runOnce(command, args, options = {}) {
  return new Promise((resolveExit) => {
    let child;
    try {
      child = spawnCommand(command, args, options);
    } catch (error) {
      console.error(`Failed to start ${command}: ${error.message}`);
      resolveExit(1);
      return;
    }
    child.once('error', (error) => {
      console.error(`Failed to start ${command}: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

export async function waitFor(url, { retries = 60, delayMs = 1000, label = url, child } = {}) {
  let last = 'not attempted';
  for (let i = 1; i <= retries; i += 1) {
    if (child?.spawnError) {
      throw new Error(`${label} process failed to start: ${child.spawnError.message}`);
    }
    if (child && child.exitCode !== null) {
      throw new Error(`${label} process exited (${child.exitCode}) before becoming ready`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`${label} not ready after ${retries} attempts: ${last}`);
}

function parseVerifyArg(argv) {
  const raw = argv.find((arg) => arg.startsWith('--verify='))?.slice('--verify='.length) ?? 'both';
  if (raw === 'both') return ['false', 'true'];
  if (raw === 'false' || raw === 'true') return [raw];
  throw new Error(`--verify must be false, true, or both (got ${raw})`);
}

/** Playwright title regex: `--grep=PATTERN` or `--grep PATTERN`. */
function parseGrepArg(argv) {
  const eq = argv.find((arg) => arg.startsWith('--grep='));
  if (eq) return eq.slice('--grep='.length);
  const idx = argv.indexOf('--grep');
  if (idx === -1) return '';
  const next = argv[idx + 1];
  if (!next || next.startsWith('-')) {
    throw new Error('--grep requires a Playwright title pattern');
  }
  return next;
}

const composeBaseArgs = [
  'compose',
  '--env-file',
  'infra/image-pins.env',
  '-f',
  'infra/docker-compose.yml',
];

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseVerifyArg(argv);
  const grep = parseGrepArg(argv);
  const skipStack = argv.includes('--skip-stack');
  mkdirSync(MAIL_SINK, { recursive: true });

  const baseEnv = {
    ...parseEnvFile(resolve(ROOT, '.env')),
    ...process.env,
    APP_ENV: process.env.APP_ENV && process.env.APP_ENV !== 'production' ? process.env.APP_ENV : 'development',
    APP_ORIGIN: BASE_URL,
    AUTH_FAKE_OAUTH: 'true',
    AUTH_MAIL_SINK_DIR: MAIL_SINK,
    E2E_STACK: '1',
    BASE_URL,
    MAIL_SINK_DIR: MAIL_SINK,
  };

  const children = [];
  let cleanupPromise;
  const stopAll = () => {
    if (cleanupPromise) return cleanupPromise;
    const ownedChildren = children.splice(0);
    cleanupPromise = Promise.all(ownedChildren.map((child) => terminate(child)))
      .then(() => undefined)
      .finally(() => {
        cleanupPromise = undefined;
      });
    return cleanupPromise;
  };
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);

  try {
    if (!skipStack) {
      await assertPortAvailable(8080);
      await assertPortAvailable(3000);
      const db = await runOnce('docker', [...composeBaseArgs, 'up', '-d', '--wait', 'db']);
      if (db !== 0) return db;
      const migrate = await runOnce('go', ['run', './cmd/migrate', 'up'], { cwd: API_DIR, env: baseEnv });
      if (migrate !== 0) return migrate;
      const build = await runOnce('pnpm', ['--filter', '@engram/web', 'build'], { env: baseEnv });
      if (build !== 0) return build;
    }

    let failed = 0;
    for (const verify of flags) {
      console.log(`\n=== P02 e2e AUTH_REQUIRE_EMAIL_VERIFICATION=${verify} ===`);
      if (grep) console.log(`playwright --grep ${grep}`);
      const env = {
        ...baseEnv,
        AUTH_REQUIRE_EMAIL_VERIFICATION: verify,
        E2E_VERIFY: verify,
      };
      try {
        if (!skipStack) {
          await assertPortAvailable(8080);
          await assertPortAvailable(3000);
          const api = spawnCommand('go', ['run', './cmd/api'], { cwd: API_DIR, env, detached: true });
          const worker = spawnCommand('go', ['run', './cmd/worker'], { cwd: API_DIR, env, detached: true });
          const web = spawnCommand(
            'pnpm',
            ['--filter', '@engram/web', 'exec', 'next', 'start', '--hostname', '127.0.0.1', '--port', '3000'],
            { env, detached: true },
          );
          children.push(api, worker, web);
          await waitFor(API_HEALTH, { label: 'API healthz', child: api });
          await waitFor(`${BASE_URL}/api/v1/healthz`, { label: 'web proxy healthz', retries: 180, child: web });
          if (worker.exitCode !== null) {
            throw new Error(`worker process exited (${worker.exitCode}) before Playwright started`);
          }
        }

        const playwrightArgs = [
          '--filter',
          '@engram/web',
          'exec',
          'playwright',
          'test',
          'e2e/auth.spec.ts',
          'e2e/account.spec.ts',
          'e2e/oauth.spec.ts',
          'e2e/a11y.spec.ts',
        ];
        if (grep) playwrightArgs.push('--grep', grep);
        const code = await runOnce('pnpm', playwrightArgs, { env });
        console.log(`playwright verify=${verify} exit ${code}`);
        if (code !== 0) failed = code;
      } finally {
        if (!skipStack) await stopAll();
      }
    }
    return failed;
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
