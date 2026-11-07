import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

function valueAtPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (typeof current !== 'object' || current === null) return undefined;
    return (current as Record<string, unknown>)[part];
  }, root);
}
function extractPlaceholders(str: string): string[] {
  const matches = [...str.matchAll(/\{([a-zA-Z0-9_]+)(?:\s*,|\})/g)].map((m) => m[1]);
  return [...new Set(matches)].sort();
}

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const enKeys = flatten(en).sort();
const viKeys = flatten(vi).sort();
describe('i18n', () => {
  it('en và vi có cùng bộ key', () => {
    expect(viKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !viKeys.includes(k))).toEqual([]);
  });

  it('en và vi có cùng bộ biến placeholder ICU ({var}) ở mọi key', () => {
    const diffs: string[] = [];
    for (const key of enKeys) {
      const enVal = String(valueAtPath(en, key) ?? '');
      const viVal = String(valueAtPath(vi, key) ?? '');
      const enVars = extractPlaceholders(enVal);
      const viVars = extractPlaceholders(viVal);
      if (enVars.join(',') !== viVars.join(',')) {
        diffs.push(`${key}: en=[${enVars.join(',')}] vs vi=[${viVars.join(',')}]`);
      }
    }
    expect(diffs).toEqual([]);
  });

  it('en.json không chứa chữ có dấu tiếng Việt ngoài các khoá song ngữ được phép', () => {
    const allowedBilingualKeys: Record<string, true> = {
      'settings.vaultSecurity.reset.confirmInputLabel': true,
      'settings.vaultSecurity.reset.confirmInputPlaceholder': true,
      'settings.account.localeVi': true,
    };
    const viDiacriticRegex =
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;
    const unexpected = enKeys.filter((key) => {
      if (allowedBilingualKeys[key]) return false;
      const val = String(valueAtPath(en, key) ?? '');
      return viDiacriticRegex.test(val);
    });
    expect(unexpected).toEqual([]);
  });

  it('không có chuỗi rỗng', () => {
    for (const [locale, messages] of [['en', en], ['vi', vi]] as const) {
      const empties = flatten(messages).filter((path) => {
        const value = valueAtPath(messages, path);
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
  it('mọi literal tJson(...) trong json-new-entry-composer.tsx đều có trong en và vi', () => {
    const composerSource = readFileSync(
      join(__dirname, '..', 'features', 'json-table', 'json-new-entry-composer.tsx'),
      'utf8',
    );
    const keys = [...composerSource.matchAll(/tJson\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(80);
    for (const key of new Set(keys)) {
      const enVal = valueAtPath(en.content.json, key);
      const viVal = valueAtPath(vi.content.json, key);
      expect(typeof enVal, `en missing content.json.${key}`).toBe('string');
      expect(typeof viVal, `vi missing content.json.${key}`).toBe('string');
    }
  });

  it('mọi lời gọi dịch tĩnh trong app/components/features đều trỏ tới chuỗi có thật trong en và vi', () => {
    const webRoot = join(__dirname, '..');
    const files = ['app', 'components', 'features'].flatMap((sub) =>
      walkTsFiles(join(webRoot, sub)),
    );
    const declRegex =
      /const\s+([a-zA-Z0-9_]+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g;
    const missing: string[] = [];
    let checked = 0;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const decls = [...stripped.matchAll(declRegex)].map((m) => ({
        varName: m[1],
        ns: m[2] ?? '',
        index: m.index ?? 0,
      }));
      if (decls.length === 0) continue;

      const varNames = [...new Set(decls.map((d) => d.varName))];
      for (const varName of varNames) {
        const callRegex = new RegExp(`\\b${varName}\\(\\s*['"]([^'"]+)['"]`, 'g');
        for (const match of stripped.matchAll(callRegex)) {
          const callIdx = match.index ?? 0;
          const key = match[1];
          const preceding = decls.filter((d) => d.varName === varName && d.index < callIdx);
          const activeDecl =
            preceding.length > 0
              ? preceding[preceding.length - 1]
              : decls.find((d) => d.varName === varName)!;
          const fullKey = activeDecl.ns ? `${activeDecl.ns}.${key}` : key;
          checked++;
          if (typeof valueAtPath(en, fullKey) !== 'string') {
            missing.push(`en missing ${fullKey} (${file})`);
          }
          if (typeof valueAtPath(vi, fullKey) !== 'string') {
            missing.push(`vi missing ${fullKey} (${file})`);
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(500);
    expect(missing).toEqual([]);
  });

  it('không component live-app nào render trực tiếp err.problem.detail hoặc err.problem.title', () => {
    const webRoot = join(__dirname, '..');
    const liveDirs = ['app/app', 'components/app-shell', 'components/ui', 'features'];
    const files = liveDirs.flatMap((sub) => walkTsFiles(join(webRoot, sub)));
    const offenders: string[] = [];

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      if (/\.problem\.(detail|title)\b/.test(stripped)) {
        offenders.push(file.replace(/\\/g, '/'));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('mọi khoá P06 dành sẵn đều nằm đúng một namespace chuẩn trong en và vi', () => {
    const canonicalReservedKeys = [
      'nav.help',
      'nav.skipToContent',
      'settings.search.privacyLink',
      'settings.data.docsLink',
      'states.vaultLocked',
      'states.vaultLockedTitle',
      'states.vaultLockedBody',
      'states.vaultLockedCta',
      'states.server500Title',
      'states.server500Body',
      'states.notFoundTitle',
      'states.notFoundBody',
      'states.backToList',
      'states.sessionExpiredTitle',
      'states.sessionExpiredBody',
      'states.sessionExpiredCta',
      'offline.banner',
      'offline.bannerTitle',
      'offline.bannerBody',
      'offline.reconnectedTitle',
      'offline.reconnectedBody',
      'offline.saveDeferredTitle',
      'offline.saveDeferredBody',
      'offline.retrySave',
      'offline.searchUnavailableTitle',
      'offline.searchUnavailableBody',
      'offline.exportUnavailableTitle',
      'offline.exportUnavailableBody',
      'auth.signup.mailResetUnavailable',
      'auth.forgot.contactIssues',
      'auth.forgot.contactHref',
      'auth.reauth.pendingAction',
      'auth.reauth.actions.export_decrypted',
      'auth.reauth.actions.account_delete',
      'settings.account.oauthUnavailable',
      'onboarding.settingUp',
      'onboarding.semanticConsent',
      'onboarding.semanticConsentTitle',
      'onboarding.semanticConsentBody',
      'onboarding.semanticConsentEnable',
      'onboarding.semanticConsentLater',
      'onboarding.semanticConsentError',
      'vault.passkey.add.timeout',
      'unlock.deriving',
      'search.toggle.similarMeaningLabel',
      'search.toggle.similarMeaningTooltip',
      'search.help.privacyHint1',
      'search.help.privacyHint2',
      'search.help.privacyHint3',
      'content.home.empty.fillHint',
      'search.consentBanner',
      'search.consentBannerTitle',
      'search.consentBannerBody',
      'search.consentBannerTurnOff',
      'search.consentBannerAcknowledge',
      'search.consentBannerError',
    ] as const;
    const forbiddenDuplicatePaths = [
      'app.header.help',
      'app.header.skipToContent',
      'search.similarMeaningLabel',
      'search.similarMeaningTooltip',
      'content.omnibox.similarMeaningLabel',
      'content.omnibox.similarMeaningTooltip',
      'search.privacyHint1',
      'search.privacyHint2',
      'search.privacyHint3',
      'content.omnibox.privacyHint1',
      'content.omnibox.privacyHint2',
      'content.omnibox.privacyHint3',
      'home.examples.fillHint',
      'content.home.examples.fillHint',
      'reauth.pendingAction',
      'passkey.add.timeout',
      'vault.state.settingUp',
      'vault.locked.neutralBanner',
    ] as const;
    for (const key of canonicalReservedKeys) {
      expect(typeof valueAtPath(en, key), `en missing canonical key ${key}`).toBe('string');
      expect(typeof valueAtPath(vi, key), `vi missing canonical key ${key}`).toBe('string');
    }
    for (const dup of forbiddenDuplicatePaths) {
      expect(valueAtPath(en, dup), `en should not duplicate ${dup}`).toBeUndefined();
      expect(valueAtPath(vi, dup), `vi should not duplicate ${dup}`).toBeUndefined();
    }

    expect(valueAtPath(en, 'unlock.deriving')).toBe('Unlocking… this can take a few seconds');
    expect(valueAtPath(vi, 'unlock.deriving')).toBe('Đang mở khoá… có thể mất vài giây');
    expect(valueAtPath(en, 'states.sessionExpiredBody')).toBe(
      'Sign in again to continue. Unsaved changes on this page were cleared for safety.',
    );
    expect(valueAtPath(vi, 'states.sessionExpiredBody')).toBe(
      'Đăng nhập lại để tiếp tục. Thay đổi chưa lưu trên trang này đã được xoá để bảo vệ bạn.',
    );
    expect(valueAtPath(vi, 'offline.banner')).toContain('mất kết nối');
    expect(valueAtPath(vi, 'offline.exportUnavailableBody')).toContain('Mất kết nối.');
    expect(valueAtPath(vi, 'vault.passkey.add.timeout')).toBe(
      'Đã chờ passkey quá 60 giây. Hãy thử lại hoặc bấm Huỷ.',
    );
    expect(valueAtPath(en, 'onboarding.semanticConsentEnable')).toBe('Turn on meaning-based search');
  });
});

describe('routing', () => {
  it('/ là en và /vi là vi', () => {
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('as-needed');
    expect(routing.locales).toEqual(['en', 'vi']);
  });
});
