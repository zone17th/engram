import canonicalize from 'canonicalize';
import { toLocalBytes } from './sodium';

export class JcsError extends Error {
  readonly code = 'ENVELOPE_INVALID' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JcsError';
  }
}

const utf8Encoder = new TextEncoder();

/**
 * Canonicalizes a JSON-compatible value according to RFC 8785 (JSON Canonicalization Scheme)
 * using the pinned `canonicalize` 5.1.0 library (ADR 0002 §3, §12).
 *
 * Rejects `undefined`, functions, symbols, non-finite numbers, lone UTF-16 surrogates,
 * and circular references.
 */
export function canonicalizeJcs(value: unknown): string {
  try {
    const out = canonicalize(value);
    if (typeof out !== 'string') {
      throw new JcsError('Value cannot be serialized to RFC 8785 JCS');
    }
    return out;
  } catch (err) {
    if (err instanceof JcsError) {
      throw err;
    }
    throw new JcsError('RFC 8785 JCS canonicalization failed', { cause: err });
  }
}

/**
 * Returns the UTF-8 byte representation of the RFC 8785 canonical JSON string.
 */
export function canonicalizeJcsBytes(value: unknown): Uint8Array {
  return toLocalBytes(utf8Encoder.encode(canonicalizeJcs(value)));
}
