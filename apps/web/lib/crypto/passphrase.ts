import { CryptoWorkerError, PASSPHRASE_INVALID_MESSAGE } from './protocol';

/**
 * Passphrase -> Argon2id input rule (ADR 0002 §4, user-dec-003, FE1-13):
 * 1. a string with an unpaired UTF-16 surrogate is rejected (`PASSPHRASE_INVALID`) BEFORE any encoding, so
 *    `TextEncoder` never silently substitutes U+FFFD (that would collide distinct passphrases);
 * 2. the Worker decodes the received UTF-8 strictly, NFC-normalizes and re-encodes; the result is the ONLY byte
 *    string that ever reaches `deriveKek` (create, unlock, rewrap).
 * The message of the error never echoes the input. (`hasLoneSurrogate` and the message live in protocol.ts: client.ts
 * may import only './protocol'.)
 */

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/**
 * The single Worker-side function that turns the received passphrase bytes into KDF input bytes:
 * strict UTF-8 decode (invalid -> `PASSPHRASE_INVALID`), NFC, UTF-8 encode into a NEW buffer. The caller owns and
 * zeroes both `incoming` and the returned buffer. The intermediate JS strings cannot be wiped; they live only
 * inside this call (ADR 0002 §11 residual).
 */
export function passphraseToKdfBytes(incoming: Uint8Array): Uint8Array {
  let decoded: string;
  try {
    decoded = strictUtf8Decoder.decode(incoming);
  } catch {
    throw new CryptoWorkerError('PASSPHRASE_INVALID', PASSPHRASE_INVALID_MESSAGE);
  }
  return utf8Encoder.encode(decoded.normalize('NFC'));
}
