import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');

function readVars(css: string, selector: string): Map<string, string> {
  // Lấy khối `selector { ... }` đầu tiên rồi bóc các khai báo --var: value;
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`không tìm thấy selector ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  // Strip comments so section/inline /* … */ do not glue onto the next --var
  // and defeat the naive `split(';')` parser (same values either way).
  const block = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');

  const vars = new Map<string, string>();
  for (const line of block.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) vars.set(m[1], m[2].replace(/\s+/g, ' '));
  }
  return vars;
}

/**
 * Ba biến font là khác biệt DUY NHẤT được phép giữa mockup và web: mockup nạp
 * font qua CDN, web self-host qua next/font để hợp CSP. Chúng được loại khỏi cả
 * phép "không thêm biến lạ" lẫn phép "giữ nguyên giá trị"; bù lại có test riêng
 * bên dưới bắt buộc chúng phải trỏ vào biến của next/font.
 */
const WEB_ONLY = new Set(['--font-display', '--font-sans', '--font-mono']);

const mockupCss = readFileSync(resolve(ROOT, 'mockups/tokens.css'), 'utf8');
const webCss = readFileSync(resolve(ROOT, 'apps/web/styles/tokens.css'), 'utf8');

describe.each([':root', "[data-theme='dark']"])('token %s', (selector) => {
  const fromMockup = readVars(mockupCss, selector);
  const fromWeb = readVars(webCss, selector);

  it('không thiếu biến nào so với mockup', () => {
    const missing = [...fromMockup.keys()].filter((k) => !fromWeb.has(k));
    expect(missing).toEqual([]);
  });

  it('không thêm biến lạ ngoài danh sách cho phép', () => {
    const extra = [...fromWeb.keys()].filter((k) => !fromMockup.has(k) && !WEB_ONLY.has(k));
    expect(extra).toEqual([]);
  });

  it('giữ nguyên giá trị của mọi biến (trừ ba biến font)', () => {
    const drifted: string[] = [];
    for (const [name, value] of fromMockup) {
      if (WEB_ONLY.has(name)) continue;
      if (fromWeb.get(name) !== value) drifted.push(`${name}: mockup=${value} web=${fromWeb.get(name)}`);
    }
    expect(drifted).toEqual([]);
  });
});

describe('font self-host', () => {
  const root = readVars(webCss, ':root');

  // Không đủ nếu chỉ bỏ qua --font-*: phải chứng minh chúng trỏ vào next/font,
  // chứ không phải bị xoá hay quay lại tên font của CDN.
  it.each([
    ['--font-display', '--font-plus-jakarta'],
    ['--font-sans', '--font-inter'],
    ['--font-mono', '--font-sometype'],
  ])('%s dùng biến %s do next/font cấp', (token, nextFontVar) => {
    expect(root.get(token)).toContain(`var(${nextFontVar})`);
  });

  it('giữ nguyên fallback stack của mockup', () => {
    const mockupRoot = readVars(mockupCss, ':root');
    for (const token of WEB_ONLY) {
      const mockupValue = mockupRoot.get(token);
      if (!mockupValue) continue;
      // Tên font đầu tiên của mockup vẫn phải còn trong chuỗi fallback của web.
      const firstFamily = mockupValue.split(',')[0].trim();
      expect(root.get(token)).toContain(firstFamily);
    }
  });
});

describe('token thương hiệu', () => {
  const root = readVars(webCss, ':root');
  it.each([
    ['--accent', '#B4128F'],
    ['--accent-hover', '#9A0F7A'],
    ['--accent-pressed', '#7D0C63'],
    ['--link', '#0091FF'],
    ['--logo-magenta', '#FA12E3'],
    ['--logo-cyan', '#12D0FA'],
    ['--product-teal', '#12A594'],
    ['--product-yellow', '#FFC800'],
    ['--app-navy', '#101F52'],
    ['--container', '1160px'],
  ])('%s = %s', (name, value) => {
    expect(root.get(name)).toBe(value);
  });
});

describe('port production', () => {
  it('không mang Tailwind Play CDN vào bundle', () => {
    expect(webCss).not.toContain('cdn.tailwindcss.com');
  });

  it('không @import Google Fonts (vi phạm CSP style-src/font-src)', () => {
    expect(webCss).not.toContain('fonts.googleapis.com');
    expect(webCss).not.toContain('@import');
  });

  it('giữ rule [hidden] thắng utility display của Tailwind', () => {
    expect(webCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});

describe('tailwind mirror tw.js', async () => {
  const twSource = readFileSync(resolve(ROOT, 'mockups/tw.js'), 'utf8');
  const config = (await import('../tailwind.config')).default;

  it('có đủ mọi tên màu mockup dùng', () => {
    const names = [...twSource.matchAll(/^\s{8}(\w+):\s*'var\(--[\w-]+\)'/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const colors = config.theme?.extend?.colors as Record<string, string>;
    for (const name of names) {
      if (name in colors) continue;
      const radii = config.theme?.extend?.borderRadius as Record<string, string>;
      const shadows = config.theme?.extend?.boxShadow as Record<string, string>;
      expect(name in radii || name in shadows).toBe(true);
    }
  });

  it('giữ maxWidth container = var(--container)', () => {
    expect((config.theme?.extend?.maxWidth as Record<string, string>).container).toBe('var(--container)');
  });
});
