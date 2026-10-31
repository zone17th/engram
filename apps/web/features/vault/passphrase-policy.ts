import { passphraseToKdfBytes } from '@/lib/crypto/passphrase';
import { hasLoneSurrogate, type CryptoWorkerError } from '@/lib/crypto/protocol';

export const PASSPHRASE_MIN_LENGTH = 12;
export const PASSPHRASE_MIN_SCORE = 3;

export type PassphraseScore = 0 | 1 | 2 | 3 | 4;

export type PassphrasePolicyReasonCode =
  | 'ok'
  | 'empty'
  | 'invalid_unicode'
  | 'too_short'
  | 'too_weak'
  | 'mismatch';

export interface PassphrasePolicyOptions {
  /** Optional confirmation field value; when provided, mismatch is reported in `reasons` / `reason`. */
  confirmPassphrase?: string;
  /** Optional user-specific dictionary inputs (e.g., email local part) so zxcvbn penalizes account reuse. */
  userInputs?: ReadonlyArray<string | number>;
}

export interface PassphrasePolicyResult {
  /** True only when NFC length >= 12, zxcvbn score >= 3 on NFC string, well-formed Unicode, and (if provided) confirmation matches. */
  valid: boolean;
  /** Primary reason code for UI copy (`'ok'` when valid). */
  reason: PassphrasePolicyReasonCode;
  /** All failing reason codes in priority order (empty when `valid === true`). */
  reasons: PassphrasePolicyReasonCode[];
  /** Code-unit length of the NFC-normalized passphrase (`0` when empty or invalid Unicode). */
  normalizedLength: number;
  /** Byte length of the NFC-normalized UTF-8 passphrase (`0` when empty or invalid Unicode). */
  normalizedByteLength: number;
  /** True when `normalizedLength >= 12` and Unicode is well-formed. */
  meetsMinLength: boolean;
  /** True when `score >= 3` on the NFC-normalized passphrase. */
  meetsMinScore: boolean;
  /** True when `confirmPassphrase` was omitted or matches the passphrase after NFC normalization. */
  matchesConfirm: boolean;
  /** zxcvbn score (`0..4`) computed on the NFC-normalized passphrase (`0` when empty or invalid Unicode). */
  score: PassphraseScore;
  /** Non-secret zxcvbn feedback strings (never echoes the passphrase). */
  feedback: {
    warning: string | null;
    suggestions: string[];
  };
}

interface ZxcvbnChecker {
  checkAsync: (
    password: string,
    userInputs?: (string | number)[],
  ) => Promise<{
    score: PassphraseScore;
    feedback?: {
      warning?: string | null;
      suggestions?: string[];
    };
  }>;
}

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

let zxcvbnFactoryPromise: Promise<ZxcvbnChecker> | null = null;

async function getLazyZxcvbnChecker(): Promise<ZxcvbnChecker> {
  if (!zxcvbnFactoryPromise) {
    zxcvbnFactoryPromise = Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en'),
    ])
      .then(([coreModule, commonModule, enModule]) => {
        const factory = new coreModule.ZxcvbnFactory({
          translations: enModule.translations,
          graphs: commonModule.adjacencyGraphs,
          dictionary: {
            ...commonModule.dictionary,
            ...enModule.dictionary,
          },
        });
        return factory as ZxcvbnChecker;
      })
      .catch((err) => {
        zxcvbnFactoryPromise = null;
        throw err;
      });
  }
  return zxcvbnFactoryPromise;
}

/**
 * Normalizes a passphrase using the exact NFC pipeline from `lib/crypto/passphrase.ts`
 * (`hasLoneSurrogate` check -> UTF-8 -> `passphraseToKdfBytes` -> NFC string) and zeroes
 * temporary byte buffers immediately (user-dec-003, ADR 0002 §4 & §11).
 */
export function normalizePassphraseForPolicy(passphrase: string): {
  ok: true;
  normalized: string;
  normalizedByteLength: number;
} | {
  ok: false;
  code: 'PASSPHRASE_INVALID';
} {
  if (hasLoneSurrogate(passphrase)) {
    return { ok: false, code: 'PASSPHRASE_INVALID' };
  }

  const rawBytes = utf8Encoder.encode(passphrase);
  let kdfBytes: Uint8Array | null = null;
  try {
    kdfBytes = passphraseToKdfBytes(rawBytes);
    const normalized = strictUtf8Decoder.decode(kdfBytes);
    const normalizedByteLength = kdfBytes.byteLength;
    return {
      ok: true,
      normalized,
      normalizedByteLength,
    };
  } catch (err) {
    const maybeErr = err as Partial<CryptoWorkerError> | undefined;
    if (maybeErr?.code === 'PASSPHRASE_INVALID') {
      return { ok: false, code: 'PASSPHRASE_INVALID' };
    }
    return { ok: false, code: 'PASSPHRASE_INVALID' };
  } finally {
    rawBytes.fill(0);
    if (kdfBytes) {
      kdfBytes.fill(0);
    }
  }
}

/**
 * Shared async passphrase policy evaluator for Onboarding U3 and Recovery / Rewrap (T16A, T17A, T20A).
 *
 * Rules (plan §2.1, Task 16 step 1, ADR 0002 §9 & §12, advisor-dec-026, user-dec-003):
 * - Rejects unpaired UTF-16 surrogates (`invalid_unicode`) before any encoding or scoring.
 * - Normalizes the passphrase to NFC via `passphraseToKdfBytes` (`lib/crypto/passphrase.ts`).
 * - Evaluates minimum length (`>= 12` code units) and `zxcvbn >= 3` on the NFC-normalized string.
 * - Lazily loads `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`, and `@zxcvbn-ts/language-en` via dynamic `import()`.
 * - Never logs, persists, or echoes the passphrase in returned reasons or feedback.
 */
export async function checkPassphrasePolicy(
  passphrase: string,
  options?: PassphrasePolicyOptions,
): Promise<PassphrasePolicyResult> {
  const hasConfirm = options?.confirmPassphrase !== undefined;
  const confirmRaw = options?.confirmPassphrase ?? '';

  if (passphrase.length === 0) {
    const matchesConfirm = !hasConfirm || confirmRaw.length === 0;
    const reasons: PassphrasePolicyReasonCode[] = ['empty'];
    if (hasConfirm && !matchesConfirm) {
      reasons.push('mismatch');
    }
    return {
      valid: false,
      reason: 'empty',
      reasons,
      normalizedLength: 0,
      normalizedByteLength: 0,
      meetsMinLength: false,
      meetsMinScore: false,
      matchesConfirm,
      score: 0,
      feedback: { warning: null, suggestions: [] },
    };
  }

  const normResult = normalizePassphraseForPolicy(passphrase);
  if (!normResult.ok) {
    return {
      valid: false,
      reason: 'invalid_unicode',
      reasons: ['invalid_unicode'],
      normalizedLength: 0,
      normalizedByteLength: 0,
      meetsMinLength: false,
      meetsMinScore: false,
      matchesConfirm: false,
      score: 0,
      feedback: { warning: null, suggestions: [] },
    };
  }

  let matchesConfirm = true;
  let confirmInvalidUnicode = false;
  if (hasConfirm) {
    const confirmNorm = normalizePassphraseForPolicy(confirmRaw);
    if (!confirmNorm.ok) {
      confirmInvalidUnicode = true;
      matchesConfirm = false;
    } else {
      matchesConfirm = normResult.normalized === confirmNorm.normalized;
    }
  }

  const normalized = normResult.normalized;
  const normalizedLength = normalized.length;
  const meetsMinLength = normalizedLength >= PASSPHRASE_MIN_LENGTH;

  const sanitizedUserInputs = (options?.userInputs ?? []).map((item) =>
    typeof item === 'string' ? item.normalize('NFC') : item,
  );

  const checker = await getLazyZxcvbnChecker();
  const zxcvbnRes = await checker.checkAsync(normalized, sanitizedUserInputs);
  const score = zxcvbnRes.score;
  const meetsMinScore = score >= PASSPHRASE_MIN_SCORE;

  const reasons: PassphrasePolicyReasonCode[] = [];
  if (confirmInvalidUnicode) {
    reasons.push('invalid_unicode');
  }
  if (!meetsMinLength) {
    reasons.push('too_short');
  }
  if (!meetsMinScore) {
    reasons.push('too_weak');
  }
  if (hasConfirm && !matchesConfirm && !confirmInvalidUnicode) {
    reasons.push('mismatch');
  }

  const valid = reasons.length === 0;
  const reason: PassphrasePolicyReasonCode = valid ? 'ok' : (reasons[0] ?? 'too_weak');

  return {
    valid,
    reason,
    reasons,
    normalizedLength,
    normalizedByteLength: normResult.normalizedByteLength,
    meetsMinLength,
    meetsMinScore,
    matchesConfirm,
    score,
    feedback: {
      warning: zxcvbnRes.feedback?.warning ? String(zxcvbnRes.feedback.warning) : null,
      suggestions: Array.isArray(zxcvbnRes.feedback?.suggestions)
        ? zxcvbnRes.feedback.suggestions.map(String)
        : [],
    },
  };
}

/** Alias for callers that prefer `evaluatePassphrasePolicy`. */
export const evaluatePassphrasePolicy = checkPassphrasePolicy;
