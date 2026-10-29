import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './b64url';
import {
  CROCKFORD_ALPHABET,
  RK_BODY_LENGTH,
  RK_ENTROPY_BYTES,
  RK_HASH_BYTES,
  RK_LOOKUP_DOMAIN,
  RK_SLOT_MAX,
  RK_SLOT_MIN,
  RK_WRAP_DOMAIN,
  RecoveryKeyError,
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  encodeCrockford128LeftPad2,
  formatRecoveryKeyDisplay,
  generateRecoveryKey,
  normalizeRecoveryKey,
} from './recovery';
import { getSodium, type Sodium } from './sodium';
import { openWrap, sealWrap } from './wrap';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RK_VECTORS_PATH = resolve(
  __dirname,
  '../../../../packages/crypto-vectors/vectors/rk-v1.json',
);

export interface RecoveryKeyGenerationVector {
  id: string;
  slot: number;
  entropy_hex: string;
  display: string;
  rk_norm: string;
  lookup_hash_hex: string;
  lookup_hash_b64u: string;
  wrap_key_hex: string;
  wrap_key_b64u: string;
}

export interface RecoveryKeyNormalizationCase {
  id: string;
  description: string;
  input: string;
  valid: boolean;
  rk_norm: string | null;
  lookup_hash_hex: string | null;
  wrap_key_hex: string | null;
  expected_error: 'validation' | null;
}

export interface RecoveryKeyVectorSuiteV1 {
  schema: 'engram-rk-vectors-v1';
  producer: 'js';
  generation: RecoveryKeyGenerationVector[];
  cases: RecoveryKeyNormalizationCase[];
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Serializes a JSON value with 2-space indentation, escaping every non-ASCII code unit (`> 0x7F`)
 * as `\uXXXX` so `rk-v1.json` stays pure ASCII and deterministic across platforms.
 */
export function serializeVectorsAsciiJson(suite: RecoveryKeyVectorSuiteV1): string {
  const pretty = JSON.stringify(suite, null, 2);
  let out = '';
  for (let i = 0; i < pretty.length; i++) {
    const code = pretty.charCodeAt(i);
    if (code > 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += pretty[i];
    }
  }
  return `${out}\n`;
}

interface RawCaseSpec {
  id: string;
  description: string;
  input: string;
  valid: boolean;
  expectedNorm?: string;
}

const FIXED_GENERATION_INPUTS: Array<{ id: string; slot: number; entropy_hex: string }> = [
  { id: 'gen-slot-1-zeros', slot: 1, entropy_hex: '00000000000000000000000000000000' },
  { id: 'gen-slot-2-ones', slot: 2, entropy_hex: 'ffffffffffffffffffffffffffffffff' },
  { id: 'gen-slot-3-seq', slot: 3, entropy_hex: '0123456789abcdef0123456789abcdef' },
  { id: 'gen-slot-4-alt', slot: 4, entropy_hex: 'deadbeefcafebabe0011223344556677' },
  { id: 'gen-slot-5-highbit', slot: 5, entropy_hex: '80000000000000000000000000000001' },
  { id: 'gen-slot-6-mid', slot: 6, entropy_hex: '55aa55aa55aa55aa55aa55aa55aa55aa' },
  { id: 'gen-slot-7-p03', slot: 7, entropy_hex: '13579bdf2468ace013579bdf2468ace0' },
  { id: 'gen-slot-8-msb7', slot: 8, entropy_hex: 'f00dfacedeadc0de1122334455667788' },
  { id: 'gen-slot-9-low', slot: 9, entropy_hex: '0000000000000000000000000000002a' },
  { id: 'gen-slot-10-maxslot', slot: 10, entropy_hex: 'a5a5a5a55a5a5a5ac3c3c3c33c3c3c3c' },
];

// Canonical reference body from SPEC §5.9 / ADR 0002 §7 example:
// Display: rk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4
// Normalized: rk1_3F8K9M2P4Q7R6T1V8W5X2Y9ZC4
const REF_NORM_SLOT1 = 'rk1_3F8K9M2P4Q7R6T1V8W5X2Y9ZC4';
const REF_NORM_SLOT10 = 'rk10_3F8K9M2P4Q7R6T1V8W5X2Y9ZC4';
// Body containing 0 and 1 to exercise O/I/L Crockford aliases (`0` and `1` at start and inside):
// Display: rk2_018K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-01
// Normalized: rk2_018K9M2P4Q7R6T1V8W5X2Y9Z01
const ALIAS_NORM_SLOT2 = 'rk2_018K9M2P4Q7R6T1V8W5X2Y9Z01';

const RAW_CASE_SPECS: RawCaseSpec[] = [
  // --- Positive cases ---
  {
    id: 'pos-canonical-display-with-hyphens',
    description: 'Canonical onboarding display string with hyphens (slot 1)',
    input: 'rk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-without-hyphens',
    description: 'Valid recovery key without any hyphens in the 26-char body',
    input: 'rk1_3F8K9M2P4Q7R6T1V8W5X2Y9ZC4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-lowercase-prefix-and-body',
    description: 'Lowercase prefix and lowercase Crockford body with hyphens',
    input: 'rk1_3f8k-9m2p-4q7r-6t1v-8w5x-2y9z-c4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-uppercase-prefix-and-mixed-case',
    description: 'Uppercase RK prefix (RK1_, Rk1_, rK1_) with mixed-case body',
    input: 'RK1_3f8K-9M2p-4q7R-6T1v-8w5X-2y9Z-c4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-hyphen-separator-after-prefix',
    description: 'Hyphen separator (-) instead of underscore (_) after rk{n} prefix',
    input: 'rk1-3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-slot-10-with-hyphen-separator',
    description: 'Slot 10 (two-digit max slot) with uppercase prefix and hyphen separator',
    input: 'RK10-3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT10,
  },
  {
    id: 'pos-crockford-aliases-O-I-L-upper-and-lower',
    description: 'Crockford aliases O/o -> 0 and I/i/L/l -> 1 mapped to canonical 0 and 1',
    input: 'rk2_OI8K-9M2P-4Q7R-6TlV-8W5X-2Y9Z-oi',
    valid: true,
    expectedNorm: ALIAS_NORM_SLOT2,
  },
  {
    id: 'pos-ascii-whitespace-spaces-tabs-newlines',
    description: 'Normal ASCII spaces, tabs, CR/LF around and inside the key stripped in step 1',
    input: '  \t\n rk1_ 3F8K - 9M2P - 4Q7R - 6T1V\r\n - 8W5X - 2Y9Z - C4 \t ',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-unicode-nbsp-and-whitespace',
    description: 'Unicode White_Space including NBSP (U+00A0), ideographic space (U+3000), and thin space (U+2009)',
    input: '\u00A0rk1_3F8K\u00A09M2P\u20094Q7R\u30006T1V-8W5X-2Y9Z-C4\u00A0',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-unicode-cf-zero-width-and-bom',
    description: 'Unicode format chars (Cf): ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), WJ (U+2060), BOM (U+FEFF)',
    input: '\uFEFFrk1_\u200B3F8K-\u200C9M2P-\u200D4Q7R-\u20606T1V-8W5X-2Y9Z-C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-unicode-soft-hyphen',
    description: 'Soft hyphen U+00AD (category Cf) stripped across prefix and body',
    input: 'r\u00ADk1_3F\u00AD8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-unicode-dashes-u2010-u2015-and-minus-u2212',
    description: 'Unicode hyphens/dashes U+2010..U+2015 (incl. U+2011 non-breaking hyphen) and minus U+2212 converted to - (incl. prefix separator)',
    input: 'rk1\u20113F8K\u20109M2P\u20114Q7R\u20126T1V\u20138W5X\u20142Y9Z\u2212C4',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-fullwidth-nfkc-normalization',
    description: 'Full-width ASCII characters (NFKC maps full-width letters, digits, underscore, and hyphen-minus to ASCII)',
    input: '\uFF52\uFF4B\uFF11\uFF3F\uFF13\uFF26\uFF18\uFF2B\uFF0D9M2P-4Q7R-6T1V-8W5X-2Y9Z-\uFF43\uFF14',
    valid: true,
    expectedNorm: REF_NORM_SLOT1,
  },
  {
    id: 'pos-boundary-first-char-0-and-7',
    description: 'First body character at upper valid padding boundary 7',
    input: 'rk9_7ZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZ',
    valid: true,
    expectedNorm: 'rk9_7ZZZZZZZZZZZZZZZZZZZZZZZZZ',
  },

  // --- Negative cases (all must be rejected with expected_error = "validation") ---
  {
    id: 'neg-missing-separator-after-prefix',
    description: 'Missing _ or - separator between rk{n} and 26-char body',
    input: 'rk13F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-leading-zero-slot-rk01',
    description: 'Leading zero in slot number (rk01_ is forbidden)',
    input: 'rk01_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-slot-zero-rk0',
    description: 'Slot n=0 is outside valid range 1..10',
    input: 'rk0_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-slot-eleven-rk11',
    description: 'Slot n=11 is outside valid range 1..10',
    input: 'rk11_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-non-ascii-after-nfkc-dotless-i',
    description: 'Non-ASCII character remaining after NFKC: Turkish dotless i (U+0131 ı) must be rejected in step 2',
    input: 'rk1_3F8K-9M2P-4Q7R-6T\u0131V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-non-ascii-after-nfkc-eszett',
    description: 'Non-ASCII character remaining after NFKC: German sharp s (U+00DF ß) must be rejected in step 2',
    input: 'rk1_3F8K-9M2P-4Q7R-6T\u00DFV-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-non-ascii-after-nfkc-kelvin-sign',
    description: 'Non-ASCII character remaining after NFKC: Turkish dotted capital I (U+0130 İ) rejected in step 2 before case folding',
    input: 'rk1_3F8K-9M2P-4Q7R-6T\u0130V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-body-length-25',
    description: 'Body length 25 (one character too short)',
    input: 'rk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C',
    valid: false,
  },
  {
    id: 'neg-body-length-27',
    description: 'Body length 27 (one character too long)',
    input: 'rk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C45',
    valid: false,
  },
  {
    id: 'neg-crockford-forbidden-char-U-upper',
    description: 'Character U (uppercase) is excluded from Crockford Base32 and must be rejected (not stripped)',
    input: 'rk1_3F8K-9M2P-4Q7R-6T1U-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-crockford-forbidden-char-u-lower',
    description: 'Character u (lowercase) is excluded from Crockford Base32 and must be rejected',
    input: 'rk1_3F8K-9M2P-4Q7R-6T1u-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-non-crockford-punctuation-in-body',
    description: 'Underscore or punctuation inside the body after prefix is rejected',
    input: 'rk1_3F8K_9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-first-char-outside-0-7-digit-8',
    description: 'First character of 26-char body is 8 (outside 0..7 because top 2 padding bits must be 00)',
    input: 'rk1_8F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-first-char-outside-0-7-letter-A',
    description: 'First character of 26-char body is A (outside 0..7)',
    input: 'rk1_AF8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
  {
    id: 'neg-wrong-prefix-name',
    description: 'Prefix does not start with rk',
    input: 'vk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4',
    valid: false,
  },
];

export function buildRecoveryKeyVectorSuite(sodium: Sodium): RecoveryKeyVectorSuiteV1 {
  const generation: RecoveryKeyGenerationVector[] = FIXED_GENERATION_INPUTS.map((spec) => {
    const entropy = hexToBytes(spec.entropy_hex);
    const gen = generateRecoveryKey(sodium, spec.slot, entropy);
    const lookupBytes = deriveRecoveryLookupHash(sodium, gen.display);
    const wrapKeyBytes = deriveRecoveryWrapKey(sodium, gen.display);
    return {
      id: spec.id,
      slot: spec.slot,
      entropy_hex: spec.entropy_hex,
      display: gen.display,
      rk_norm: gen.normalized,
      lookup_hash_hex: bytesToHex(lookupBytes),
      lookup_hash_b64u: encodeBase64Url(lookupBytes),
      wrap_key_hex: bytesToHex(wrapKeyBytes),
      wrap_key_b64u: encodeBase64Url(wrapKeyBytes),
    };
  });

  const cases: RecoveryKeyNormalizationCase[] = RAW_CASE_SPECS.map((spec) => {
    if (spec.valid) {
      const rkNorm = normalizeRecoveryKey(spec.input);
      if (spec.expectedNorm && rkNorm !== spec.expectedNorm) {
        throw new Error(
          `Vector case ${spec.id} normalized to ${rkNorm}, expected ${spec.expectedNorm}`,
        );
      }
      const lookupBytes = deriveRecoveryLookupHash(sodium, rkNorm);
      const wrapKeyBytes = deriveRecoveryWrapKey(sodium, rkNorm);
      return {
        id: spec.id,
        description: spec.description,
        input: spec.input,
        valid: true,
        rk_norm: rkNorm,
        lookup_hash_hex: bytesToHex(lookupBytes),
        wrap_key_hex: bytesToHex(wrapKeyBytes),
        expected_error: null,
      };
    }

    // Verify negative case throws RecoveryKeyError
    let threw = false;
    try {
      normalizeRecoveryKey(spec.input);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`Negative vector case ${spec.id} unexpectedly succeeded`);
    }

    return {
      id: spec.id,
      description: spec.description,
      input: spec.input,
      valid: false,
      rk_norm: null,
      lookup_hash_hex: null,
      wrap_key_hex: null,
      expected_error: 'validation',
    };
  });

  return {
    schema: 'engram-rk-vectors-v1',
    producer: 'js',
    generation,
    cases,
  };
}

describe('P03-T7 Recovery Key Primitives & Cross-Language Vectors (rk-v1.json)', () => {
  it('generates or verifies byte-identical packages/crypto-vectors/vectors/rk-v1.json', async () => {
    const sodium = await getSodium();
    const suite = buildRecoveryKeyVectorSuite(sodium);
    const serialized = serializeVectorsAsciiJson(suite);

    if (process.env.GEN_CRYPTO_VECTORS === '1') {
      mkdirSync(dirname(RK_VECTORS_PATH), { recursive: true });
      writeFileSync(RK_VECTORS_PATH, serialized, 'utf8');
    }

    expect(existsSync(RK_VECTORS_PATH)).toBe(true);
    const committedText = readFileSync(RK_VECTORS_PATH, 'utf8');

    // Committed file must be pure ASCII (\uXXXX escapes for non-ASCII) and byte-identical to deterministic generator output
    expect(/[^\x00-\x7F]/.test(committedText)).toBe(false);
    expect(committedText).toBe(serialized);

    const sha256 = createHash('sha256').update(committedText, 'utf8').digest('hex');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates every vector in committed rk-v1.json (generation + positive & negative normalization cases)', async () => {
    const sodium = await getSodium();
    const committedText = readFileSync(RK_VECTORS_PATH, 'utf8');
    const committed = JSON.parse(committedText) as RecoveryKeyVectorSuiteV1;

    expect(committed.schema).toBe('engram-rk-vectors-v1');
    expect(committed.producer).toBe('js');
    expect(committed.generation).toHaveLength(10);
    expect(committed.cases.length).toBeGreaterThanOrEqual(25);

    // 1. Verify all 10 deterministic generation vectors
    for (const genVec of committed.generation) {
      const entropy = hexToBytes(genVec.entropy_hex);
      const generated = generateRecoveryKey(sodium, genVec.slot, entropy);
      expect(generated.slot).toBe(genVec.slot);
      expect(generated.display).toBe(genVec.display);
      expect(generated.normalized).toBe(genVec.rk_norm);
      expect(normalizeRecoveryKey(generated.display)).toBe(genVec.rk_norm);

      const lookupBytes = deriveRecoveryLookupHash(sodium, generated.display);
      const wrapKeyBytes = deriveRecoveryWrapKey(sodium, generated.display);
      expect(bytesToHex(lookupBytes)).toBe(genVec.lookup_hash_hex);
      expect(encodeBase64Url(lookupBytes)).toBe(genVec.lookup_hash_b64u);
      expect(bytesToHex(wrapKeyBytes)).toBe(genVec.wrap_key_hex);
      expect(encodeBase64Url(wrapKeyBytes)).toBe(genVec.wrap_key_b64u);
      // Domain separation: lookup_hash != wrap_key
      expect(genVec.lookup_hash_hex).not.toBe(genVec.wrap_key_hex);
    }

    // 2. Verify every normalization + hash case
    for (const tc of committed.cases) {
      if (tc.valid) {
        const norm = normalizeRecoveryKey(tc.input);
        expect(norm).toBe(tc.rk_norm);
        const lookupHex = bytesToHex(deriveRecoveryLookupHash(sodium, tc.input));
        const wrapKeyHex = bytesToHex(deriveRecoveryWrapKey(sodium, tc.input));
        expect(lookupHex).toBe(tc.lookup_hash_hex);
        expect(wrapKeyHex).toBe(tc.wrap_key_hex);
        expect(lookupHex).not.toBe(wrapKeyHex);
      } else {
        expect(tc.expected_error).toBe('validation');
        expect(tc.rk_norm).toBeNull();
        expect(tc.lookup_hash_hex).toBeNull();
        expect(tc.wrap_key_hex).toBeNull();
        expect(() => normalizeRecoveryKey(tc.input)).toThrow(RecoveryKeyError);
        expect(() => deriveRecoveryLookupHash(sodium, tc.input)).toThrow(RecoveryKeyError);
        expect(() => deriveRecoveryWrapKey(sodium, tc.input)).toThrow(RecoveryKeyError);
      }
    }
  });

  it('ensures onboarding display string and re-typed user strings produce the exact same lookup_hash and wrap_key', async () => {
    const sodium = await getSodium();
    const onboardingKey = generateRecoveryKey(sodium, 1);
    const expectedLookup = bytesToHex(deriveRecoveryLookupHash(sodium, onboardingKey.display));
    const expectedWrapKey = bytesToHex(deriveRecoveryWrapKey(sodium, onboardingKey.display));

    const bodyNoHyphens = onboardingKey.normalized.slice('rk1_'.length);
    const lowerWithAliases = bodyNoHyphens
      .toLowerCase()
      .replace(/0/g, 'o')
      .replace(/1/g, 'L');

    const retypedVariants = [
      onboardingKey.display,
      onboardingKey.normalized,
      onboardingKey.display.toLowerCase(),
      `RK1-${bodyNoHyphens}`,
      `  Rk1_${lowerWithAliases}  \n`,
      `\uFEFFrk1\u2011${lowerWithAliases.slice(0, 4)}\u00A0${lowerWithAliases.slice(4, 8)}\u200B\u2013${lowerWithAliases.slice(8, 12)}\u00AD${lowerWithAliases.slice(12)}\u3000`,
    ];

    for (const variant of retypedVariants) {
      expect(normalizeRecoveryKey(variant)).toBe(onboardingKey.normalized);
      expect(bytesToHex(deriveRecoveryLookupHash(sodium, variant))).toBe(expectedLookup);
      expect(bytesToHex(deriveRecoveryWrapKey(sodium, variant))).toBe(expectedWrapKey);
    }
  });

  it('generates 10 random keys for slots 1..10 with first char in 0..7, round-tripping through normalization and sealing/opening VK with sabk.vk.rk.v1', async () => {
    const sodium = await getSodium();
    const vk = sodium.randombytes_buf(32);

    for (let slot = RK_SLOT_MIN; slot <= RK_SLOT_MAX; slot++) {
      const rk = generateRecoveryKey(sodium, slot);
      expect(rk.slot).toBe(slot);
      expect(rk.display).toMatch(
        new RegExp(`^rk${slot}_[0-7][0-9A-HJ-KM-NP-TV-Z]{3}(?:-[0-9A-HJ-KM-NP-TV-Z]{4}){5}-[0-9A-HJ-KM-NP-TV-Z]{2}$`),
      );
      expect(normalizeRecoveryKey(rk.display)).toBe(rk.normalized);
      expect(normalizeRecoveryKey(rk.normalized)).toBe(rk.normalized);

      const lookupHash = deriveRecoveryLookupHash(sodium, rk.display);
      const wrapKey = deriveRecoveryWrapKey(sodium, rk.display);
      expect(lookupHash.byteLength).toBe(RK_HASH_BYTES);
      expect(wrapKey.byteLength).toBe(RK_HASH_BYTES);

      // Seal and re-open VK using wrap.ts with label sabk.vk.rk.v1
      const wrapBlob = sealWrap(sodium, 'rk', vk, wrapKey);
      const reopenedVk = openWrap(sodium, 'rk', wrapBlob, wrapKey);
      expect(Array.from(reopenedVk)).toEqual(Array.from(vk));
    }

    // Verify boundary helpers and error cases
    expect(RK_ENTROPY_BYTES).toBe(16);
    expect(RK_BODY_LENGTH).toBe(26);
    expect(RK_LOOKUP_DOMAIN).toBe('sabk.rk.lookup.v1');
    expect(RK_WRAP_DOMAIN).toBe('sabk.rk.wrap.v1');
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(() => encodeCrockford128LeftPad2(new Uint8Array(15))).toThrow(RecoveryKeyError);
    expect(() => generateRecoveryKey(sodium, 0)).toThrow(RecoveryKeyError);
    expect(() => generateRecoveryKey(sodium, 11)).toThrow(RecoveryKeyError);
    expect(() => formatRecoveryKeyDisplay(1, 'SHORT')).toThrow(RecoveryKeyError);
  });
});
