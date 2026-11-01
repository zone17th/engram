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

function globToRegExp(glob) {
  return ExpandSingleGlobToRegExp(glob);
}

function ExpandSingleGlobToRegExp(glob) {
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
      regexes.push(globToRegExp(expanded));
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

function parseDefaultPlaywrightProjects(configSource) {
  const projects = [];
  // Strip conditional spread blocks `...(process.env.E2E_... ? [ ... ] : [])` which require opt-in env vars.
  const defaultConfigSource = configSource.replace(/\.\.\.\(process\.env\.[A-Z0-9_]+[\s\S]*?:\s*\[\]\),?/g, '');
  const projectRegex = /\{\s*name:\s*'([^']+)'[\s\S]*?testMatch:\s*(\/(?:\\\/|[^/\r\n])+\/[gimsuy]*)/g;
  for (const match of defaultConfigSource.matchAll(projectRegex)) {
    const [, name, regexLiteral] = match;
    const lastSlash = regexLiteral.lastIndexOf('/');
    const pattern = regexLiteral.slice(1, lastSlash);
    const flags = regexLiteral.slice(lastSlash + 1);
    projects.push({ name, testMatch: new RegExp(pattern, flags) });
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

test('Content e2e CI job, Browser project filter, and NEXT_PUBLIC_CONTENT_ENABLED defaults stay aligned', () => {
  const dockerfile = readFileSync(join(ROOT, 'apps', 'web', 'Dockerfile'), 'utf8');
  const compose = readFileSync(join(ROOT, 'infra', 'docker-compose.yml'), 'utf8');
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  // (c) default false in Dockerfile and docker-compose.yml
  assert.match(dockerfile, /^ARG NEXT_PUBLIC_CONTENT_ENABLED=false$/m);
  assert.match(dockerfile, /^ENV NEXT_PUBLIC_CONTENT_ENABLED=\$\{NEXT_PUBLIC_CONTENT_ENABLED\}$/m);
  assert.match(compose, /NEXT_PUBLIC_CONTENT_ENABLED:\s*\$\{NEXT_PUBLIC_CONTENT_ENABLED:-false\}/);

  // (b) Content e2e job exists, both it and Browser job build with NEXT_PUBLIC_CONTENT_ENABLED=true,
  // and Browser job has --project without content.
  const browserJobMatch = workflow.match(/  e2e-browser:\r?\n([\s\S]*?)(?=\r?\n  [a-z0-9-]+:|$)/);
  assert.ok(browserJobMatch, 'missing e2e-browser job in ci.yml');
  const browserJob = browserJobMatch[1];
  assert.match(browserJob, /NEXT_PUBLIC_CONTENT_ENABLED:\s*'true'/);

  const browserPlaywrightLines = browserJob
    .split(/\r?\n/)
    .filter((line) => line.includes('playwright test') && !line.includes('vault-prod'));
  assert.equal(browserPlaywrightLines.length, 1, 'expected one main playwright test command in e2e-browser');
  const browserCmd = browserPlaywrightLines[0];
  assert.match(browserCmd, /--project(?:=|\s+)auth\b/);
  assert.match(browserCmd, /--project(?:=|\s+)mobile-390\b/);
  assert.match(browserCmd, /--project(?:=|\s+)tablet-768\b/);
  assert.match(browserCmd, /--project(?:=|\s+)desktop-1440\b/);
  assert.match(browserCmd, /--project(?:=|\s+)vault\b/);
  assert.doesNotMatch(browserCmd, /--project(?:=|\s+)content\b/);

  const contentJobMatch = workflow.match(
    /  [a-z0-9-]+:\r?\n    name:\s*Content e2e \(email verification required\)\r?\n([\s\S]*?)(?=\r?\n  [a-z0-9-]+:|$)/,
  );
  assert.ok(contentJobMatch, 'missing "Content e2e (email verification required)" job in ci.yml');
  const contentJob = contentJobMatch[1];
  assert.match(contentJob, /timeout-minutes:\s*30\b/);
  assert.match(contentJob, /NEXT_PUBLIC_CONTENT_ENABLED:\s*'true'/);
  assert.match(contentJob, /AUTH_FAKE_OAUTH:\s*'false'/);
  assert.match(contentJob, /playwright test[^\r\n]*--project(?:=|\s+)content\b/);
  assert.match(contentJob, /sanitize-e2e-artifacts\.mjs/);
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
