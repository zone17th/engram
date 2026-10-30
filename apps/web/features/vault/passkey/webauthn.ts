import { decodeBase64UrlStrict, encodeBase64Url } from '@/lib/crypto/b64url';
import type {
  VaultPasskeyRegisterOptionsResponse,
  VaultPasskeyUnlockOptionsResponse,
} from '@/lib/api/vault';

/** WebAuthn PRF output (`results.first`) and the salts / challenges we exchange are all 32 bytes. */
export const PRF_BYTES = 32;
export const CLIENT_CHALLENGE_BYTES = 32;

export class PasskeyOptionsError extends Error {
  readonly code = 'PASSKEY_OPTIONS_INVALID' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PasskeyOptionsError';
  }
}

/** PRF result of a WebAuthn ceremony. `first` is a private copy; the browser-owned source buffer is zeroed. */
export interface PrfExtensionResult {
  enabled: boolean;
  first: Uint8Array | null;
}

type PrfClientResults = {
  prf?: { enabled?: boolean; results?: { first?: BufferSource } };
};

function decodeField(
  value: string,
  expectedBytes: number | undefined,
  what: string,
): Uint8Array<ArrayBuffer> {
  try {
    // The copy narrows the buffer type to ArrayBuffer, which is what `BufferSource` requires.
    return new Uint8Array(decodeBase64UrlStrict(value, expectedBytes));
  } catch (err) {
    throw new PasskeyOptionsError(`Invalid ${what} in passkey options`, { cause: err });
  }
}

/** Fresh 32 B CSPRNG challenge for the registration follow-up `get()` (ADR 0003 §4; never sent to the server). */
export function randomClientChallenge(): Uint8Array {
  const bytes = new Uint8Array(CLIENT_CHALLENGE_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function zeroize(bytes: Uint8Array | null | undefined): void {
  if (bytes && bytes.byteLength > 0) bytes.fill(0);
}

/**
 * Copies a browser-owned `BufferSource` into a standalone `Uint8Array` and zeroes the source, so the only live
 * copy is the one handed to the Worker as a transferable.
 */
function takeBytes(source: BufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  view.fill(0);
  return copy;
}

/**
 * Reads `getClientExtensionResults().prf`. A `results.first` that is not exactly 32 B is a malformed PRF output and
 * throws `PasskeyOptionsError` (the bytes are wiped first).
 */
export function readPrfResult(credential: PublicKeyCredential): PrfExtensionResult {
  // The DOM lib types `getClientExtensionResults()` without the PRF extension; the cast only adds that member.
  const extensionResults = credential.getClientExtensionResults() as PrfClientResults;
  const prf = extensionResults.prf;
  const source = prf?.results?.first;
  let first: Uint8Array | null = null;
  if (source !== undefined && source !== null) {
    first = takeBytes(source);
    if (first.byteLength !== PRF_BYTES) {
      zeroize(first);
      throw new PasskeyOptionsError('PRF output has the wrong length');
    }
  }
  return { enabled: prf?.enabled === true, first };
}

/** `NotAllowedError` / `AbortError` = the user (or the browser) dismissed the prompt. */
export function isWebAuthnCancellation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false;
  const name = err.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Server `CreationOptions` (base64url JSON) → `navigator.credentials.create()` shape. The server's `prf_salt` is
 * authoritative: it is installed as `prf.eval.first`, and options that carry a different salt are rejected.
 */
export function decodeCreationOptions(
  response: Pick<VaultPasskeyRegisterOptionsResponse, 'public_key' | 'prf_salt'>,
): { options: PublicKeyCredentialCreationOptions; prfSalt: Uint8Array } {
  const json = response.public_key;
  const prfSalt = decodeField(response.prf_salt, PRF_BYTES, 'prf_salt');
  const declared = json.extensions?.prf?.eval?.first;
  if (declared !== undefined && declared !== response.prf_salt) {
    throw new PasskeyOptionsError('Creation options PRF salt differs from prf_salt');
  }
  const options = {
    rp: json.rp,
    user: {
      ...json.user,
      id: decodeField(json.user.id, undefined, 'user.id'),
    },
    challenge: decodeField(json.challenge, undefined, 'challenge'),
    pubKeyCredParams: json.pubKeyCredParams,
    timeout: json.timeout,
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: decodeField(c.id, undefined, 'excludeCredentials.id'),
    })),
    authenticatorSelection: { ...json.authenticatorSelection, userVerification: 'required' },
    attestation: json.attestation,
    extensions: { prf: { eval: { first: prfSalt } } },
  } as unknown as PublicKeyCredentialCreationOptions;
  return { options, prfSalt };
}

export interface UnlockCredential {
  /** base64url credential id, as keyed in `evalByCredential`. */
  idB64: string;
  prfSalt: Uint8Array;
  vkWrap: string;
}

/**
 * Server `RequestOptions` + `credentials[]` → `navigator.credentials.get()` shape. `allowCredentials` and
 * `prf.evalByCredential` are both built from `credentials[]`, one salt per credential and never a shared one. A
 * duplicate id, or a server-declared `evalByCredential` salt that differs from `credentials[].prf_salt`, is rejected.
 */
export function decodeUnlockOptions(response: VaultPasskeyUnlockOptionsResponse): {
  options: PublicKeyCredentialRequestOptions;
  credentials: Map<string, UnlockCredential>;
} {
  const json = response.public_key;
  if (response.credentials.length === 0) {
    throw new PasskeyOptionsError('Unlock options carry no credentials');
  }
  const declared = json.extensions?.prf?.evalByCredential;
  const credentials = new Map<string, UnlockCredential>();
  const allowCredentials: PublicKeyCredentialDescriptor[] = [];
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const item of response.credentials) {
    if (credentials.has(item.id)) throw new PasskeyOptionsError('Duplicate credential id');
    const declaredFirst = declared?.[item.id]?.first;
    if (declaredFirst !== undefined && declaredFirst !== item.prf_salt) {
      throw new PasskeyOptionsError('evalByCredential salt differs from credentials[].prf_salt');
    }
    const prfSalt = decodeField(item.prf_salt, PRF_BYTES, 'prf_salt');
    const id = decodeField(item.id, undefined, 'credential id');
    credentials.set(item.id, { idB64: item.id, prfSalt, vkWrap: item.vk_wrap });
    allowCredentials.push({ type: 'public-key', id });
    evalByCredential[item.id] = { first: prfSalt };
  }
  const options = {
    challenge: decodeField(json.challenge, undefined, 'challenge'),
    rpId: json.rpId,
    timeout: json.timeout,
    allowCredentials,
    userVerification: 'required',
    extensions: { prf: { evalByCredential } },
  } as unknown as PublicKeyCredentialRequestOptions;
  return { options, credentials };
}

/** base64url form of the credential id an assertion was made with (`PublicKeyCredential.rawId`). */
export function credentialIdB64(credential: PublicKeyCredential): string {
  return encodeBase64Url(new Uint8Array(credential.rawId));
}

/** Attestation of the new credential in the shape of `POST /vault/passkeys`. */
export function encodeAttestation(credential: PublicKeyCredential): {
  client_data_json: string;
  attestation_object: string;
} {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    client_data_json: encodeBase64Url(new Uint8Array(response.clientDataJSON)),
    attestation_object: encodeBase64Url(new Uint8Array(response.attestationObject)),
  };
}

/** `code` of a `CryptoClientError` / `CryptoWorkerError` / `ProblemError`-like value, or null. */
export function errorCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  return typeof err.code === 'string' ? err.code : null;
}
