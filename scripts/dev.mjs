import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = resolve(ROOT, 'apps', 'api');

function parseEnvFile(path) {
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
    } else {
      const comment = value.search(/\s+#/);
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    values[match[1]] = value;
  }
  return values;
}

// .env supplies defaults; variables already exported by the caller win.
const env = {
  ...parseEnvFile(resolve(ROOT, '.env')),
  ...process.env,
};

function pnpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'pnpm', args };

  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ].filter((path) => path && /\.(?:c?js)$/i.test(path) && existsSync(path));

  if (candidates.length > 0) {
    return { command: process.execPath, args: [candidates[0], ...args] };
  }

  // A global pnpm install may be outside the Node installation directory.
  try {
    const pnpmCmd = execFileSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((path) => path.trim())
      .find((path) => path);
    if (pnpmCmd) {
      const pnpmRoot = resolve(dirname(pnpmCmd), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
      if (existsSync(pnpmRoot)) {
        return { command: process.execPath, args: [pnpmRoot, ...args] };
      }
    }
  } catch {
    // Fall through to cmd.exe, which can execute a .cmd shim.
  }

  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', ['pnpm', ...args].map(quote).join(' ')],
  };
}

function spawnCommand(command, args, options = {}) {
  const invocation = command === 'pnpm' ? pnpmInvocation(args) : { command, args };
  return spawn(invocation.command, invocation.args, {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: 'inherit',
    detached: options.detached ?? false,
  });
}

const composeBaseArgs = [
  'compose',
  '--env-file',
  'infra/image-pins.env',
  '-f',
  'infra/docker-compose.yml',
];

function runOnce(command, args, options = {}) {
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

function terminate(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.killed) return;

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function runServices() {
  const specs = [
    { command: 'go', args: ['run', './cmd/api'], cwd: API_DIR },
    { command: 'go', args: ['run', './cmd/worker'], cwd: API_DIR },
    { command: 'pnpm', args: ['--filter', '@engram/web', 'dev'], cwd: ROOT },
  ];
  const children = [];
  let interrupted = false;
  let stopping = false;

  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) terminate(child);
  };

  const onSignal = () => {
    interrupted = true;
    stopAll();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const exits = specs.map((spec) => new Promise((resolveExit) => {
    let child;
    try {
      child = spawnCommand(spec.command, spec.args, { cwd: spec.cwd, detached: true });
    } catch (error) {
      console.error(`Failed to start ${spec.command}: ${error.message}`);
      resolveExit(1);
      return;
    }
    children.push(child);
    if (stopping) terminate(child);
    child.once('error', (error) => {
      console.error(`Failed to start ${spec.command}: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (code) => resolveExit(code ?? 1));
  }));

  const first = await Promise.race(exits.map((exit) => exit.then((code) => ({ code }))));
  if (!interrupted && first.code !== 0) {
    console.error(`Development process stopped with exit code ${first.code}`);
  }
  stopAll();
  await Promise.all(exits);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  return interrupted ? 0 : first.code;
}

async function main() {
  const mode = process.argv[2] ?? 'stack';

  if (mode === 'migrate') {
    return runOnce('go', ['run', './cmd/migrate', 'up'], { cwd: API_DIR });
  }
  if (mode === 'api') {
    return runOnce('go', ['run', './cmd/api'], { cwd: API_DIR });
  }
  if (mode === 'worker') {
    return runOnce('go', ['run', './cmd/worker'], { cwd: API_DIR });
  }
  if (mode === 'web') {
    return runOnce('pnpm', ['--filter', '@engram/web', 'dev']);
  }
  if (mode === 'compose-up') {
    return runOnce('docker', [...composeBaseArgs, 'up', '-d', '--build']);
  }
  if (mode === 'compose-down') {
    return runOnce('docker', [...composeBaseArgs, 'down']);
  }
  if (mode !== 'stack') {
    console.error(`Unknown mode: ${mode}. Use stack, migrate, api, worker, web, compose-up, or compose-down.`);
    return 2;
  }

  const composeExit = await runOnce('docker', [
    ...composeBaseArgs,
    'up',
    '-d',
    '--wait',
    'db',
  ]);
  if (composeExit !== 0) return composeExit;

  const migrateExit = await runOnce('go', ['run', './cmd/migrate', 'up'], { cwd: API_DIR });
  if (migrateExit !== 0) return migrateExit;

  return runServices();
}

process.exitCode = await main();
