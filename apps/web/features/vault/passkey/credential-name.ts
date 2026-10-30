/**
 * Passkey display name rule (plan §2.5, ADR 0003 §3): trim, 1–64 runes, no Unicode control characters (Cc) and no
 * bidi override/isolate/mark characters. The server applies the same rule to create and rename; this client-side check
 * only avoids a round trip (and a wasted authenticator prompt), it is never a security boundary.
 */

export const PASSKEY_NAME_MAX_RUNES = 64;

export type PasskeyNameRejection = 'empty' | 'too_long' | 'forbidden_chars';

export type PasskeyNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: PasskeyNameRejection };

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** U+202A–U+202E (embedding/override), U+2066–U+2069 (isolates), U+200E/U+200F (marks), U+061C (Arabic letter mark). */
function isBidiControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c
  );
}

export function validatePasskeyName(raw: string): PasskeyNameResult {
  const name = raw.trim();
  const runes = Array.from(name);
  if (runes.length === 0) return { ok: false, reason: 'empty' };
  if (runes.length > PASSKEY_NAME_MAX_RUNES) return { ok: false, reason: 'too_long' };
  for (const rune of runes) {
    const codePoint = rune.codePointAt(0) ?? 0;
    if (isControl(codePoint) || isBidiControl(codePoint)) {
      return { ok: false, reason: 'forbidden_chars' };
    }
  }
  return { ok: true, name };
}
