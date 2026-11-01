#!/usr/bin/env node
// Generate apps/web/app/{icon.svg,apple-icon.png,favicon.ico} from the engram logo mark.
// Uses literal token values from mockups/tokens.css:
//   --logo-ink: #202020
//   --logo-magenta: #FA12E3
//   --logo-cyan: #12D0FA
// Uses sharp from Next.js transitive dependency in pnpm-lock.yaml and writes the ICO
// container header + PNG directory entries directly (zero new dependencies).

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webAppDir = resolve(rootDir, 'apps/web/app');

const webRequire = createRequire(resolve(rootDir, 'apps/web/package.json'));
const nextRequire = createRequire(webRequire.resolve('next/package.json'));
const sharp = nextRequire('sharp');

function buildLogoSvg({ strokeWidth = 2.6, dashArray = '0.1 5.2 0.1 4 20' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="5" y1="17" x2="23" y2="11">
      <stop offset="0%" stop-color="#FA12E3"/>
      <stop offset="100%" stop-color="#12D0FA"/>
    </linearGradient>
  </defs>
  <rect width="28" height="28" rx="9" fill="#202020"/>
  <path d="M5.5 16C11 16 16.5 12 22.5 12" fill="none" stroke="url(#g)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-dasharray="${dashArray}"/>
</svg>
`;
}

async function renderPng(svgString, size) {
  return sharp(Buffer.from(svgString), { density: Math.round((72 * size) / 28) * 4 })
    .resize(size, size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
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

const iconSvg = buildLogoSvg({ strokeWidth: 2.6, dashArray: '0.1 5.2 0.1 4 20' });
const smallIconSvg = buildLogoSvg({ strokeWidth: 3.1, dashArray: '0.1 5.2 0.1 4 20' });

writeFileSync(resolve(webAppDir, 'icon.svg'), iconSvg, 'utf8');

const applePng = await renderPng(iconSvg, 180);
writeFileSync(resolve(webAppDir, 'apple-icon.png'), applePng);

const icoSizes = [16, 32, 48];
const icoEntries = [];
for (const size of icoSizes) {
  const srcSvg = size <= 16 ? smallIconSvg : iconSvg;
  const png = await renderPng(srcSvg, size);
  icoEntries.push({ size, png });
}

const icoBuffer = encodeIco(icoEntries);
writeFileSync(resolve(webAppDir, 'favicon.ico'), icoBuffer);

console.log(
  `Generated icon.svg (${Buffer.byteLength(iconSvg)}B), apple-icon.png (${applePng.length}B), favicon.ico (${icoBuffer.length}B)`,
);
