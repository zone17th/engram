#!/usr/bin/env node
// Generate apps/web/app/{icon.svg,apple-icon.png,favicon.ico} from the engram logo mark.
// Verifies literal token values against mockups/tokens.css:
//   --logo-ink: #202020
//   --logo-magenta: #FA12E3
//   --logo-cyan: #12D0FA
// Uses sharp from Next.js transitive dependency in pnpm-lock.yaml and writes the ICO
// container header + PNG directory entries directly (zero new dependencies).
// Pass --check to render to memory and verify committed files match without writing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webAppDir = resolve(rootDir, 'apps/web/app');
const tokensCssPath = resolve(rootDir, 'mockups/tokens.css');

const EXPECTED_TOKENS = {
  '--logo-ink': '#202020',
  '--logo-magenta': '#FA12E3',
  '--logo-cyan': '#12D0FA',
};

function verifyTokensCss() {
  const css = readFileSync(tokensCssPath, 'utf8');
  const rootBlockMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  const scope = rootBlockMatch ? rootBlockMatch[1] : css;

  for (const [token, expected] of Object.entries(EXPECTED_TOKENS)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = scope.match(new RegExp(`${escaped}\\s*:\\s*([^;\\s]+)\\s*;`));
    const actual = match ? match[1] : null;
    if (!actual || actual.toUpperCase() !== expected.toUpperCase()) {
      throw new Error(
        `Token drift in mockups/tokens.css for ${token}: expected ${expected}, got ${actual ?? '<missing>'}`,
      );
    }
  }
}

verifyTokensCss();

const webRequire = createRequire(resolve(rootDir, 'apps/web/package.json'));
const nextRequire = createRequire(webRequire.resolve('next/package.json'));
const sharp = nextRequire('sharp');

const LOGO_INK = EXPECTED_TOKENS['--logo-ink'];
const LOGO_MAGENTA = EXPECTED_TOKENS['--logo-magenta'];
const LOGO_CYAN = EXPECTED_TOKENS['--logo-cyan'];

function buildIconSvg({ strokeWidth = 2.6, dashArray = '0.1 5.2 0.1 4 20' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <style>@media (prefers-color-scheme: dark){.b{stroke:#fff;stroke-opacity:.35;stroke-width:1}}</style>
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="5" y1="17" x2="23" y2="11">
      <stop offset="0%" stop-color="${LOGO_MAGENTA}"/>
      <stop offset="100%" stop-color="${LOGO_CYAN}"/>
    </linearGradient>
  </defs>
  <rect class="b" x="0.5" y="0.5" width="27" height="27" rx="8.5" fill="${LOGO_INK}"/>
  <path d="M5.5 16C11 16 16.5 12 22.5 12" fill="none" stroke="url(#g)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${dashArray}"/>
</svg>
`;
}

function buildAppleIconSvg({ strokeWidth = 2.6, dashArray = '0.1 5.2 0.1 4 20' } = {}) {
  // Full-bleed opaque square (no rounded corners; iOS masks the icon itself).
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="5" y1="17" x2="23" y2="11">
      <stop offset="0%" stop-color="${LOGO_MAGENTA}"/>
      <stop offset="100%" stop-color="${LOGO_CYAN}"/>
    </linearGradient>
  </defs>
  <rect width="28" height="28" fill="${LOGO_INK}"/>
  <path d="M5.5 16C11 16 16.5 12 22.5 12" fill="none" stroke="url(#g)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${dashArray}"/>
</svg>
`;
}

function buildIcoFrameSvg({ strokeWidth = 2.6, dashArray = '0.1 5.2 0.1 4 20', rimWidth = 1 } = {}) {
  // ICO frames cannot evaluate CSS media queries; bake a subtle 1px rim (#FFFFFF at 0.22 opacity)
  // inset by half the stroke so the rounded tile edge stays visible on dark #202124 tabs.
  const inset = rimWidth / 2;
  const span = 28 - rimWidth;
  const rx = 9 - inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="5" y1="17" x2="23" y2="11">
      <stop offset="0%" stop-color="${LOGO_MAGENTA}"/>
      <stop offset="100%" stop-color="${LOGO_CYAN}"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${span}" height="${span}" rx="${rx}" fill="${LOGO_INK}" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="${rimWidth}"/>
  <path d="M5.5 16C11 16 16.5 12 22.5 12" fill="none" stroke="url(#g)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${dashArray}"/>
</svg>
`;
}

async function renderPng(svgString, size, { opaqueBg = null } = {}) {
  let pipeline = sharp(Buffer.from(svgString), { density: Math.round((72 * size) / 28) * 4 }).resize(
    size,
    size,
    { fit: 'fill' },
  );
  if (opaqueBg) {
    pipeline = pipeline.flatten({ background: opaqueBg });
  }
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

function encodeIco(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = headerSize + count * dirEntrySize;

  const header = Buffer.alloc(dirSize);
  header.writeUInt16LE(0, 0); // Reserved = 0
  header.writeUInt16LE(1, 2); // Type = 1 (ICO)
  header.writeUInt16LE(count, 4); // Number of images

  let dataOffset = dirSize;
  const payloads = [];

  entries.forEach(({ size, png }, idx) => {
    const offset = headerSize + idx * dirEntrySize;
    header.writeUInt8(size >= 256 ? 0 : size, offset + 0); // Width
    header.writeUInt8(size >= 256 ? 0 : size, offset + 1); // Height
    header.writeUInt8(0, offset + 2); // Color palette count
    header.writeUInt8(0, offset + 3); // Reserved
    header.writeUInt16LE(1, offset + 4); // Color planes
    header.writeUInt16LE(32, offset + 6); // Bits per pixel (RGBA)
    header.writeUInt32LE(png.length, offset + 8); // Image byte size
    header.writeUInt32LE(dataOffset, offset + 12); // Offset in file
    payloads.push(png);
    dataOffset += png.length;
  });

  return Buffer.concat([header, ...payloads]);
}

const iconSvg = buildIconSvg({ strokeWidth: 2.6, dashArray: '0.1 5.2 0.1 4 20' });
const appleIconSvg = buildAppleIconSvg({ strokeWidth: 2.6, dashArray: '0.1 5.2 0.1 4 20' });
const applePng = await renderPng(appleIconSvg, 180, { opaqueBg: LOGO_INK });

const icoSizes = [16, 32, 48];
const icoEntries = [];
for (const size of icoSizes) {
  // 1px rim in output pixels = (28 / size) units in the 28x28 SVG viewBox.
  const rimWidth = Number((28 / size).toFixed(4));
  const strokeWidth = size <= 16 ? 3.1 : 2.6;
  const frameSvg = buildIcoFrameSvg({
    strokeWidth,
    dashArray: '0.1 5.2 0.1 4 20',
    rimWidth,
  });
  const png = await renderPng(frameSvg, size);
  icoEntries.push({ size, png });
}

const icoBuffer = encodeIco(icoEntries);

const expectedOutputs = [
  { name: 'icon.svg', path: resolve(webAppDir, 'icon.svg'), buffer: Buffer.from(iconSvg, 'utf8') },
  { name: 'apple-icon.png', path: resolve(webAppDir, 'apple-icon.png'), buffer: applePng },
  { name: 'favicon.ico', path: resolve(webAppDir, 'favicon.ico'), buffer: icoBuffer },
];

const isCheckMode = process.argv.includes('--check');

if (isCheckMode) {
  const drifted = [];
  for (const item of expectedOutputs) {
    if (!existsSync(item.path)) {
      drifted.push(`${item.name} (missing)`);
      continue;
    }
    const current = readFileSync(item.path);
    const matches =
      item.name.endsWith('.svg')
        ? current.toString('utf8').replace(/\r\n/g, '\n') === item.buffer.toString('utf8').replace(/\r\n/g, '\n')
        : current.equals(item.buffer);
    if (!matches) {
      drifted.push(item.name);
    }
  }
  if (drifted.length > 0) {
    console.error(`Favicon drift detected in: ${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log('Favicon check passed: icon.svg, apple-icon.png, favicon.ico are up to date.');
  process.exit(0);
}

writeFileSync(resolve(webAppDir, 'icon.svg'), iconSvg, 'utf8');
writeFileSync(resolve(webAppDir, 'apple-icon.png'), applePng);
writeFileSync(resolve(webAppDir, 'favicon.ico'), icoBuffer);

console.log(
  `Generated icon.svg (${Buffer.byteLength(iconSvg)}B), apple-icon.png (${applePng.length}B), favicon.ico (${icoBuffer.length}B)`,
);
