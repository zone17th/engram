import type { Sodium } from './sodium';

export const RK_SLOT_MIN = 1;
export const RK_SLOT_MAX = 10;
export const RK_LOOKUP_DOMAIN = 'sabk.rk.lookup.v1' as const;
export const RK_WRAP_DOMAIN = 'sabk.rk.wrap.v1' as const;

export interface GeneratedRecoveryKey {
  slot: number;
  display: string;
  normalized: string;
}

export interface RecoveryKeyAdapter {
  generateRecoveryKey: (sodium: Sodium, slot: number, rawEntropy16?: Uint8Array) => GeneratedRecoveryKey;
  formatRecoveryKeyDisplay: (slot: number, body26: string) => string;
  normalizeRecoveryKey: (input: string) => string;
  deriveRecoveryLookupHash: (sodium: Sodium, normalizedOrRaw: string) => Uint8Array;
  deriveRecoveryWrapKey: (sodium: Sodium, normalizedOrRaw: string) => Uint8Array;
}

/**
 * Typed stub for P03-T7: generates a recovery key for slot `1..10` (`rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`).
 */
export function generateRecoveryKey(
  _sodium: Sodium,
  _slot: number,
  _rawEntropy16?: Uint8Array,
): GeneratedRecoveryKey {
  void _sodium;
  void _slot;
  void _rawEntropy16;
  throw new Error('NOT_IMPLEMENTED: P03-T7');
}

/**
 * Typed stub for P03-T7: formats a 26-char Crockford Base32 body and slot into display string.
 */
export function formatRecoveryKeyDisplay(_slot: number, _body26: string): string {
  void _slot;
  void _body26;
  throw new Error('NOT_IMPLEMENTED: P03-T7');
}

/**
 * Typed stub for P03-T7: single canonical normalization function (5 steps of ADR 0002 §7 / plan mục 2.2).
 */
export function normalizeRecoveryKey(_input: string): string {
  void _input;
  throw new Error('NOT_IMPLEMENTED: P03-T7');
}

/**
 * Typed stub for P03-T7: derives 32-byte `BLAKE2b-256("sabk.rk.lookup.v1" || rk_norm)`.
 */
export function deriveRecoveryLookupHash(_sodium: Sodium, _normalizedOrRaw: string): Uint8Array {
  void _sodium;
  void _normalizedOrRaw;
  throw new Error('NOT_IMPLEMENTED: P03-T7');
}

/**
 * Typed stub for P03-T7: derives 32-byte `BLAKE2b-256("sabk.rk.wrap.v1" || rk_norm)`.
 */
export function deriveRecoveryWrapKey(_sodium: Sodium, _normalizedOrRaw: string): Uint8Array {
  void _sodium;
  void _normalizedOrRaw;
  throw new Error('NOT_IMPLEMENTED: P03-T7');
}
