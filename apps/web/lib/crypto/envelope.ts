export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_ALG = 'xchacha20poly1305-ietf' as const;
export const ENVELOPE_CT_ENC = 'utf8' as const;
export const ENVELOPE_AAD_LABEL = 'sabk.entry.v1' as const;
export const ENTRY_PLAINTEXT_MAX_BYTES = 262_144; // 256 KiB
export const ENTRY_CIPHERTEXT_MAX_BYTES = 263_168; // 256 KiB + AEAD slack

export interface EntryEnvelopeV1 {
  v: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  key_id: string;
  nonce: string;
  ct_enc: typeof ENVELOPE_CT_ENC;
}

export interface EnvelopeAdapter {
  validateEntryEnvelope: (input: unknown) => EntryEnvelopeV1;
  canonicalizeEnvelopeJcs: (envelope: EntryEnvelopeV1) => string;
  buildEntryAad: (envelope: EntryEnvelopeV1, entryId: string) => Uint8Array;
}

/**
 * Typed stub for P03-T6: validates entry envelope v1 (exact 5 fields, duplicate-key rejection before map/jsonb).
 */
export function validateEntryEnvelope(_input: unknown): EntryEnvelopeV1 {
  void _input;
  throw new Error('NOT_IMPLEMENTED: P03-T6');
}

/**
 * Typed stub for P03-T6: canonicalizes validated `EntryEnvelopeV1` per RFC 8785 (JCS).
 */
export function canonicalizeEnvelopeJcs(_envelope: EntryEnvelopeV1): string {
  void _envelope;
  throw new Error('NOT_IMPLEMENTED: P03-T6');
}

/**
 * Typed stub for P03-T6: builds entry AEAD AAD `UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id)`.
 */
export function buildEntryAad(_envelope: EntryEnvelopeV1, _entryId: string): Uint8Array {
  void _envelope;
  void _entryId;
  throw new Error('NOT_IMPLEMENTED: P03-T6');
}
