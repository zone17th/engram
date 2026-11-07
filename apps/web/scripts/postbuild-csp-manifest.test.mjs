import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  extractInlineScriptHashes,
  generateCspAndBuildManifests,
  htmlRelativePathToRoutes,
} from './postbuild-csp-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_TMP_BASE = 'D:/my-project/.engram-dev/p06-beta/reports/ops-edge';

function makeTempDir() {
  const base = fs.existsSync(RUN_TMP_BASE) ? RUN_TMP_BASE : path.resolve(__dirname, '..');
  return fs.mkdtempSync(path.join(base, '.tmp-csp-manifest-test-'));
}

test('extractInlineScriptHashes computes exact sha256-<base64> for inline executable scripts and ignores external/JSON scripts', () => {
  const s1 = '(self.__next_f=self.__next_f||[]).push([0])';
  const s2 = 'self.__next_f.push([1,"0:{\\"b\\":\\"build-1\\"}\\n"])';
  const html = [
    '<!DOCTYPE html><html><head>',
    '<script src="/_next/static/chunks/main.js" async=""></script>',
    `<script>${s1}</script>`,
    '<script type="application/json">{"ignored":true}</script>',
    '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
    `<script id="_R_">${s2}</script>`,
    `<script>${s1}</script>`, // duplicate should be deduplicated
    '<script></script>',
    '</head><body></body></html>',
  ].join('');

  const expected1 = `'sha256-${createHash('sha256').update(s1, 'utf8').digest('base64')}'`;
  const expected2 = `'sha256-${createHash('sha256').update(s2, 'utf8').digest('base64')}'`;

  const hashes = extractInlineScriptHashes(html);
  assert.deepEqual(hashes, [expected1, expected2]);
});

test('htmlRelativePathToRoutes maps default locale en and prefixed locale vi routes while skipping internal/app routes', () => {
  assert.deepEqual(htmlRelativePathToRoutes('en.html'), ['/', '/en']);
  assert.deepEqual(htmlRelativePathToRoutes('vi.html'), ['/vi']);
  assert.deepEqual(htmlRelativePathToRoutes('en/privacy.html'), ['/en/privacy', '/privacy']);
  assert.deepEqual(htmlRelativePathToRoutes('vi/privacy.html'), ['/vi/privacy']);
  assert.deepEqual(htmlRelativePathToRoutes('(marketing)/en/docs.html'), ['/docs', '/en/docs']);
  assert.deepEqual(htmlRelativePathToRoutes('_not-found.html'), []);
  assert.deepEqual(htmlRelativePathToRoutes('app/settings.html'), []);
});

test('generateCspAndBuildManifests writes csp-hashes.json and build-manifest.json with JS and WASM chunk SHA256 digests', () => {
  const tmpDir = makeTempDir();
  try {
    const nextDir = path.join(tmpDir, '.next');
    const serverAppDir = path.join(nextDir, 'server', 'app');
    const staticChunksDir = path.join(nextDir, 'static', 'chunks');
    const outDir = path.join(tmpDir, 'public', '.well-known');

    fs.mkdirSync(path.join(serverAppDir, 'vi'), { recursive: true });
    fs.mkdirSync(staticChunksDir, { recursive: true });
    fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'test-build-id-001\n', 'utf8');

    const enInline = 'self.__next_f.push([1,"en-landing"])';
    const viPrivacyInline = 'self.__next_f.push([1,"vi-privacy"])';
    fs.writeFileSync(
      path.join(serverAppDir, 'en.html'),
      `<html><body><script src="/_next/static/chunks/app.js"></script><script>${enInline}</script></body></html>`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(serverAppDir, 'vi', 'privacy.html'),
      `<html><body><script>${viPrivacyInline}</script></body></html>`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(serverAppDir, '_not-found.html'),
      '<html><body><script>self.__next_f.push([1,"404"])</script></body></html>',
      'utf8',
    );

    const jsBytes = Buffer.from('console.log("chunk");', 'utf8');
    const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    fs.writeFileSync(path.join(staticChunksDir, 'app-123.js'), jsBytes);
    fs.writeFileSync(path.join(staticChunksDir, 'sodium-456.wasm'), wasmBytes);
    fs.writeFileSync(path.join(staticChunksDir, 'styles-789.css'), 'body{}', 'utf8');

    const { cspManifest, buildManifest, cspManifestPath, buildManifestPath } =
      generateCspAndBuildManifests({
        webRoot: tmpDir,
        nextDir,
        outDir,
      });

    assert.equal(fs.existsSync(cspManifestPath), true);
    assert.equal(fs.existsSync(buildManifestPath), true);

    const expectedEnHash = `'sha256-${createHash('sha256').update(enInline, 'utf8').digest('base64')}'`;
    const expectedViHash = `'sha256-${createHash('sha256').update(viPrivacyInline, 'utf8').digest('base64')}'`;

    assert.deepEqual(cspManifest.routes['/'], [expectedEnHash]);
    assert.deepEqual(cspManifest.routes['/en'], [expectedEnHash]);
    assert.deepEqual(cspManifest.routes['/vi/privacy'], [expectedViHash]);
    assert.equal(cspManifest.routes['/_not-found'], undefined);

    const expectedJsDigest = `sha256-${createHash('sha256').update(jsBytes).digest('hex')}`;
    const expectedWasmDigest = `sha256-${createHash('sha256').update(wasmBytes).digest('hex')}`;

    assert.equal(buildManifest.build_id, 'test-build-id-001');
    assert.deepEqual(buildManifest.chunks, {
      '/_next/static/chunks/app-123.js': expectedJsDigest,
      '/_next/static/chunks/sodium-456.wasm': expectedWasmDigest,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
