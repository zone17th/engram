import { ProblemError } from '@engram/shared-types';
import type { VaultPasskeyUnlockOptionsResponse, VaultState } from '@/lib/api/vault';
import type { CryptoClient, UnlockPrfClientParams } from '@/lib/crypto/client';
import {
  credentialIdB64,
  decodeUnlockOptions,
  errorCodeOf,
  isWebAuthnCancellation,
  readPrfResult,
  zeroize,
} from './webauthn';

/** Error codes are the SPEC §5.10 `passkey.*` keys except `busy` / `recovering` / `stale`. */
export type PasskeyUnlockErrorCode =
  | 'none_registered'
  | 'unlock_cancelled'
  | 'unlock_failed'
  | 'unlock_prf_missing'
  /** Another state-changing crypto call is in flight (`CLIENT_BUSY`); `lock()` first to switch flows. */
  | 'busy'
  /** The Worker is `recovering`; only the recovery whitelist is allowed until `lock()`. */
  | 'recovering'
  /** Lock/logout/user change while the flow ran; nothing is shown. */
  | 'stale';

export type PasskeyUnlockOutcome = { ok: true } | { ok: false; error: PasskeyUnlockErrorCode };

export interface PasskeyUnlockDeps {
  client: Pick<CryptoClient, 'captureGeneration' | 'getGeneration'>;
  api: { fetchUnlockOptions: () => Promise<VaultPasskeyUnlockOptionsResponse> };
  /** `GET /vault` for `private_keys_wrapped` (the provider's `reloadVaultMeta`). */
  loadVaultMeta: () => Promise<VaultState | null>;
  /** The provider's `unlockPrf` (single-flight, baseline capture); receives the PWK as a transferable. */
  unlockPrf: (params: UnlockPrfClientParams) => Promise<{ unlocked: true }>;
  credentials: Pick<CredentialsContainer, 'get'>;
  /** Provider `inFlight`: refuse before any network call or authenticator prompt. */
  isBusy?: () => boolean;
}

function isNoPasskey(err: unknown): boolean {
  return err instanceof ProblemError && err.problem.code === 'passkey_not_found';
}

/**
 * Unlocks the vault with a passkey (plan §2.5 "Unlock", SPEC §3.14). Never throws: failures are outcomes and the
 * PWK copy is wiped on every path.
 */
export async function runPasskeyUnlock(deps: PasskeyUnlockDeps): Promise<PasskeyUnlockOutcome> {
  // Captured synchronously, before POST /vault/unlock/passkey/options and navigator.credentials.get().
  const opGeneration = deps.client.captureGeneration();
  const isCurrent = () => deps.client.getGeneration() === opGeneration;
  const fail = (error: PasskeyUnlockErrorCode): PasskeyUnlockOutcome => ({ ok: false, error });

  if (deps.isBusy?.()) return fail('busy');

  let pwk: Uint8Array | null = null;
  try {
    let response: VaultPasskeyUnlockOptionsResponse;
    try {
      response = await deps.api.fetchUnlockOptions();
    } catch (err) {
      return fail(isNoPasskey(err) ? 'none_registered' : 'unlock_failed');
    }
    const { options, credentials } = decodeUnlockOptions(response);

    const meta = await deps.loadVaultMeta();
    if (!meta) return fail('unlock_failed');
    if (!isCurrent()) return fail('stale');

    let assertion: PublicKeyCredential;
    try {
      const got = await deps.credentials.get({ publicKey: options });
      if (!got) return fail('unlock_failed');
      assertion = got as PublicKeyCredential;
    } catch (err) {
      return fail(isWebAuthnCancellation(err) ? 'unlock_cancelled' : 'unlock_failed');
    }

    // Read (copy) and wipe the browser-owned PRF buffer BEFORE any early return: a stale result or an unknown
    // credential must not leave it alive. `pwk` then belongs to the finalizer below.
    let prfUnreadable = false;
    try {
      pwk = readPrfResult(assertion).first;
    } catch {
      prfUnreadable = true;
    }
    if (!isCurrent()) return fail('stale');

    // The wrap and salt of the credential the assertion was actually made with, never another one's.
    const used = credentials.get(credentialIdB64(assertion));
    if (!used) return fail('unlock_failed');
    if (prfUnreadable || !pwk) return fail('unlock_prf_missing');

    try {
      await deps.unlockPrf({
        pwk,
        vkWrap: used.vkWrap,
        privateKeysWrapped: meta.private_keys_wrapped,
        opGeneration,
      });
    } catch (err) {
      switch (errorCodeOf(err)) {
        case 'CLIENT_BUSY':
          return fail('busy');
        case 'VAULT_RECOVERING':
          return fail('recovering');
        case 'STALE_GENERATION':
          return fail('stale');
        default:
          return fail('unlock_failed');
      }
    }
    return { ok: true };
  } catch {
    return fail('unlock_failed');
  } finally {
    zeroize(pwk);
  }
}
