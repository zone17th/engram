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
 * Ba biến font và các khai báo `font-family` dùng `var(--font-*)` thay cho tên họ
 * font viết thẳng của mockup là khác biệt DUY NHẤT được phép giữa mockup và web
 * (advisor-dec-067): mockup nạp font qua CDN, web self-host qua next/font để hợp CSP.
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

  it('mọi rule font-family của web khớp mockup sau khi chuẩn hoá literal <-> var(--font-*)', () => {
    const LITERAL_TO_VAR: Record<string, string> = {
      "'Plus Jakarta Sans', 'Inter', sans-serif": 'var(--font-display)',
      "'Inter', 'Plus Jakarta Sans', sans-serif": 'var(--font-sans)',
      "'Inter', sans-serif": 'var(--font-sans)',
      "'Sometype Mono', ui-monospace, monospace": 'var(--font-mono)',
      "'Sometype Mono', monospace": 'var(--font-mono)',
    };
    const extractFontRules = (css: string): Map<string, string> => {
      const stripped = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@import\s+[^;]+;/g, '');
      const rules = new Map<string, string>();
      for (const match of stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().replace(/\s+/g, ' ');
        if (selector === ':root' || selector === "[data-theme='dark']") continue;
        for (const decl of match[2].split(';')) {
          const m = /^\s*font-family\s*:\s*(.+?)\s*$/.exec(decl);
          if (m) rules.set(selector, m[1].replace(/\s+/g, ' '));
        }
      }
      return rules;
    };
    const mockupRules = extractFontRules(mockupCss);
    const webRules = extractFontRules(webCss);
    expect([...webRules.keys()]).toEqual([...mockupRules.keys()]);
    for (const [selector, mockupFamily] of mockupRules) {
      const expectedVar = LITERAL_TO_VAR[mockupFamily];
      expect(expectedVar, `unmapped mockup font-family on ${selector}: ${mockupFamily}`).toBeDefined();
      expect(webRules.get(selector), `mismatch on ${selector}`).toBe(expectedVar);
    }
    expect(
      webCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root\s*\{[\s\S]*?\}/, ''),
    ).not.toMatch(/Plus Jakarta Sans|Inter|Sometype Mono/);
  });
});

describe('component rules (advisor-dec-129, P04 UIA-11)', () => {
  const selectors = (css: string): Set<string> =>
    new Set(
      [
        ...css
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/@import[^\n]*\n/g, '')
          .matchAll(/([^{}]+)\{/g),
      ].map((m) => m[1].trim().replace(/\s+/g, ' ')),
    );

  /** Mockup selectors the web writes differently on purpose; the reason sits next to the rule in styles/tokens.css. */
  const WEB_DIFFERENT: Record<string, string> = {
    ".seg button[aria-pressed='true'], .seg button[data-state='on']":
      ".seg button[aria-selected='true'], .seg button[aria-pressed='true'], .seg button[data-state='on']",
    '.sr-only': '', // Tailwind ships the identical utility
    '.rule-line': '', // renamed from .border-line (would override Tailwind `border-line` colour utility)
    '.rule-top-line': '', // renamed from .border-top-line (same family as .rule-line)
  };

  const mockupSelectors = selectors(mockupCss);
  const webSelectors = selectors(webCss);

  it('web has every mockup selector, except the documented differences', () => {
    const missing = [...mockupSelectors].filter((s) => !webSelectors.has(s) && !(s in WEB_DIFFERENT));
    expect(missing).toEqual([]);
  });

  it('each documented difference has its web replacement (or is a documented skip)', () => {
    for (const [mockupSelector, webSelector] of Object.entries(WEB_DIFFERENT)) {
      expect(mockupSelectors.has(mockupSelector), `stale entry ${mockupSelector}`).toBe(true);
      if (webSelector) expect(webSelectors.has(webSelector), `missing ${webSelector}`).toBe(true);
    }
  });

  it('keeps the omnibox shell ring as the only focus ring on the input (UIA-8)', () => {
    expect(webCss).toMatch(/\.omnibox-input:focus-visible\s*\{\s*outline:\s*none;\s*\}/);
    expect(webCss).toMatch(/\.omnibox-shell:focus-within\s*\{[^}]*border-color:\s*var\(--accent\)/);
  });

  it('keeps the darker light-only vault-open text on the app header (RV-UI1-1)', () => {
    expect(webCss).toMatch(
      /:root:not\(\[data-theme='dark'\]\) \.vault-open\s*\{\s*color:\s*#117A4B;\s*\}/,
    );
    // Dark keeps the mockup token rule.
    expect(webCss).toMatch(/\.vault-open\s*\{[^}]*color:\s*var\(--success-ink\)/);
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
