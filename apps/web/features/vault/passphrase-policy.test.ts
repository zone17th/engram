import { describe, expect, it } from 'vitest';
import {
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_MIN_SCORE,
  checkPassphrasePolicy,
  evaluatePassphrasePolicy,
  normalizePassphraseForPolicy,
} from './passphrase-policy';

describe('passphrase-policy (NFC + zxcvbn >= 3 + length >= 12)', () => {
  it('exports the policy constants and evaluatePassphrasePolicy alias', () => {
    expect(PASSPHRASE_MIN_LENGTH).toBe(12);
    expect(PASSPHRASE_MIN_SCORE).toBe(3);
    expect(evaluatePassphrasePolicy).toBe(checkPassphrasePolicy);
  });

  it('rejects empty passphrase with reason "empty"', async () => {
    const res = await checkPassphrasePolicy('');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('empty');
    expect(res.reasons).toEqual(['empty']);
    expect(res.normalizedLength).toBe(0);
    expect(res.score).toBe(0);
  });

  it('rejects strings with unpaired UTF-16 surrogates with reason "invalid_unicode" without echoing input', async () => {
    const loneHigh = 'valid-prefix-\uD800-suffix-long-enough';
    const loneLow = 'valid-prefix-\uDC00-suffix-long-enough';

    const r1 = await checkPassphrasePolicy(loneHigh);
    expect(r1.valid).toBe(false);
    expect(r1.reason).toBe('invalid_unicode');
    expect(r1.reasons).toContain('invalid_unicode');
    expect(JSON.stringify(r1)).not.toContain('valid-prefix');

    const r2 = await checkPassphrasePolicy(loneLow);
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe('invalid_unicode');
  });

  it('computes length on the NFC-normalized string: rejects a passphrase whose NFD form is >= 12 code units but NFC form is < 12', async () => {
    // 'e\u0301' in NFD is 2 code units; in NFC ('\u00e9') it is 1 code unit.
    // Repeat 6 times + 'X!9a' (4 chars) -> NFD length = 12 + 4 = 16 (>= 12), NFC length = 6 + 4 = 10 (< 12).
    const nfdPassphrase = 'e\u0301'.repeat(6) + 'X!9a';
    const nfcPassphrase = nfdPassphrase.normalize('NFC');

    expect(nfdPassphrase.length).toBe(16);
    expect(nfcPassphrase.length).toBe(10);

    const res = await checkPassphrasePolicy(nfdPassphrase);
    expect(res.normalizedLength).toBe(10);
    expect(res.meetsMinLength).toBe(false);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('too_short');
    expect(res.reasons).toContain('too_short');
  });

  it('computes zxcvbn score on the NFC-normalized string: NFD and NFC forms produce identical score and validity, and an NFD dictionary/repeat pattern that collapses to weak NFC (< 3) is rejected', async () => {
    // 12 decomposed 'a\u0301' characters: NFD has 24 alternating code units ('a', '\u0301', ...),
    // which could fool a naive non-NFC scorer into seeing a 24-char alternating string,
    // whereas NFC is 'áááááááááááá' (12 identical repeated characters, zxcvbn score 0/1 < 3).
    const repeatedNfd = 'a\u0301'.repeat(12);
    const repeatedNfc = repeatedNfd.normalize('NFC');
    expect(repeatedNfd.length).toBe(24);
    expect(repeatedNfc.length).toBe(12);

    const resNfd = await checkPassphrasePolicy(repeatedNfd);
    const resNfc = await checkPassphrasePolicy(repeatedNfc);

    expect(resNfd.normalizedLength).toBe(12);
    expect(resNfd.meetsMinLength).toBe(true);
    expect(resNfd.score).toBe(resNfc.score);
    expect(resNfd.score).toBeLessThan(3);
    expect(resNfd.meetsMinScore).toBe(false);
    expect(resNfd.valid).toBe(false);
    expect(resNfd.reason).toBe('too_weak');

    // Strong passphrase in NFD vs NFC yields identical score >= 3 and valid === true
    const strongNfc = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';
    const strongNfd = strongNfc.normalize('NFD');
    expect(strongNfd).not.toBe(strongNfc);

    const strongResNfd = await checkPassphrasePolicy(strongNfd);
    const strongResNfc = await checkPassphrasePolicy(strongNfc);

    expect(strongResNfd.normalizedLength).toBe(strongResNfc.normalizedLength);
    expect(strongResNfd.score).toBe(strongResNfc.score);
    expect(strongResNfd.score).toBeGreaterThanOrEqual(3);
    expect(strongResNfd.valid).toBe(true);
    expect(strongResNfd.reason).toBe('ok');
  });

  it('rejects passphrases with length >= 12 but zxcvbn score < 3 (e.g. common password or sequence)', async () => {
    const weakLong = await checkPassphrasePolicy('password123456');
    expect(weakLong.meetsMinLength).toBe(true);
    expect(weakLong.meetsMinScore).toBe(false);
    expect(weakLong.score).toBeLessThan(3);
    expect(weakLong.valid).toBe(false);
    expect(weakLong.reason).toBe('too_weak');
  });
  it('penalizes passphrases matching userInputs (e.g. account email / username)', async () => {
    const candidate = 'zone17thminh2026';
    const withoutInputs = await checkPassphrasePolicy(candidate);
    const withUserInputs = await checkPassphrasePolicy(candidate, {
      userInputs: ['minh@zone17th.click', 'zone17thminh', 'minh', 'zone17th'],
    });
    expect(withoutInputs.score).toBeGreaterThanOrEqual(3);
    expect(withUserInputs.valid).toBe(false);
    expect(withUserInputs.meetsMinScore).toBe(false);
    expect(withUserInputs.reason).toBe('too_weak');
  });

  it('checks confirmation match on the NFC-normalized strings and reports "mismatch" when different', async () => {
    const passNfc = 'C\u00e2y-Tre-Tr\u0103m-\u0110\u1ed1t-73#Xanh';
    const passNfd = passNfc.normalize('NFD');

    // NFD and NFC of the same passphrase match after normalization
    const matched = await checkPassphrasePolicy(passNfc, {
      confirmPassphrase: passNfd,
    });
    expect(matched.matchesConfirm).toBe(true);
    expect(matched.valid).toBe(true);
    expect(matched.reason).toBe('ok');

    // Different confirmation fails with mismatch
    const mismatched = await checkPassphrasePolicy(passNfc, {
      confirmPassphrase: `${passNfc}-diff`,
    });
    expect(mismatched.matchesConfirm).toBe(false);
    expect(mismatched.valid).toBe(false);
    expect(mismatched.reason).toBe('mismatch');
    expect(mismatched.reasons).toContain('mismatch');
  });

  it('normalizePassphraseForPolicy uses passphraseToKdfBytes and rejects lone surrogates', () => {
    const ok = normalizePassphraseForPolicy('e\u0301');
    expect(ok).toEqual({
      ok: true,
      normalized: '\u00e9',
      normalizedByteLength: 2,
    });

    const bad = normalizePassphraseForPolicy('abc\uD800def');
    expect(bad).toEqual({
      ok: false,
      code: 'PASSPHRASE_INVALID',
    });
  });
});
