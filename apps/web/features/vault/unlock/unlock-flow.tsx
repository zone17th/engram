'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppHeader } from '@/components/app-shell/app-header';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  classifyCryptoError,
  useVault,
} from '@/features/vault/vault-provider';
import { formatRetryClock, normalizeRetryAfter } from '@/lib/auth/retry-after';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';
import { CryptoClientError } from '@/lib/crypto/client';
import { hasLoneSurrogate } from '@/lib/crypto/protocol';
import {
  clearRecoveryCompletedNotice,
  hasRecoveryCompletedNotice,
} from './recovery-notice';
import { PasskeyUnlockButton } from '@/features/vault/passkey/passkey-unlock-button';
import { Callout } from '@/components/ui/callout';

export type UnlockErrorState =
  | { kind: 'empty' }
  | { kind: 'incorrect_passphrase' }
  | { kind: 'passphrase_invalid' }
  | { kind: 'private_keys_wrap_invalid' }
  | { kind: 'insufficient_memory' }
  | { kind: 'busy' }
  | { kind: 'recovering' }
  | { kind: 'rate_limited'; initialSeconds: number }
  | { kind: 'session_expired' }
  | { kind: 'network'; detail?: string };

export function VaultUnlockFlow() {
  const t = useTranslations('unlock');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { me, signOut } = useSession();
  const vault = useVault();

  const [passphrase, setPassphrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<UnlockErrorState | null>(null);
  const [rateLimitDeadline, setRateLimitDeadline] = useState<number | null>(null);
  // FE1-7: recovery that committed while its tab locked hands this notice over through sessionStorage (route change).
  const [recoveredNotice, setRecoveredNotice] = useState(false);
  const meUserId = me?.user.id ?? null;

  const passInputRef = useRef<HTMLInputElement>(null);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const isMountedRef = useRef(true);
  const unlockIntentSeqRef = useRef(0);
  const activeWorkerUnlockOpGenRef = useRef<number | null>(null);
  const completedNavigationRef = useRef(false);
  // FE1-4: an async failure re-enables the form after it had been disabled while pending; focus must come back to it.
  const refocusPassphraseAfterErrorRef = useRef(false);
  const countdownSeconds = useRetryCountdown(rateLimitDeadline);
  const isRateLimitedActive =
    errorState?.kind === 'rate_limited' && rateLimitDeadline !== null && countdownSeconds > 0;

  const returnToParam = searchParams.get('returnTo');
  const destinationPath = sanitizeReturnTo(returnToParam, '/app');

  const clearPassphraseField = useCallback(() => {
    setPassphrase('');
    if (passInputRef.current) {
      passInputRef.current.value = '';
    }
  }, []);

  useEffect(() => {
    setRecoveredNotice(hasRecoveryCompletedNotice(meUserId));
  }, [meUserId]);

  // Register secret form reset with VaultProvider so any lock / logout / account switch wipes state synchronously.
  useEffect(() => {
    return vault.registerSecretFormReset(() => {
      clearPassphraseField();
    });
  }, [clearPassphraseField, vault]);

  // Wipe passphrase input and retire any pending unlock intent when leaving the unlock route (BE2-13).
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      unlockIntentSeqRef.current += 1;
      clearPassphraseField();
      const pendingOpGen = activeWorkerUnlockOpGenRef.current;
      activeWorkerUnlockOpGenRef.current = null;
      if (pendingOpGen !== null && !completedNavigationRef.current) {
        const client = vaultRef.current.getClient();
        if (client.getGeneration() === pendingOpGen) {
          void vaultRef.current.lock({ broadcast: false, reason: 'unlock_route_unmounted' });
        }
      }
    };
  }, [clearPassphraseField]);
  const handleUnlockSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting || vault.inFlight || isRateLimitedActive) return;

      setErrorState(null);
      setRateLimitDeadline(null);

      if (passphrase.length === 0) {
        setErrorState({ kind: 'empty' });
        queueMicrotask(() => passInputRef.current?.focus());
        return;
      }

      if (hasLoneSurrogate(passphrase)) {
        clearPassphraseField();
        setErrorState({ kind: 'passphrase_invalid' });
        queueMicrotask(() => passInputRef.current?.focus());
        return;
      }

      // Capture immutable opGeneration AND durable lockEpoch baseline at intent start BEFORE GET /vault (BE2-1, ADR 0003 §8.4).
      const { opGeneration, client } = vault.beginOp();
      const intentSeq = ++unlockIntentSeqRef.current;

      let passphraseSnapshot: string | null = passphrase;
      // Clear the passphrase input field immediately before async work (ADR 0002 §11).
      clearPassphraseField();
      setSubmitting(true);

      try {
        const meta = await vault.reloadVaultMeta();
        if (
          !meta ||
          !isMountedRef.current ||
          unlockIntentSeqRef.current !== intentSeq ||
          client.getGeneration() !== opGeneration
        ) {
          passphraseSnapshot = null;
          return;
        }

        const passToUse = passphraseSnapshot;
        passphraseSnapshot = null;
        activeWorkerUnlockOpGenRef.current = opGeneration;
        await vault.unlockPassphrase({
          passphrase: passToUse,
          kdf: meta.kdf,
          vaultKeyWrappedByKek: meta.vault_key_wrapped_by_kek,
          privateKeysWrapped: meta.private_keys_wrapped,
          opGeneration,
        });

        if (
          !isMountedRef.current ||
          unlockIntentSeqRef.current !== intentSeq ||
          client.getGeneration() !== opGeneration
        ) {
          if (client.getGeneration() === opGeneration) {
            activeWorkerUnlockOpGenRef.current = null;
            await vault.lock({ broadcast: false, reason: 'unlock_intent_abandoned' });
          }
          return;
        }

        completedNavigationRef.current = true;
        activeWorkerUnlockOpGenRef.current = null;
        clearRecoveryCompletedNotice();
        router.replace(destinationPath);
      } catch (err) {
        passphraseSnapshot = null;
        if (!isMountedRef.current || unlockIntentSeqRef.current !== intentSeq) {
          return;
        }
        if (err instanceof ProblemError) {
          const { status, code, retry_after } = err.problem;
          if (status === 429 || code === 'rate_limited') {
            const seconds = normalizeRetryAfter(retry_after, 60);
            setRateLimitDeadline(Date.now() + seconds * 1000);
            setErrorState({ kind: 'rate_limited', initialSeconds: seconds });
            return;
          }
          if (status === 401 || code === 'session_invalid') {
            setErrorState({ kind: 'session_expired' });
            return;
          }
          refocusPassphraseAfterErrorRef.current = true;
          setErrorState({
            kind: 'network',
            detail: err.problem.detail ?? err.problem.title,
          });
          return;
        }

        const classified = classifyCryptoError(err);
        if (classified.code === 'PRIVATE_KEYS_WRAP_INVALID') {
          refocusPassphraseAfterErrorRef.current = true;
          setErrorState({ kind: 'private_keys_wrap_invalid' });
          return;
        }

        switch (classified.kind) {
          case 'wrong_passphrase':
            refocusPassphraseAfterErrorRef.current = true;
            setErrorState({ kind: 'incorrect_passphrase' });
            return;
          case 'passphrase_invalid':
            refocusPassphraseAfterErrorRef.current = true;
            setErrorState({ kind: 'passphrase_invalid' });
            return;
          case 'insufficient_memory':
            refocusPassphraseAfterErrorRef.current = true;
            setErrorState({ kind: 'insufficient_memory' });
            return;
          case 'busy':
            // CLIENT_BUSY is NEVER shown as wrong passphrase.
            refocusPassphraseAfterErrorRef.current = true;
            setErrorState({ kind: 'busy' });
            return;
          case 'recovering_locked_to_whitelist':
            // VAULT_RECOVERING requires lock() first to switch flows.
            setErrorState({ kind: 'recovering' });
            return;
          case 'stale_generation':
            return;
          default:
            refocusPassphraseAfterErrorRef.current = true;
            if (err instanceof CryptoClientError) {
              setErrorState({ kind: 'network', detail: err.message });
              return;
            }
            setErrorState({ kind: 'network' });
        }
      } finally {
        activeWorkerUnlockOpGenRef.current = null;
        if (isMountedRef.current && unlockIntentSeqRef.current === intentSeq) {
          setSubmitting(false);
        }
      }
    },
    [
      clearPassphraseField,
      destinationPath,
      isRateLimitedActive,
      passphrase,
      router,
      submitting,
      vault,
    ],
  );

  // FE1-4: restore keyboard focus to the passphrase field once the pending state that disabled it has cleared.
  const formUsable = !submitting && !vault.inFlight && !isRateLimitedActive;
  useEffect(() => {
    if (!refocusPassphraseAfterErrorRef.current || errorState === null || !formUsable) return;
    refocusPassphraseAfterErrorRef.current = false;
    passInputRef.current?.focus();
  }, [errorState, formUsable]);

  const handleLockAndSwitchFromRecovering = useCallback(async () => {
    setErrorState(null);
    await vault.lock({ broadcast: false, reason: 'unlock_switch_from_recovering' });
  }, [vault]);

  const effectiveRateLimitSeconds =
    errorState?.kind === 'rate_limited'
      ? Math.max(1, countdownSeconds || errorState.initialSeconds)
      : 0;

  return (
    <>
      <AppHeader vault={{ state: 'locked' }} showLogout />
      <main
        className="mx-auto max-w-[560px] px-5 pt-10 pb-24"
        data-testid="vault-unlock-page"
      >
        {recoveredNotice ? (
          <div
            role="status"
            className="card mb-6 p-5 border-success"
            data-testid="unlock-recovered-notice"
          >
            <p className="m-0 mb-1 text-[14px] font-semibold text-body">
              {t('recoveredNoticeTitle')}
            </p>
            <p className="m-0 text-[13px] text-muted">
              {t('recoveredNoticeBody')}
            </p>
          </div>
        ) : null}
        <p
          className="t-label mb-2 min-w-0 max-w-full break-words text-muted [overflow-wrap:anywhere]"
          style={{ overflowWrap: 'anywhere' }}
          data-testid="unlock-signed-in-line"
        >
          {me?.user.email
            ? t('signedInAs', { email: me.user.email })
            : t('signedInGeneric')}
        </p>
        <h1 className="t-title-lg mb-2 text-ink">{t('title')}</h1>
        <p className="t-body-lg mb-7 text-muted">
          {t('lead')}
        </p>

        {/* P03-T19: passkey card first (mockups/unlock.html view B); renders nothing when the user has no passkey. */}
        <PasskeyUnlockButton
          onUnlocked={() => {
            completedNavigationRef.current = true;
            clearRecoveryCompletedNotice();
            router.replace(destinationPath);
          }}
        />

        <section data-view="new" data-testid="unlock-passphrase-section">
          <form onSubmit={handleUnlockSubmit} noValidate>
            <div className="card mb-4 p-6">
              <div className="mb-5">
                <Field
                  ref={passInputRef}
                  id="unlock-passphrase"
                  type="password"
                  label={t('passphraseLabel')}
                  hint={t('passphraseHint')}
                  autoComplete="current-password"
                  value={passphrase}
                  disabled={submitting || vault.inFlight || isRateLimitedActive}
                  passwordToggleLabels={{
                    show: t('showPassphrase'),
                    hide: t('hidePassphrase'),
                  }}
                  error={errorState?.kind === 'empty' ? t('errors.empty') : undefined}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    if (errorState?.kind === 'empty') {
                      setErrorState(null);
                    }
                  }}
                  data-vault-secret="true"
                  data-testid="unlock-passphrase-input"
                />
              </div>
              {/* FE1-3: "Remember this device" checkbox is hidden until T18 (WebAuthn PRF + DevKey) implements device persistence. */}
              <Button
                type="submit"
                variant="primary"
                className="w-full !justify-center"
                disabled={submitting || vault.inFlight || isRateLimitedActive}
                data-testid="unlock-submit-button"
              >
                {submitting ? t('submitting') : t('submit')}
              </Button>
              <p
                className="t-caption mt-3 mb-0 text-center text-muted"
              >
                {t('caption')}
              </p>
            </div>
          </form>

          {/* Error states matching mockups/unlock.html — at most 1 role="alert" at a time */}
          {errorState?.kind === 'incorrect_passphrase' ? (
            <div
              className="card mb-4 p-5 card-error"
              id="err-passphrase-aead"
              data-testid="unlock-error-incorrect-passphrase"
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="badge-type badge-json"
                >
                  {t('errors.incorrectPassphraseBadge')}
                </span>
              </div>
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.incorrectPassphraseTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.incorrectPassphraseBody')}
                </p>
              </div>
            </div>
          ) : null}

          {errorState?.kind === 'insufficient_memory' ? (
            <Callout
              tone="error"
              id="err-insufficient-memory"
              data-testid="unlock-error-insufficient-memory"
              className="mb-4"
              label={t('errors.oomBadge')}
            >
              <div role="alert" className="auth-alert">
                <p
                  className="m-0 mb-1 text-[14px] font-semibold text-body"
                >
                  {t('errors.oomTitle')}
                </p>
                <p className="m-0 text-[13px] text-body">
                  {t('errors.oomBodyPrefix')}
                  <strong>{t('errors.oomBodyStrong')}</strong>
                  {t('errors.oomBodySuffix')}
                </p>
              </div>
            </Callout>
          ) : null}

          {errorState?.kind === 'passphrase_invalid' ? (
            <div
              className="card mb-4 p-5 card-error"
              data-testid="unlock-error-passphrase-invalid"
            >
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.invalidUnicodeTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.invalidUnicodeBody')}
                </p>
              </div>
            </div>
          ) : null}

          {errorState?.kind === 'private_keys_wrap_invalid' ? (
            <div
              className="card mb-4 p-5 card-error"
              data-testid="unlock-error-private-keys-wrap-invalid"
            >
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.privateKeysWrapInvalidTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.privateKeysWrapInvalidBody')}
                </p>
              </div>
            </div>
          ) : null}

          {errorState?.kind === 'busy' ? (
            <div
              className="card mb-4 p-5 card-warning"
              data-testid="unlock-error-busy"
            >
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.busyTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.busyBody')}
                </p>
              </div>
            </div>
          ) : null}

          {errorState?.kind === 'recovering' ? (
            <div
              className="card mb-4 p-5 card-warning"
              data-testid="unlock-error-recovering"
            >
              <div role="alert" className="mb-3">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.recoveringTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.recoveringBody')}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleLockAndSwitchFromRecovering()}
                data-testid="unlock-recovering-lock-button"
              >
                {t('errors.recoveringLockCta')}
              </Button>
            </div>
          ) : null}

          {errorState?.kind === 'rate_limited' ? (
            <Callout
              tone="warning"
              id="err-rate-limited"
              data-testid="unlock-error-rate-limited"
              className="mb-4"
              label={t('errors.rateLimitedBadge', { seconds: effectiveRateLimitSeconds })}
            >
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.rateLimitedTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.rateLimitedBody', {
                    clock: formatRetryClock(effectiveRateLimitSeconds),
                    seconds: effectiveRateLimitSeconds,
                  })}
                </p>
              </div>
            </Callout>
          ) : null}

          {errorState?.kind === 'session_expired' ? (
            <div
              className="card mb-4 p-5"
              id="err-session-expired"
              data-testid="unlock-error-session-expired"
            >
              <p className="t-label mb-2 text-muted">
                {t('errors.sessionExpiredBadge')}
              </p>
              <div role="alert" className="mb-3">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.sessionExpiredTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {t('errors.sessionExpiredBody')}
                </p>
              </div>
              <Link
                href="/app/auth/login"
                className="btn btn-primary no-underline"
                data-testid="unlock-session-expired-login"
              >
                {t('errors.sessionExpiredCta')}
              </Link>
            </div>
          ) : null}

          {errorState?.kind === 'network' ? (
            <div
              className="card mb-4 p-5 card-error"
              data-testid="unlock-error-network"
            >
              <div role="alert">
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {t('errors.networkTitle')}
                </p>
                <p className="m-0 text-[13px] text-muted">
                  {errorState.detail ?? t('errors.networkBody')}
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              href="/app/unlock/forgot"
              className="text-[14px]"
              data-testid="unlock-forgot-passphrase-link"
            >
              {t('forgotPassphrase')}
            </Link>
            <button
              type="button"
              onClick={() => void signOut()}
              className="cursor-pointer border-0 bg-transparent p-0 text-[14px]"
              style={{ color: 'var(--muted)' }}
              data-testid="unlock-sign-out-button"
            >
              {t('signOut')}
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
