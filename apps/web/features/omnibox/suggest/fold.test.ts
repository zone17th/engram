import { describe, expect, it } from 'vitest';
import {
  foldDiacritics,
  normalizeForFoldedPrefixMatch,
  splitHighlightByMatch,
  splitMarkedFoldedPrefix,
} from './fold';

describe('features/omnibox/suggest/fold', () => {
  it('folds đ/Đ to d and strips NFD combining marks (\\p{Mn})', () => {
    expect(foldDiacritics('đường')).toBe('duong');
    expect(foldDiacritics('ĐƯỜNG')).toBe('duong');
    expect(foldDiacritics('Đà Nẵng')).toBe('da nang');
    expect(foldDiacritics('mã'.normalize('NFD'))).toBe('ma');
    expect(foldDiacritics('mã'.normalize('NFC'))).toBe('ma');
    expect(normalizeForFoldedPrefixMatch('  Đà   Nẵng! ')).toBe('da nang');
  });

  it('highlights prefix_folded matches across đ/Đ, NFC, and NFD inputs while returning plain text segments', () => {
    expect(splitMarkedFoldedPrefix('đường Nguyễn Huệ', 'duong')).toEqual({
      before: '',
      match: 'đường',
      after: ' Nguyễn Huệ',
    });

    expect(splitMarkedFoldedPrefix('ĐƯỜNG Láng', 'duong')).toEqual({
      before: '',
      match: 'ĐƯỜNG',
      after: ' Láng',
    });

    expect(splitMarkedFoldedPrefix('Đà Nẵng trip', 'da nang')).toEqual({
      before: '',
      match: 'Đà Nẵng',
      after: ' trip',
    });

    // Decomposed NFD input text is normalized to NFC and sliced cleanly without orphaned marks
    const nfdText = 'mã số bí mật'.normalize('NFD');
    const seg = splitMarkedFoldedPrefix(nfdText, 'ma so');
    expect(seg).toEqual({
      before: '',
      match: 'mã số',
      after: ' bí mật',
    });

    // Folded query with diacritics matching unaccented text
    expect(splitMarkedFoldedPrefix('duong di', 'đường')).toEqual({
      before: '',
      match: 'duong',
      after: ' di',
    });

    // Non-matching query returns unmodified text in `after`
    expect(splitMarkedFoldedPrefix('wifi nhà', 'ssh')).toEqual({
      before: '',
      match: '',
      after: 'wifi nhà',
    });
  });

  it('splitHighlightByMatch only highlights prefix and prefix_folded, never fuzzy or semantic', () => {
    expect(splitHighlightByMatch('đường hoa', 'đường', 'prefix')).toEqual({
      before: '',
      match: 'đường',
      after: ' hoa',
    });
    expect(splitHighlightByMatch('đường hoa', 'duong', 'prefix_folded')).toEqual({
      before: '',
      match: 'đường',
      after: ' hoa',
    });
    expect(splitHighlightByMatch('password', 'pasword', 'fuzzy')).toEqual({
      before: '',
      match: '',
      after: 'password',
    });
    expect(splitHighlightByMatch('router nhà', 'mạng wifi', 'semantic')).toEqual({
      before: '',
      match: '',
      after: 'router nhà',
    });
  });
});
