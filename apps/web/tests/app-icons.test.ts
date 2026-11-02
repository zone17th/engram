import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');
const APP = resolve(WEB, 'app');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('app icons and manifest metadata files (P04-AUTH-U5)', () => {
  it('places icon.svg, apple-icon.png, favicon.ico, and manifest.ts at app/ root without app/layout.tsx', () => {
    expect(existsSync(resolve(APP, 'icon.svg'))).toBe(true);
    expect(existsSync(resolve(APP, 'apple-icon.png'))).toBe(true);
    expect(existsSync(resolve(APP, 'favicon.ico'))).toBe(true);
    expect(existsSync(resolve(APP, 'manifest.ts'))).toBe(true);
    expect(existsSync(resolve(APP, 'layout.tsx'))).toBe(false);
  });

  it('apple-icon.png is a valid 180x180 PNG', () => {
    const png = readFileSync(resolve(APP, 'apple-icon.png'));
    const { width, height } = readPngDimensions(png);
    expect(width).toBe(180);
    expect(height).toBe(180);
  });

  it('favicon.ico contains valid 16x16, 32x32, and 48x48 PNG entries', () => {
    const ico = readFileSync(resolve(APP, 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type = 1 (ICO)
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);

    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entryOffset = 6 + i * 16;
      const width = ico.readUInt8(entryOffset);
      const height = ico.readUInt8(entryOffset + 1);
      const bpp = ico.readUInt16LE(entryOffset + 6);
      const byteSize = ico.readUInt32LE(entryOffset + 8);
      const dataOffset = ico.readUInt32LE(entryOffset + 12);

      expect(width).toBe(height);
      expect(bpp).toBe(32);
      expect(dataOffset + byteSize).toBeLessThanOrEqual(ico.length);

      const payload = ico.subarray(dataOffset, dataOffset + byteSize);
      const pngDims = readPngDimensions(payload);
      expect(pngDims).toEqual({ width, height });
      sizes.push(width);
    }

    expect(sizes).toEqual([16, 32, 48]);
  });

  it('icon.svg inlines literal logo colours and includes the dark-scheme rim media query', () => {
    const svg = readFileSync(resolve(APP, 'icon.svg'), 'utf8');
    expect(svg).toContain('#202020');
    expect(svg).toContain('#FA12E3');
    expect(svg).toContain('#12D0FA');
    expect(svg).toContain('@media (prefers-color-scheme: dark)');
    expect(svg).toContain('.b{stroke:#fff;stroke-opacity:.35;stroke-width:1}');
    expect(svg).toContain('class="b"');
  });
});
