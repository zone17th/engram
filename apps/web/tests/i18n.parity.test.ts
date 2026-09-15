import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import vi from '../messages/vi.json';
import { routing } from '../i18n/routing';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

const enKeys = flatten(en).sort();
const viKeys = flatten(vi).sort();

describe('i18n', () => {
  it('en và vi có cùng bộ key', () => {
    expect(viKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !viKeys.includes(k))).toEqual([]);
  });

  it('không có chuỗi rỗng', () => {
    for (const [locale, messages] of [['en', en], ['vi', vi]] as const) {
      const empties = flatten(messages).filter((path) => {
        const value = path.split('.').reduce<any>((acc, part) => acc?.[part], messages);
        return typeof value === 'string' && value.trim() === '';
      });
      expect(`${locale}: ${empties.join(', ')}`).toBe(`${locale}: `);
    }
  });

  // Tên sản phẩm luôn viết thường ở MỌI locale (Global Constraints).
  it('không locale nào viết hoa tên sản phẩm', () => {
    for (const messages of [en, vi]) {
      const json = JSON.stringify(messages);
      expect(json).not.toMatch(/Engram|ENGRAM/);
      expect(json).toContain('engram');
    }
  });
});

describe('routing', () => {
  it('/ là en và /vi là vi', () => {
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('as-needed');
    expect(routing.locales).toEqual(['en', 'vi']);
  });
});
