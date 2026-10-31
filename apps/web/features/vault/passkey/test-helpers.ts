import { ProblemError } from '@engram/shared-types';
import type { ReauthGrant } from '@/lib/api/auth';
import type {
  VaultPasskeyRegisterOptionsResponse,
  VaultPasskeyUnlockOptionsResponse,
} from '@/lib/api/vault';
import { encodeBase64Url } from '@/lib/crypto/b64url';

/** Shared fixtures for the passkey unit tests (WebAuthn mock). Never imported by production code. */

export const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

export function filled(length: number, value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(value);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export function isAllZero(bytes: Uint8Array | ArrayBuffer): boolean {
  return new Uint8Array(bytes).every((b) => b === 0);
}

export function makeGrant(
  token: string,
  expiresInMs: number,
  action: ReauthGrant['action'] = 'vault.passkey_register',
): ReauthGrant {
  return { grant: token, action, expires_at: new Date(NOW + expiresInMs).toISOString() };
}

export function problem(status: number, code: string, retryAfter?: number): ProblemError {
  return new ProblemError({
    type: 'about:blank',
    title: code,
    status,
    code,
    ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
  });
}

export function domError(name: string): DOMException {
  return new DOMException(`${name} (test)`, name);
}

export interface FakePrfOutput {
  enabled?: boolean;
  /** Bytes the authenticator returns as `results.first`; omitted = no output. */
  first?: Uint8Array;
}

export interface FakeCredential {
  credential: PublicKeyCredential;
  /** The browser-owned PRF buffer, so tests can assert the flow zeroed it. */
  prfSource: ArrayBuffer | null;
}

export const CREATION_CLIENT_DATA_JSON = filled(10, 0x31);
export const CREATION_ATTESTATION_OBJECT = filled(12, 0x41);
export const ASSERTION_CLIENT_DATA_JSON = filled(10, 0x52);

function extensionResultsOf(prf: FakePrfOutput | null | undefined, prfSource: ArrayBuffer | null) {
  if (!prf) return {};
  return {
    prf: {
      enabled: prf.enabled,
      ...(prfSource ? { results: { first: prfSource } } : {}),
    },
  };
}

/** A `navigator.credentials.create()` double (`AuthenticatorAttestationResponse`); `prf: null` = no `prf` entry. */
export function fakeCredential(opts: {
  rawId: Uint8Array;
  prf?: FakePrfOutput | null;
}): FakeCredential {
  const prfSource = opts.prf?.first ? toArrayBuffer(opts.prf.first) : null;
  const extensionResults = extensionResultsOf(opts.prf, prfSource);
  const credential = {
    rawId: toArrayBuffer(opts.rawId),
    response: {
      clientDataJSON: toArrayBuffer(CREATION_CLIENT_DATA_JSON),
      attestationObject: toArrayBuffer(CREATION_ATTESTATION_OBJECT),
    },
    getClientExtensionResults: () => extensionResults,
  } as unknown as PublicKeyCredential;
  return { credential, prfSource };
}

/**
 * A `navigator.credentials.get()` double (`AuthenticatorAssertionResponse`): distinct `clientDataJSON`, no
 * `attestationObject`, so a bug that encodes the assertion instead of the creation credential fails.
 */
export function fakeAssertion(opts: {
  rawId: Uint8Array;
  prf?: FakePrfOutput | null;
}): FakeCredential {
  const prfSource = opts.prf?.first ? toArrayBuffer(opts.prf.first) : null;
  const extensionResults = extensionResultsOf(opts.prf, prfSource);
  const credential = {
    rawId: toArrayBuffer(opts.rawId),
    response: {
      clientDataJSON: toArrayBuffer(ASSERTION_CLIENT_DATA_JSON),
      authenticatorData: toArrayBuffer(filled(37, 0x61)),
      signature: toArrayBuffer(filled(64, 0x71)),
      userHandle: null,
    },
    getClientExtensionResults: () => extensionResults,
  } as unknown as PublicKeyCredential;
  return { credential, prfSource };
}

export const REGISTER_SALT = filled(32, 0x07);
export const REGISTER_CHALLENGE = filled(32, 0x02);
export const NEW_CREDENTIAL_ID = filled(16, 0x5a);
export const PRF_OUTPUT = filled(32, 0xc3);

export function registerOptionsResponse(
  overrides: { declaredSalt?: Uint8Array } = {},
): VaultPasskeyRegisterOptionsResponse {
  const salt = encodeBase64Url(REGISTER_SALT);
  return {
    challenge_id: '6f1c2a5e-0b1d-4c63-9d2e-1b7f3a9c4e10',
    prf_salt: salt,
    public_key: {
      rp: { id: 'localhost', name: 'engram' },
      user: { id: encodeBase64Url(filled(16, 0x01)), name: 'user@example.test', displayName: 'User' },
      challenge: encodeBase64Url(REGISTER_CHALLENGE),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60_000,
      excludeCredentials: [{ type: 'public-key', id: encodeBase64Url(filled(16, 0x03)) }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      extensions: {
        prf: {
          eval: {
            first: overrides.declaredSalt ? encodeBase64Url(overrides.declaredSalt) : salt,
          },
        },
      },
    },
  };
}

export const CRED_A = { id: filled(16, 0xaa), salt: filled(32, 0x11), wrap: 'WRAP-A' };
export const CRED_B = { id: filled(16, 0xbb), salt: filled(32, 0x22), wrap: 'WRAP-B' };
export const UNLOCK_CHALLENGE = filled(32, 0x09);

export function unlockOptionsResponse(
  overrides: { declaredSaltForB?: Uint8Array } = {},
): VaultPasskeyUnlockOptionsResponse {
  const a = encodeBase64Url(CRED_A.id);
  const b = encodeBase64Url(CRED_B.id);
  return {
    public_key: {
      challenge: encodeBase64Url(UNLOCK_CHALLENGE),
      rpId: 'localhost',
      timeout: 60_000,
      allowCredentials: [
        { type: 'public-key', id: a },
        { type: 'public-key', id: b },
      ],
      userVerification: 'required',
      extensions: {
        prf: {
          evalByCredential: {
            [a]: { first: encodeBase64Url(CRED_A.salt) },
            [b]: {
              first: encodeBase64Url(overrides.declaredSaltForB ?? CRED_B.salt),
            },
          },
        },
      },
    },
    credentials: [
      { id: a, prf_salt: encodeBase64Url(CRED_A.salt), vk_wrap: CRED_A.wrap },
      { id: b, prf_salt: encodeBase64Url(CRED_B.salt), vk_wrap: CRED_B.wrap },
    ],
  };
}

function prfOf(extensions: unknown): object {
  if (typeof extensions === 'object' && extensions !== null && 'prf' in extensions) {
    const prf = extensions.prf;
    if (typeof prf === 'object' && prf !== null) return prf;
  }
  throw new Error('extensions carry no prf entry');
}

function bytesOf(value: unknown): number[] {
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  throw new Error('expected binary salt');
}

/** Bytes of `extensions.prf.eval.first` as handed to `navigator.credentials.create()/get()`. */
export function prfEvalFirst(extensions: unknown): number[] {
  const prf = prfOf(extensions);
  if ('eval' in prf && typeof prf.eval === 'object' && prf.eval !== null && 'first' in prf.eval) {
    return bytesOf(prf.eval.first);
  }
  throw new Error('prf carries no eval.first');
}

/** `extensions.prf.evalByCredential` as `{ credentialIdB64: saltBytes }`; `hasEval` tells if a shared `eval` leaked in. */
export function prfEvalByCredential(extensions: unknown): { salts: Record<string, number[]>; hasEval: boolean } {
  const prf = prfOf(extensions);
  if (!('evalByCredential' in prf) || typeof prf.evalByCredential !== 'object' || prf.evalByCredential === null) {
    throw new Error('prf carries no evalByCredential');
  }
  const salts: Record<string, number[]> = {};
  for (const [id, value] of Object.entries(prf.evalByCredential)) {
    if (typeof value !== 'object' || value === null || !('first' in value)) throw new Error('bad entry');
    salts[id] = bytesOf(value.first);
  }
  return { salts, hasEval: 'eval' in prf };
}
