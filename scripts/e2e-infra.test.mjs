import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
