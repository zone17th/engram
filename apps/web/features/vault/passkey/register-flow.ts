import { ProblemError } from '@engram/shared-types';
import type { ReauthGrant } from '@/lib/api/auth';
import type {
  VaultPasskeyCreateRequest,
  VaultPasskeyItem,
  VaultPasskeyRegisterOptionsResponse,
} from '@/lib/api/vault';
import type { CryptoClient } from '@/lib/crypto/client';
import { isAmbiguousServerFailure } from './ambiguous';
import { validatePasskeyName, type PasskeyNameRejection } from './credential-name';
import {
  decodeCreationOptions,
  encodeAttestation,
  errorCodeOf,
  isWebAuthnCancellation,
  randomClientChallenge,
  readPrfResult,
  zeroize,
  type PrfExtensionResult,
} from './webauthn';

/** Client-side minimum grant lifetime before the first POST (plan §1, SPEC §3.13 step 5). */
export const GRANT_MIN_REMAINING_MS = 60_000;
/** Replays of the identical POST after a lost response (ADR 0003 §5 branch 1). */
export const MAX_NETWORK_REPLAYS = 3;
export const NETWORK_REPLAY_DELAY_MS = 1_000;
/** `409 idempotency_in_progress` waits (server `Retry-After: 1`) before the outcome is declared unknown. */
export const MAX_IN_PROGRESS_WAITS = 10;

export type PasskeyRegisterErrorCode =
  | 'name_invalid'
  | 'reauth_cancelled'
  | 'reauth_restart_required'
  | 'prf_unsupported'
  | 'register_cancelled'
  | 'register_failed'
  /** The vault was locked / the user changed while the flow ran; nothing is shown. */
  | 'stale'
  /** POST outcome could not be confirmed after every replay; the credential may or may not be saved. */
  | 'network_unknown';

export type PasskeyRegisterOutcome =
  | { ok: true; passkey: VaultPasskeyItem }
  | {
      ok: false;
      error: PasskeyRegisterErrorCode;
      /**
       * True when a credential was created on the authenticator but the server definitely did not store it:
       * the UI tells the user they may delete the leftover credential in their passkey manager (plan §2.5 step 6).
       * Never set for `network_unknown`: the first POST may have committed (ADR 0003 §5).
       */
      orphan: boolean;
      nameReason?: PasskeyNameRejection;
    };

export interface PasskeyGrantPort {
  /** Resolves a usable `vault.passkey_register` grant (may prompt the user). Rejects when the user cancels. */
  acquire: () => Promise<ReauthGrant>;
  /**
   * Called before the first POST when the grant has < 60 s left. Password users re-authenticate in place and get a new
   * grant; OAuth-only users get `null` (a full-page re-auth would destroy the Worker, so they must restart). Rejects when
   * the user cancels.
   */
  renewInPlace: () => Promise<ReauthGrant | null>;
}

export interface PasskeyRegisterDeps {
  client: Pick<CryptoClient, 'captureGeneration' | 'getGeneration' | 'wrapForPasskey'>;
  grants: PasskeyGrantPort;
  api: {
    fetchRegisterOptions: () => Promise<VaultPasskeyRegisterOptionsResponse>;
    registerPasskey: (
      body: string,
      opts: { idempotencyKey: string; reauthToken: string },
    ) => Promise<VaultPasskeyItem>;
  };
  credentials: Pick<CredentialsContainer, 'create' | 'get'>;
  createIdempotencyKey: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function grantHasMargin(grant: ReauthGrant, nowMs: number): boolean {
  const expiresAt = Date.parse(grant.expires_at);
  return Number.isFinite(expiresAt) && expiresAt - nowMs >= GRANT_MIN_REMAINING_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PostResult =
  | { kind: 'saved'; passkey: VaultPasskeyItem }
  | { kind: 'rejected' }
  | { kind: 'unknown' };

/**
 * After an attempt of unknown outcome, only a rejection the server issues AFTER `Idempotency.Lookup` (plan §2.3 step 2,
 * `apps/api/internal/httpx/idempotency.go:256-315`) proves that the earlier attempt did not commit: a committed one is
 * answered from the stored 201 before kill-switch, re-auth, rate limit, `Idempotency.Claim` and domain checks run.
 *
 * Rejections that can be emitted BEFORE the DB lookup in step 2 — `RequireOrigin` / `RequireSession` / `RequireCSRF` /
 * `RequireJSONContent` (`401 unauthenticated` / `access_expired` / `session_invalid`, `403 csrf_invalid`, `415 invalid_request`),
 * `Idempotency.Lookup` header/body-read checks (`400 invalid_request`, `413 invalid_request`), and any proxy/IP
 * `429 rate_limited` — say nothing about whether the earlier attempt committed and must stay `unknown`.
 */
function provesEarlierAttemptUncommitted(problem: { status: number; code: string }): boolean {
  switch (problem.status) {
    case 400:
      return (
        problem.code === 'passkey_name_invalid' ||
        problem.code === 'vault_wrap_invalid' ||
        problem.code === 'passkey_challenge_invalid' ||
        problem.code === 'passkey_attestation_invalid'
      );
    case 401:
      return problem.code === 'reauth_required' || problem.code === 'reauth_invalid';
    case 403:
      return problem.code === 'reauth_unsupported_provider';
    case 404:
      return problem.code === 'vault_absent';
    case 409:
      return problem.code === 'passkey_exists' || problem.code === 'idempotency_conflict';
    case 503:
      return problem.code === 'vault_mutations_disabled';
    default:
      return false;
  }
}

/**
 * POST with ONE Idempotency-Key and ONE body string: a lost or unproven response (network error, 5xx other than the
 * deliberate kill-switch 503) is replayed byte-for-byte with the original `X-Reauth-Token` (the ≥ 60 s rule applies to
 * the first send only) before the credential may be declared orphaned (SPEC §3.13 step 5, ADR 0003 §5 branch 1). Once
 * any attempt had an unknown outcome, a later rejection only counts as definite when it proves that attempt did not
 * commit; otherwise the result stays unknown.
 */
async function postWithReplay(
  deps: PasskeyRegisterDeps,
  body: string,
  idempotencyKey: string,
  reauthToken: string,
): Promise<PostResult> {
  const sleep = deps.sleep ?? defaultSleep;
  let networkReplays = 0;
  let inProgressWaits = 0;
  let outcomeUnknown = false;
  for (;;) {
    try {
      const passkey = await deps.api.registerPasskey(body, { idempotencyKey, reauthToken });
      return { kind: 'saved', passkey };
    } catch (err) {
      if (err instanceof ProblemError) {
        const { problem } = err;
        if (problem.code === 'idempotency_in_progress') {
          // The claim of an earlier attempt of ours is still held: that attempt's outcome is not known yet.
          outcomeUnknown = true;
          inProgressWaits += 1;
          if (inProgressWaits > MAX_IN_PROGRESS_WAITS) return { kind: 'unknown' };
          await sleep(Math.max(1, problem.retry_after ?? 1) * 1_000);
          continue;
        }
        if (!isAmbiguousServerFailure(problem)) {
          if (!outcomeUnknown || provesEarlierAttemptUncommitted(problem)) return { kind: 'rejected' };
          return { kind: 'unknown' };
        }
      }
      outcomeUnknown = true;
      networkReplays += 1;
      if (networkReplays > MAX_NETWORK_REPLAYS) return { kind: 'unknown' };
      await sleep(NETWORK_REPLAY_DELAY_MS * networkReplays);
    }
  }
}

/**
 * Registers a passkey (plan §2.5 steps 1–6). Never throws: every failure is an outcome, and the PWK copy is wiped on
 * every path.
 */
export async function runPasskeyRegistration(
  deps: PasskeyRegisterDeps,
  input: { name: string },
): Promise<PasskeyRegisterOutcome> {
  // opGeneration is captured synchronously, before the first await (grant, options POST, create(), get()).
  const opGeneration = deps.client.captureGeneration();
  const isCurrent = () => deps.client.getGeneration() === opGeneration;
  const now = deps.now ?? Date.now;

  let credentialCreated = false;
  const fail = (
    error: PasskeyRegisterErrorCode,
    extra?: { nameReason?: PasskeyNameRejection },
  ): PasskeyRegisterOutcome => ({
    ok: false,
    error,
    orphan: credentialCreated && error !== 'network_unknown',
    ...extra,
  });

  const nameCheck = validatePasskeyName(input.name);
  if (!nameCheck.ok) return fail('name_invalid', { nameReason: nameCheck.reason });

  let pwk: Uint8Array | null = null;
  try {
    // Step 1: the grant is taken first, before any secret or WebAuthn call.
    let grant: ReauthGrant;
    try {
      grant = await deps.grants.acquire();
    } catch {
      return fail(isCurrent() ? 'reauth_cancelled' : 'stale');
    }
    if (!isCurrent()) return fail('stale');

    // Step 2: register options.
    let registerOptions: VaultPasskeyRegisterOptionsResponse;
    try {
      registerOptions = await deps.api.fetchRegisterOptions();
    } catch {
      return fail(isCurrent() ? 'register_failed' : 'stale');
    }
    // No authenticator prompt for a vault that was locked while the grant / options were pending.
    if (!isCurrent()) return fail('stale');
    const { options, prfSalt } = decodeCreationOptions(registerOptions);

    // Step 3: create(). PRF enabled !== true stops here; results.first is used as-is.
    let credential: PublicKeyCredential;
    try {
      const created = await deps.credentials.create({ publicKey: options });
      if (!created) return fail('register_failed');
      credential = created as PublicKeyCredential;
    } catch (err) {
      return fail(isWebAuthnCancellation(err) ? 'register_cancelled' : 'register_failed');
    }
    credentialCreated = true;

    // The browser-owned PRF buffer is read (copied) and wiped BEFORE any early return: a stale result must not leave
    // it alive. `pwk` then belongs to the finalizer below.
    let created: PrfExtensionResult | null = null;
    try {
      created = readPrfResult(credential);
    } catch {
      /* malformed length: the source buffer was wiped before the throw */
    }
    pwk = created?.first ?? null;
    if (!isCurrent()) return fail('stale');
    if (!created) return fail('register_failed');
    if (!created.enabled) return fail('prf_unsupported');

    if (!pwk) {
      // enabled=true without output: follow-up get() on the new credential, same opGeneration, client-made challenge
      // that never reaches the server (ADR 0003 §4).
      let assertion: PublicKeyCredential;
      try {
        const got = await deps.credentials.get({
          publicKey: {
            challenge: randomClientChallenge(),
            rpId: options.rp.id,
            timeout: options.timeout,
            allowCredentials: [{ type: 'public-key', id: credential.rawId }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: prfSalt } } },
          } as unknown as PublicKeyCredentialRequestOptions,
        });
        if (!got) return fail('register_failed');
        assertion = got as PublicKeyCredential;
      } catch (err) {
        // The credential exists already, so `fail` still reports it as an orphan.
        return fail(isWebAuthnCancellation(err) ? 'register_cancelled' : 'register_failed');
      }
      let readFailed = false;
      try {
        pwk = readPrfResult(assertion).first;
      } catch {
        readFailed = true;
      }
      if (!isCurrent()) return fail('stale');
      if (readFailed || !pwk) return fail('register_failed');
    }

    // Step 4: the Worker seals VK with PWK (transferable) and re-opens it; the PWK is wiped client-side as well.
    let vkWrap: string;
    try {
      ({ vk_wrap: vkWrap } = await deps.client.wrapForPasskey({ pwk, opGeneration }));
    } catch (err) {
      return fail(errorCodeOf(err) === 'STALE_GENERATION' ? 'stale' : 'register_failed');
    }
    zeroize(pwk);
    pwk = null;
    if (!isCurrent()) return fail('stale');

    const name = nameCheck.name;
    const request: VaultPasskeyCreateRequest = {
      challenge_id: registerOptions.challenge_id,
      attestation: encodeAttestation(credential),
      prf_salt: registerOptions.prf_salt,
      vk_wrap: vkWrap,
      name,
    };
    const body = JSON.stringify(request);

    // Step 5: the grant must still have >= 60 s before the first POST, and so must a renewed one.
    if (!grantHasMargin(grant, now())) {
      let renewed: ReauthGrant | null;
      try {
        renewed = await deps.grants.renewInPlace();
      } catch {
        return fail(isCurrent() ? 'reauth_cancelled' : 'stale');
      }
      // Same generation as the wrap: a lock during the renewal must not persist the pre-lock VK wrap.
      if (!isCurrent()) return fail('stale');
      if (!renewed || !grantHasMargin(renewed, now())) return fail('reauth_restart_required');
      grant = renewed;
    }
    if (!isCurrent()) return fail('stale');

    const result = await postWithReplay(deps, body, deps.createIdempotencyKey(), grant.grant);
    if (!isCurrent()) {
      // Obsolete completion: nothing reaches the UI. A confirmed saved credential is not an orphan.
      return result.kind === 'saved' ? { ok: false, error: 'stale', orphan: false } : fail('stale');
    }
    if (result.kind === 'saved') return { ok: true, passkey: result.passkey };
    if (result.kind === 'unknown') return fail('network_unknown');
    return fail('register_failed');
  } catch {
    return fail('register_failed');
  } finally {
    zeroize(pwk);
  }
}
