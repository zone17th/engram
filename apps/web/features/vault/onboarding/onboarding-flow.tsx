'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AppHeader } from '@/components/app-shell/app-header';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  checkPassphrasePolicy,
  type PassphrasePolicyReasonCode,
  type PassphraseScore,
} from '@/features/vault/passphrase-policy';
import {
  classifyCryptoError,
  useVault,
} from '@/features/vault/vault-provider';
import {
  createIdempotencyKey,
  createVault as postCreateVault,
  fetchVault,
  type VaultCreateRequest,
} from '@/lib/api/vault';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { RecoveryKeysSheet } from './recovery-keys-sheet';

export type OnboardingStep = 'passphrase' | 'passphrase-oom' | 'recovery-keys' | 'vault-exists' | 'done';

interface PreparedOnboardingBundle {
  /** Generation captured before `createVault` so any intervening lock invalidates the bundle. */
  opGeneration: number;
  /** User ID captured when the bundle was prepared so any account switch invalidates it. */
  userId: string | null;
  /** Display strings for the 10 recovery keys; wiped from state/DOM immediately when leaving step 2 or on 409. */
  displayRecoveryKeys: ReadonlyArray<{ slot: number; display: string }>;
  /** Exact serialized JSON body for `POST /vault` — reused byte-for-byte on retry with the same `idempotencyKey`. */
  requestBodyJson: string;
  /** Single UUID v4 `Idempotency-Key` generated once per user operation and reused across network retries. */
  idempotencyKey: string;
}
type Step2ErrorAlert =
  | { kind: 'network' }
  | { kind: 'in_progress' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'mutations_disabled' }
  | { kind: 'email_not_verified' }
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'generic'; detail?: string };

function strengthBarPercentage(score: PassphraseScore, hasInput: boolean): number {
  if (!hasInput) return 0;
  switch (score) {
    case 0:
      return 15;
    case 1:
      return 35;
    case 2:
      return 55;
    case 3:
      return 80;
    case 4:
      return 100;
  }
}

function strengthBarColor(score: PassphraseScore, hasInput: boolean): string {
  if (!hasInput) return 'var(--border)';
  if (score >= 3) return 'var(--success)';
  if (score === 2) return 'var(--warning)';
  return 'var(--error)';
}

export function VaultOnboardingFlow() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const { me, refetchMe } = useSession();
  const vault = useVault();

  const [step, setStep] = useState<OnboardingStep>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  const [policyScore, setPolicyScore] = useState<PassphraseScore>(0);
  const [meetsMinLength, setMeetsMinLength] = useState(false);
  const [meetsMinScore, setMeetsMinScore] = useState(false);
  const [step1Reason, setStep1Reason] = useState<PassphrasePolicyReasonCode | null>(null);
  const [derivingKeys, setDerivingKeys] = useState(false);

  const [preparedBundle, setPreparedBundle] = useState<PreparedOnboardingBundle | null>(null);
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [submittingVault, setSubmittingVault] = useState(false);
  const [step2Error, setStep2Error] = useState<Step2ErrorAlert | null>(null);

  const passInputRef = useRef<HTMLInputElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const evalSeqRef = useRef(0);
  const stepRef = useRef<OnboardingStep>(step);
  stepRef.current = step;
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const currentUserIdRef = useRef<string | null>(me?.user.id ?? null);
  currentUserIdRef.current = me?.user.id ?? null;
  const postSubmitSeqRef = useRef(0);
  const confirmCheckboxId = useId();
  const gridHeadingId = useId();

  const userInputs = useMemo(() => {
    const email = me?.user.email;
    if (!email) return [];
    const localPart = email.split('@')[0] ?? '';
    return [email, localPart].filter(Boolean);
  }, [me?.user.email]);

  const clearPassphraseFields = useCallback(() => {
    setPassphrase('');
    setConfirmPassphrase('');
    setPolicyScore(0);
    setMeetsMinLength(false);
    setMeetsMinScore(false);
    if (passInputRef.current) {
      passInputRef.current.value = '';
    }
    if (confirmInputRef.current) {
      confirmInputRef.current.value = '';
    }
  }, []);

  const clearRecoveryKeysAndSecrets = useCallback(() => {
    postSubmitSeqRef.current += 1;
    clearPassphraseFields();
    setPreparedBundle(null);
    setConfirmedSaved(false);
  }, [clearPassphraseFields]);
  // Register secret form reset with VaultProvider so any lock / logout / account switch wipes state synchronously.
  useEffect(() => {
    const currentVault = vaultRef.current;
    return currentVault.registerSecretFormReset(() => {
      clearRecoveryKeysAndSecrets();
      if (stepRef.current === 'recovery-keys') {
        setStep('passphrase');
      }
    });
  }, [clearRecoveryKeysAndSecrets]);

  // Wipe secrets and cancel clipboard timer when unmounting (leaving the onboarding route).
  useEffect(() => {
    return () => {
      clearRecoveryKeysAndSecrets();
    };
  }, [clearRecoveryKeysAndSecrets]);

  // Live NFC + lazy zxcvbn policy evaluation while typing in Step 1.
  useEffect(() => {
    if (step !== 'passphrase') return;

    const seq = ++evalSeqRef.current;
    if (passphrase.length === 0 && confirmPassphrase.length === 0) {
      setPolicyScore(0);
      setMeetsMinLength(false);
      setMeetsMinScore(false);
      return;
    }

    void checkPassphrasePolicy(passphrase, {
      confirmPassphrase,
      userInputs,
    })
      .then((res) => {
        if (evalSeqRef.current !== seq) return;
        setPolicyScore(res.score);
        setMeetsMinLength(res.meetsMinLength);
        setMeetsMinScore(res.meetsMinScore);
      })
      .catch(() => undefined);
  }, [confirmPassphrase, passphrase, step, userInputs]);

  const strengthLabel = useMemo(() => {
    if (passphrase.length === 0) return t('step1.strength.empty');
    switch (policyScore) {
      case 0:
        return t('step1.strength.veryWeak');
      case 1:
        return t('step1.strength.weak');
      case 2:
        return t('step1.strength.fair');
      case 3:
        return t('step1.strength.good');
      case 4:
        return t('step1.strength.strong');
    }
  }, [passphrase.length, policyScore, t]);

  const step1ErrorText = useMemo(() => {
    if (!step1Reason || step1Reason === 'ok') return null;
    switch (step1Reason) {
      case 'empty':
        return t('step1.errors.empty');
      case 'too_short':
        return t('step1.errors.tooShort');
      case 'too_weak':
        return t('step1.errors.tooWeak');
      case 'mismatch':
        return t('step1.errors.mismatch');
      case 'invalid_unicode':
        return t('step1.errors.invalidUnicode');
    }
  }, [step1Reason, t]);

  const handleStep1Submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (derivingKeys || vault.inFlight) return;

      setStep1Reason(null);
      setStep2Error(null);

      // Capture immutable opGeneration and userId BEFORE the first await (ADR 0002 §10.2).
      const client = vault.getClient();
      const opGeneration = client.captureGeneration();
      const opUserId = currentUserIdRef.current;
      const policy = await checkPassphrasePolicy(passphrase, {
        confirmPassphrase,
        userInputs,
      });

      setPolicyScore(policy.score);
      setMeetsMinLength(policy.meetsMinLength);
      setMeetsMinScore(policy.meetsMinScore);

      if (!policy.valid) {
        setStep1Reason(policy.reason);
        return;
      }

      if (client.getGeneration() !== opGeneration) {
        clearPassphraseFields();
        return;
      }

      const passphraseSnapshot = passphrase;
      // Clear passphrase inputs immediately on submit before sending to Worker (ADR 0002 §11).
      clearPassphraseFields();
      setDerivingKeys(true);

      try {
        const created = await vault.createVault({
          passphrase: passphraseSnapshot,
          opGeneration,
        });

        if (client.getGeneration() !== opGeneration || currentUserIdRef.current !== opUserId) {
          return;
        }

        const requestPayload: VaultCreateRequest = {
          kdf: created.kdf,
          vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
          x25519_public: created.x25519_public,
          ed25519_public: created.ed25519_public,
          private_keys_wrapped: created.private_keys_wrapped,
          recovery_keys: created.recovery_keys.map((rk) => ({
            slot: rk.slot,
            lookup_hash: rk.lookup_hash,
            wrap: rk.wrap,
          })),
        };

        // Generate ONE Idempotency-Key (UUID v4) and freeze the exact JSON request bytes for this operation (ADR 0002 §8.4).
        const idempotencyKey = createIdempotencyKey();
        const requestBodyJson = JSON.stringify(requestPayload);

        setPreparedBundle({
          opGeneration,
          userId: opUserId,
          displayRecoveryKeys: created.recovery_keys.map((rk) => ({
            slot: rk.slot,
            display: rk.display,
          })),
          requestBodyJson,
          idempotencyKey,
        });
        setConfirmedSaved(false);
        setStep2Error(null);
        setStep('recovery-keys');
      } catch (err) {
        const classified = classifyCryptoError(err);
        if (classified.kind === 'insufficient_memory') {
          setStep('passphrase-oom');
          return;
        }
        if (classified.kind === 'passphrase_invalid') {
          setStep1Reason('invalid_unicode');
          return;
        }
        if (classified.kind === 'recovering_locked_to_whitelist') {
          await vault.lock({ broadcast: false, reason: 'onboarding_switch_from_recovering' });
          return;
        }
      } finally {
        setDerivingKeys(false);
      }
    },
    [clearPassphraseFields, confirmPassphrase, derivingKeys, passphrase, userInputs, vault],
  );

  const handleBackToStep1 = useCallback(async () => {
    clearRecoveryKeysAndSecrets();
    setStep2Error(null);
    await vault.lock({ broadcast: false, reason: 'onboarding_back_to_step1' });
    setStep('passphrase');
  }, [clearRecoveryKeysAndSecrets, vault]);

  const handleCreateVaultSubmit = useCallback(async () => {
    // Hard guard: never POST /vault before the user ticks the confirmation checkbox.
    if (!confirmedSaved || !preparedBundle || submittingVault) {
      return;
    }

    const client = vault.getClient();
    const currentUserId = currentUserIdRef.current;
    if (
      client.getGeneration() !== preparedBundle.opGeneration ||
      (preparedBundle.userId !== null && currentUserId !== preparedBundle.userId)
    ) {
      clearRecoveryKeysAndSecrets();
      setStep2Error(null);
      setStep('passphrase');
      return;
    }

    const submitBundle = preparedBundle;
    const submitSeq = ++postSubmitSeqRef.current;
    setSubmittingVault(true);
    setStep2Error(null);

    try {
      const response = await postCreateVault(submitBundle.requestBodyJson, {
        idempotencyKey: submitBundle.idempotencyKey,
      });

      if (
        postSubmitSeqRef.current !== submitSeq ||
        client.getGeneration() !== submitBundle.opGeneration ||
        (submitBundle.userId !== null && currentUserIdRef.current !== submitBundle.userId)
      ) {
        // Server committed vault A while the tab locked, went back, or started deriving vault B:
        // never pair vault A's server state with a newer Worker key; lock so the user unlocks vault A cleanly.
        clearRecoveryKeysAndSecrets();
        await vault.lock({ broadcast: false, reason: 'stale_onboarding_post_succeeded' });
        await refetchMe().catch(() => undefined);
        router.replace('/app/unlock');
        return;
      }

      // Immediately wipe the 10 display RKs from React state and DOM once POST /vault succeeds.
      clearRecoveryKeysAndSecrets();
      setStep('done');

      vault.notifyVaultChanged({
        vault_key_id: response.vault_key_id,
        version: response.version,
      });

      await refetchMe();
      router.replace('/app');
    } catch (err) {
      if (
        postSubmitSeqRef.current !== submitSeq ||
        client.getGeneration() !== submitBundle.opGeneration ||
        (submitBundle.userId !== null && currentUserIdRef.current !== submitBundle.userId)
      ) {
        return;
      }
      if (err instanceof ProblemError) {
        const { code, status } = err.problem;
        if (status === 409 && code === 'vault_exists') {
          // 409 vault_exists: immediately wipe generated RKs from state/DOM and lock the temporary Worker key.
          clearRecoveryKeysAndSecrets();
          await vault.lock({ broadcast: false, reason: 'vault_exists_elsewhere' });
          setStep('vault-exists');
          return;
        }
        if (status === 409 && code === 'idempotency_in_progress') {
          setStep2Error({ kind: 'in_progress' });
          return;
        }
        if (status === 409 && code === 'idempotency_conflict') {
          // ADR 0002 §8.4: retire the rejected Idempotency-Key so retries never reuse the conflicted key,
          // and reconcile server state via GET /vault first.
          setPreparedBundle((prev) =>
            prev ? { ...prev, idempotencyKey: createIdempotencyKey() } : null,
          );
          try {
            await fetchVault();
            if (
              postSubmitSeqRef.current !== submitSeq ||
              client.getGeneration() !== submitBundle.opGeneration ||
              (submitBundle.userId !== null && currentUserIdRef.current !== submitBundle.userId)
            ) {
              return;
            }
            clearRecoveryKeysAndSecrets();
            await vault.lock({ broadcast: false, reason: 'vault_exists_after_conflict' });
            setStep('vault-exists');
            return;
          } catch (reconcileErr) {
            if (
              postSubmitSeqRef.current !== submitSeq ||
              client.getGeneration() !== submitBundle.opGeneration ||
              (submitBundle.userId !== null && currentUserIdRef.current !== submitBundle.userId)
            ) {
              return;
            }
            // If GET /vault returns 404 vault_absent (or fails transiently), stay on Step 2
            // with the retired Idempotency-Key so the user can retry without locking the prepared Worker key.
            void reconcileErr;
          }
          setStep2Error({ kind: 'idempotency_conflict' });
          return;
        }
        if (status === 503 || code === 'vault_mutations_disabled') {
          setStep2Error({ kind: 'mutations_disabled' });
          return;
        }
        if (status === 403 && code === 'email_not_verified') {
          setStep2Error({ kind: 'email_not_verified' });
          return;
        }
        if (status === 429 || code === 'rate_limited') {
          const seconds = normalizeRetryAfter(err.problem.retry_after) ?? 60;
          setStep2Error({ kind: 'rate_limited', seconds });
          return;
        }
        setStep2Error({
          kind: 'generic',
          detail: err.problem.detail ?? err.problem.title,
        });
        return;
      }

      // Network / fetch failure: keep `preparedBundle` (same `idempotencyKey` and `requestBodyJson`) for retry.
      setStep2Error({ kind: 'network' });
    } finally {
      if (postSubmitSeqRef.current === submitSeq) {
        setSubmittingVault(false);
      }
    }
  }, [
    clearRecoveryKeysAndSecrets,
    confirmedSaved,
    preparedBundle,
    refetchMe,
    router,
    submittingVault,
    vault,
  ]);
  const handleGoToUnlock = useCallback(async () => {
    clearRecoveryKeysAndSecrets();
    await refetchMe().catch(() => undefined);
    router.replace('/app/unlock');
  }, [clearRecoveryKeysAndSecrets, refetchMe, router]);

  const isStep1Active = step === 'passphrase' || step === 'passphrase-oom';
  const isStep2Active = step === 'recovery-keys' || step === 'vault-exists';
  const barWidth = strengthBarPercentage(policyScore, passphrase.length > 0);
  const barColor = strengthBarColor(policyScore, passphrase.length > 0);

  return (
    <>
      <AppHeader vault={{ state: 'absent' }} showLogout />
      <main className="mx-auto max-w-[640px] px-5 pt-10 pb-24">
        {/* Stepper matching mockups/onboarding.html */}
        <nav aria-label={t('stepperLabel')} className="mb-8 flex items-center gap-3">
          <div className="seg flex-wrap" data-seg>
            <button
              type="button"
              aria-current={isStep1Active ? 'step' : undefined}
              aria-pressed={isStep1Active}
              disabled
            >
              {t('steps.passphrase')}
            </button>
            <button
              type="button"
              aria-current={isStep2Active ? 'step' : undefined}
              aria-pressed={isStep2Active}
              disabled
            >
              {t('steps.recoveryKeys')}
            </button>
            <button
              type="button"
              aria-pressed={false}
              disabled
            >
              {t('steps.passkey')}
            </button>
          </div>
        </nav>

        {/* STEP 1 — Set vault passphrase */}
        {step === 'passphrase' ? (
          <section data-view="pp" data-testid="onboarding-step-passphrase">
            <h1 className="t-title-lg mb-2 text-ink">{t('step1.title')}</h1>
            <p className="t-body-lg mb-6 text-muted">
              {t('step1.leadPrefix')}
              <strong className="text-body">{t('step1.leadStrong1')}</strong>
              {t('step1.leadMiddle')}
              <strong className="text-body">{t('step1.leadStrong2')}</strong>
              {t('step1.leadSuffix')}
            </p>

            <form onSubmit={handleStep1Submit} noValidate>
              <div className="card mb-4 p-6">
                <div className="mb-3">
                  <Field
                    ref={passInputRef}
                    id="onboarding-passphrase"
                    type="password"
                    label={t('step1.passphraseLabel')}
                    autoComplete="new-password"
                    value={passphrase}
                    disabled={derivingKeys || vault.inFlight}
                    passwordToggleLabels={{
                      show: t('step1.showPassphrase'),
                      hide: t('step1.hidePassphrase'),
                    }}
                    error={
                      step1Reason === 'empty' ||
                      step1Reason === 'too_short' ||
                      step1Reason === 'too_weak' ||
                      step1Reason === 'invalid_unicode'
                        ? (step1ErrorText ?? undefined)
                        : undefined
                    }
                    onChange={(e) => {
                      setPassphrase(e.target.value);
                      if (step1Reason) setStep1Reason(null);
                    }}
                    data-vault-secret="true"
                  />
                </div>

                {/* Strength meter */}
                <div
                  className="mb-5 flex items-center gap-2"
                  role="region"
                  aria-label={t('step1.strengthMeterLabel')}
                >
                  <div
                    className="flex-1 overflow-hidden"
                    style={{
                      height: '4px',
                      borderRadius: 'var(--r-pill)',
                      background: 'var(--border)',
                    }}
                  >
                    <div
                      data-testid="passphrase-strength-bar"
                      data-score={policyScore}
                      style={{
                        height: '4px',
                        width: `${barWidth}%`,
                        borderRadius: 'var(--r-pill)',
                        background: barColor,
                        transition: 'width 120ms ease-out',
                      }}
                    />
                  </div>
                  <span
                    data-testid="passphrase-strength-label"
                    className="text-[12px]"
                    style={{ color: 'var(--body)' }}
                  >
                    {strengthLabel}
                  </span>
                </div>

                <div className="mb-5">
                  <Field
                    ref={confirmInputRef}
                    id="onboarding-confirm-passphrase"
                    type="password"
                    label={t('step1.confirmLabel')}
                    autoComplete="new-password"
                    value={confirmPassphrase}
                    disabled={derivingKeys || vault.inFlight}
                    passwordToggleLabels={{
                      show: t('step1.showPassphrase'),
                      hide: t('step1.hidePassphrase'),
                    }}
                    error={step1Reason === 'mismatch' ? (step1ErrorText ?? undefined) : undefined}
                    onChange={(e) => {
                      setConfirmPassphrase(e.target.value);
                      if (step1Reason) setStep1Reason(null);
                    }}
                    data-vault-secret="true"
                  />
                </div>

                <ul
                  className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]"
                  style={{ color: 'var(--muted)' }}
                >
                  <li data-testid="rule-min-length" data-satisfied={meetsMinLength}>
                    <span style={{ color: meetsMinLength ? 'var(--success)' : 'var(--body)' }}>
                      ✓
                    </span>{' '}
                    {t('step1.rules.minLength')}
                  </li>
                  <li data-testid="rule-distinct-login">
                    <span style={{ color: 'var(--body)' }}>✓</span>{' '}
                    {t('step1.rules.distinctFromLogin')}
                  </li>
                  <li data-testid="rule-min-score" data-satisfied={meetsMinScore}>
                    <span style={{ color: meetsMinScore ? 'var(--success)' : 'var(--body)' }}>
                      ✓
                    </span>{' '}
                    {t('step1.rules.minScore')}
                  </li>
                </ul>
              </div>

              <div
                className="mb-6 rounded-md p-4"
                style={{ background: 'var(--pale-orange)' }}
              >
                <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                  {t('step1.warningBanner')}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href="/app/settings" className="btn btn-tertiary no-underline">
                  {t('settings')}
                </Link>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={derivingKeys || vault.inFlight}
                  data-testid="onboarding-continue-button"
                >
                  {derivingKeys ? t('step1.deriving') : t('step1.continue')}
                </Button>
              </div>
            </form>
          </section>
        ) : null}

        {/* STEP 1B — Insufficient memory (Argon2id 64 MiB OOM) */}
        {step === 'passphrase-oom' ? (
          <section data-view="pp-oom" id="onboard-oom" data-testid="onboarding-step-oom">
            <h1 className="t-title-lg mb-2 text-ink">{t('step1.title')}</h1>
            <div className="card mb-4 p-5" style={{ borderColor: 'var(--error)' }}>
              <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                {t('step1.oom.badge')}
              </p>
              <div role="alert" className="auth-alert mb-4">
                <p
                  className="m-0 mb-1 text-[14px] font-semibold"
                  style={{ color: 'var(--body)' }}
                >
                  {t('step1.oom.title')}
                </p>
                <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                  {t('step1.oom.body')}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep('passphrase')}
                data-testid="onboarding-oom-retry"
              >
                {t('step1.oom.retry')}
              </Button>
            </div>
          </section>
        ) : null}

        {/* STEP 2 — 10 Recovery Keys Grid */}
        {step === 'recovery-keys' && preparedBundle ? (
          <section data-view="rk" data-testid="onboarding-step-recovery-keys">
            <h1 id={gridHeadingId} className="t-title-lg mb-2 text-ink">
              {t('step2.title')}
            </h1>
            <p className="t-body-lg mb-4 text-muted">{t('step2.lead')}</p>
            <RecoveryKeysSheet
              keys={preparedBundle.displayRecoveryKeys}
              accountEmail={me?.user.email}
              confirmedSaved={confirmedSaved}
              onConfirmedSavedChange={setConfirmedSaved}
              disabled={submittingVault}
              checkboxId={confirmCheckboxId}
              labels={{
                gridLabel: t('step2.gridLabel'),
                slotLabel: (slot) => t('step2.slotLabel', { slot }),
                gridCaption: t('step2.gridCaption'),
                screenshotWarningStrong: t('step2.screenshotWarningStrong'),
                screenshotWarningBody: t('step2.screenshotWarningBody'),
                downloadTxt: t('step2.downloadTxt'),
                print: t('step2.print'),
                copyAll: t('step2.copyAll'),
                downloadedStatus: t('step2.downloadedStatus'),
                printedStatus: t('step2.printedStatus'),
                copiedStatus: t('step2.copiedStatus'),
                confirmSavedLabel: t('step2.confirmSavedLabel'),
              }}
            />

            {/* Error alert on POST /vault failure (network / 429 / 503 / etc.) */}
            {step2Error ? (
              <div
                role="alert"
                className="auth-alert mb-5"
                data-testid="onboarding-step2-error"
              >
                <p
                  className="m-0 mb-1 text-[14px] font-semibold"
                  style={{ color: 'var(--body)' }}
                >
                  {step2Error.kind === 'network' && t('errors.networkTitle')}
                  {step2Error.kind === 'in_progress' && t('errors.inProgressTitle')}
                  {step2Error.kind === 'idempotency_conflict' && t('errors.conflictTitle')}
                  {step2Error.kind === 'mutations_disabled' &&
                    t('errors.mutationsDisabledTitle')}
                  {step2Error.kind === 'email_not_verified' &&
                    t('errors.emailNotVerifiedTitle')}
                  {step2Error.kind === 'rate_limited' && t('errors.rateLimitedTitle')}
                  {step2Error.kind === 'generic' && t('errors.genericTitle')}
                </p>
                <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                  {step2Error.kind === 'network' && t('errors.networkBody')}
                  {step2Error.kind === 'in_progress' && t('errors.inProgressBody')}
                  {step2Error.kind === 'idempotency_conflict' && t('errors.conflictBody')}
                  {step2Error.kind === 'mutations_disabled' &&
                    t('errors.mutationsDisabledBody')}
                  {step2Error.kind === 'email_not_verified' &&
                    t('errors.emailNotVerifiedBody')}
                  {step2Error.kind === 'rate_limited' &&
                    t('errors.rateLimitedBody', { seconds: step2Error.seconds })}
                  {step2Error.kind === 'generic' &&
                    (step2Error.detail ?? t('errors.genericBody'))}
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="tertiary"
                disabled={submittingVault}
                onClick={() => void handleBackToStep1()}
                data-testid="onboarding-back-button"
              >
                {t('step2.back')}
              </Button>
              <Button
                type="button"
                variant="primary"
                className="ml-auto"
                id="createVault"
                disabled={!confirmedSaved || submittingVault}
                onClick={() => void handleCreateVaultSubmit()}
                data-testid="onboarding-create-vault-button"
              >
                {submittingVault ? t('step2.creatingVault') : t('step2.createVault')}
              </Button>
            </div>
            <p className="t-caption mt-3 mb-0" style={{ color: 'var(--muted)' }}>
              {t('step2.disabledHint')}
            </p>
          </section>
        ) : null}

        {/* STEP 2B — 409 vault_exists (RK grid immediately removed from DOM) */}
        {step === 'vault-exists' ? (
          <section
            data-view="rk-exists"
            id="onboard-vault-exists"
            data-testid="onboarding-step-vault-exists"
          >
            <h1 className="t-title-lg mb-4 text-ink">{t('vaultExists.title')}</h1>
            <div className="card mb-4 p-5" style={{ borderColor: 'var(--error)' }}>
              <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                {t('vaultExists.badge')}
              </p>
              <div role="alert" className="auth-alert mb-4">
                <p
                  className="m-0 mb-1 text-[14px] font-semibold"
                  style={{ color: 'var(--body)' }}
                >
                  {t('vaultExists.title')}
                </p>
                <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                  {t('vaultExists.bodyPrefix')}
                  <strong>{t('vaultExists.bodyStrong')}</strong>
                  {t('vaultExists.bodySuffix')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void handleGoToUnlock()}
                  data-testid="onboarding-go-to-unlock"
                >
                  {t('vaultExists.goToUnlock')}
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}
