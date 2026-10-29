'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AppHeader } from '@/components/app-shell/app-header';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { RecoveryKeysSheet } from '@/features/vault/onboarding';
import {
  checkPassphrasePolicy,
  type PassphrasePolicyReasonCode,
  type PassphraseScore,
} from '@/features/vault/passphrase-policy';
import {
  classifyCryptoError,
  useVault,
} from '@/features/vault/vault-provider';
import type { ReauthAction, ReauthGrant } from '@/lib/api/auth';
import {
  completeRecovery,
  createIdempotencyKey,
  fetchRecoveryKeysStatus,
  formatVaultIfMatch,
  lookupRecoveryKey,
  regenerateRecoveryKeys,
  type VaultRecoverCompleteRequest,
  type VaultRecoveryKeysRegenerateRequest,
  type VaultState,
} from '@/lib/api/vault';
import { grantStillValid } from '@/lib/auth/audit-catalog';
import { formatRetryClock, normalizeRetryAfter } from '@/lib/auth/retry-after';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';
import { CryptoClientError } from '@/lib/crypto/client';

const GRANT_MIN_TTL_BEFORE_FIRST_SEND_MS = 60_000;

export type RecoveryStep =
  | 'reauth'
  | 'enter-key'
  | 'new-passphrase'
  | 'regenerate-reauth'
  | 'regenerate-keys'
  | 'done';

export type Step2ErrorState =
  | { kind: 'invalid' }
  | { kind: 'rate_limited'; initialSeconds: number }
  | { kind: 'aead_failed' }
  | { kind: 'network'; detail?: string };

export type Step3ErrorState =
  | { kind: 'reauth_expired_password' }
  | { kind: 'reauth_expired_oauth' }
  | { kind: 'insufficient_memory' }
  | { kind: 'version_mismatch' }
  | { kind: 'precondition_required' }
  | { kind: 'idempotency_in_progress' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'mutations_disabled' }
  | { kind: 'rate_limited'; initialSeconds: number }
  | { kind: 'network'; detail?: string };

export type Step4ErrorState =
  | { kind: 'reauth_expired_password' }
  | { kind: 'reauth_expired_oauth' }
  | { kind: 'version_mismatch' }
  | { kind: 'slot_taken' }
  | { kind: 'rate_limited'; initialSeconds: number }
  | { kind: 'network'; detail?: string };

interface PreparedCompleteBundle {
  opGeneration: number;
  vaultKeyId: string;
  ifMatch: string;
  idempotencyKey: string;
  requestBodyJson: string;
  reauthToken: string;
  sentAtLeastOnce: boolean;
}

interface PreparedRegenerateBundle {
  opGeneration: number;
  vaultKeyId: string;
  ifMatch: string;
  idempotencyKey: string;
  requestBodyJson: string;
  reauthToken: string;
  sentAtLeastOnce: boolean;
  displayRecoveryKeys: ReadonlyArray<{ slot: number; display: string }>;
  emptySlots: number[];
}

function isGrantFreshForFirstAttempt(grant: ReauthGrant | null, action: ReauthAction): boolean {
  if (!grant || grant.action !== action) return false;
  const exp = Date.parse(grant.expires_at);
  if (!Number.isFinite(exp)) return false;
  return exp - Date.now() >= GRANT_MIN_TTL_BEFORE_FIRST_SEND_MS;
}

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

function formatSlotLabels(slots: ReadonlyArray<number>): string {
  if (slots.length === 0) return 'none';
  return slots.map((s) => `rk${s}`).join(', ');
}

export function VaultRecoveryFlow() {
  const t = useTranslations('recovery');
  const router = useRouter();
  const { me, reauth, refetchMe } = useSession();
  const vault = useVault();

  // Check if user returned from OAuth reauth or already has an active vault.recover grant
  const initialHasRecoverGrant = Boolean(
    reauth.grant &&
      reauth.grant.action === 'vault.recover' &&
      grantStillValid(reauth.grant.expires_at),
  );
  const initialHasRegenGrant = Boolean(
    reauth.grant &&
      reauth.grant.action === 'vault.recovery_keys_regenerate' &&
      grantStillValid(reauth.grant.expires_at),
  );

  const [step, setStep] = useState<RecoveryStep>(() => {
    if (initialHasRegenGrant) return 'regenerate-reauth';
    if (initialHasRecoverGrant) return 'enter-key';
    return 'reauth';
  });

  // Step 1 state
  const [step1Password, setStep1Password] = useState('');

  // Step 2 state
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [lookingUpKey, setLookingUpKey] = useState(false);
  const [step2Error, setStep2Error] = useState<Step2ErrorState | null>(null);
  const [step2RateDeadline, setStep2RateDeadline] = useState<number | null>(null);

  // Active recovery session state (between Step 2 -> Step 3)
  const [recoveryOpGeneration, setRecoveryOpGeneration] = useState<number | null>(null);
  const [recoveryKeyId, setRecoveryKeyId] = useState<string | null>(null);
  const [capturedVaultMeta, setCapturedVaultMeta] = useState<VaultState | null>(null);

  // Step 3 state
  const [newPassphrase, setNewPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [policyScore, setPolicyScore] = useState<PassphraseScore>(0);
  const [meetsMinLength, setMeetsMinLength] = useState(false);
  const [meetsMinScore, setMeetsMinScore] = useState(false);
  const [step3PolicyReason, setStep3PolicyReason] =
    useState<PassphrasePolicyReasonCode | null>(null);
  const [completingRecovery, setCompletingRecovery] = useState(false);
  const [step3Error, setStep3Error] = useState<Step3ErrorState | null>(null);
  const [step3RateDeadline, setStep3RateDeadline] = useState<number | null>(null);
  const [step3ReauthPassword, setStep3ReauthPassword] = useState('');
  const [preparedCompleteBundle, setPreparedCompleteBundle] =
    useState<PreparedCompleteBundle | null>(null);

  // Step 4 state
  const [remainingCount, setRemainingCount] = useState<number>(9);
  const [emptySlots, setEmptySlots] = useState<number[]>([1]);
  const [step4ReauthPassword, setStep4ReauthPassword] = useState('');
  const [generatingRegenKeys, setGeneratingRegenKeys] = useState(false);
  const [preparedRegenBundle, setPreparedRegenBundle] =
    useState<PreparedRegenerateBundle | null>(null);
  const [confirmedRegenSaved, setConfirmedRegenSaved] = useState(false);
  const [savingRegenKeys, setSavingRegenKeys] = useState(false);
  const [step4Error, setStep4Error] = useState<Step4ErrorState | null>(null);
  const [step4RateDeadline, setStep4RateDeadline] = useState<number | null>(null);

  const rkInputRef = useRef<HTMLInputElement>(null);
  const newPassInputRef = useRef<HTMLInputElement>(null);
  const confirmPassInputRef = useRef<HTMLInputElement>(null);
  const step1PassInputRef = useRef<HTMLInputElement>(null);
  const step3ReauthPassInputRef = useRef<HTMLInputElement>(null);
  const step4ReauthPassInputRef = useRef<HTMLInputElement>(null);

  const evalSeqRef = useRef(0);
  const stepRef = useRef<RecoveryStep>(step);
  stepRef.current = step;
  const completedRecoveryRef = useRef(false);
  const workerHoldsRecoveryStateRef = useRef(false);
  const suppressResetStepTransitionRef = useRef(false);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const reauthGrantRef = useRef(reauth.grant);
  reauthGrantRef.current = reauth.grant;
  const regenCheckboxId = useId();

  const step2Countdown = useRetryCountdown(step2RateDeadline);
  const step3Countdown = useRetryCountdown(step3RateDeadline);
  const step4Countdown = useRetryCountdown(step4RateDeadline);

  const isStep2RateLimited =
    step2Error?.kind === 'rate_limited' && step2RateDeadline !== null && step2Countdown > 0;
  const isStep3RateLimited =
    step3Error?.kind === 'rate_limited' && step3RateDeadline !== null && step3Countdown > 0;
  const isStep4RateLimited =
    step4Error?.kind === 'rate_limited' && step4RateDeadline !== null && step4Countdown > 0;

  const userInputs = useMemo(() => {
    const email = me?.user.email;
    if (!email) return [];
    const localPart = email.split('@')[0] ?? '';
    return [email, localPart].filter(Boolean);
  }, [me?.user.email]);

  const clearRecoveryKeyInputImmediate = useCallback(() => {
    setRecoveryKeyInput('');
    if (rkInputRef.current) {
      rkInputRef.current.value = '';
    }
  }, []);

  const clearPassphraseInputsImmediate = useCallback(() => {
    setNewPassphrase('');
    setConfirmPassphrase('');
    setPolicyScore(0);
    setMeetsMinLength(false);
    setMeetsMinScore(false);
    if (newPassInputRef.current) {
      newPassInputRef.current.value = '';
    }
    if (confirmPassInputRef.current) {
      confirmPassInputRef.current.value = '';
    }
  }, []);

  const clearReauthPasswordInputs = useCallback(() => {
    setStep1Password('');
    setStep3ReauthPassword('');
    setStep4ReauthPassword('');
    if (step1PassInputRef.current) step1PassInputRef.current.value = '';
    if (step3ReauthPassInputRef.current) step3ReauthPassInputRef.current.value = '';
    if (step4ReauthPassInputRef.current) step4ReauthPassInputRef.current.value = '';
  }, []);

  const clearAllSecrets = useCallback(() => {
    clearRecoveryKeyInputImmediate();
    clearPassphraseInputsImmediate();
    clearReauthPasswordInputs();
    setPreparedCompleteBundle(null);
    setPreparedRegenBundle(null);
    setConfirmedRegenSaved(false);
  }, [
    clearPassphraseInputsImmediate,
    clearReauthPasswordInputs,
    clearRecoveryKeyInputImmediate,
  ]);

  // Ensure reauth pendingAction is initialized when on Step 1 or Step 4a
  useEffect(() => {
    if (step === 'reauth') {
      if (
        reauth.grant &&
        reauth.grant.action === 'vault.recover' &&
        grantStillValid(reauth.grant.expires_at)
      ) {
        setStep('enter-key');
        return;
      }
      if (reauth.pendingAction !== 'vault.recover') {
        void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
      }
    } else if (step === 'regenerate-reauth') {
      if (
        reauth.pendingAction !== 'vault.recovery_keys_regenerate' &&
        !(
          reauth.grant &&
          reauth.grant.action === 'vault.recovery_keys_regenerate' &&
          grantStillValid(reauth.grant.expires_at)
        )
      ) {
        void reauth
          .begin('vault.recovery_keys_regenerate', '/app/recovery')
          .catch(() => undefined);
      }
    }
  }, [reauth, step]);

  // Register secret form reset with VaultProvider: if the vault locks mid-recovery (manual lock, broadcast, auto-lock),
  // immediately wipe all secrets and return to step 1/2 so stale recovering state is never shown.
  useEffect(() => {
    const currentVault = vaultRef.current;
    return currentVault.registerSecretFormReset(() => {
      clearAllSecrets();
      workerHoldsRecoveryStateRef.current = false;
      setRecoveryOpGeneration(null);
      setRecoveryKeyId(null);
      if (
        !suppressResetStepTransitionRef.current &&
        (stepRef.current === 'new-passphrase' ||
          stepRef.current === 'regenerate-keys')
      ) {
        completedRecoveryRef.current = false;
        const currentGrant = reauthGrantRef.current;
        const stillHasRecoverGrant = Boolean(
          currentGrant &&
            currentGrant.action === 'vault.recover' &&
            grantStillValid(currentGrant.expires_at),
        );
        setStep(stillHasRecoverGrant ? 'enter-key' : 'reauth');
      }
    });
  }, [clearAllSecrets]);

  // Leaving the recovery route mid-way (after unlockRecovery started and before recovery completes)
  // MUST lock the client to wipe VK and pending continuation; never send an unnecessary lock when
  // leaving Step 1 before any Worker recovery state exists.
  useEffect(() => {
    return () => {
      clearAllSecrets();
      if (workerHoldsRecoveryStateRef.current && !completedRecoveryRef.current) {
        workerHoldsRecoveryStateRef.current = false;
        void vaultRef.current.lock({ broadcast: false, reason: 'recovery_unmounted' });
      }
    };
  }, [clearAllSecrets]);

  // Live NFC + lazy zxcvbn policy evaluation while typing in Step 3
  useEffect(() => {
    if (step !== 'new-passphrase') return;

    const seq = ++evalSeqRef.current;
    if (newPassphrase.length === 0 && confirmPassphrase.length === 0) {
      setPolicyScore(0);
      setMeetsMinLength(false);
      setMeetsMinScore(false);
      return;
    }

    void checkPassphrasePolicy(newPassphrase, {
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
  }, [confirmPassphrase, newPassphrase, step, userInputs]);

  const strengthLabel = useMemo(() => {
    if (newPassphrase.length === 0) return t('step3.strength.empty');
    switch (policyScore) {
      case 0:
        return t('step3.strength.veryWeak');
      case 1:
        return t('step3.strength.weak');
      case 2:
        return t('step3.strength.fair');
      case 3:
        return t('step3.strength.good');
      case 4:
        return t('step3.strength.strong');
    }
  }, [newPassphrase.length, policyScore, t]);

  const step3PolicyErrorText = useMemo(() => {
    if (!step3PolicyReason || step3PolicyReason === 'ok') return null;
    switch (step3PolicyReason) {
      case 'empty':
        return t('step3.policyErrors.empty');
      case 'too_short':
        return t('step3.policyErrors.tooShort');
      case 'too_weak':
        return t('step3.policyErrors.tooWeak');
      case 'mismatch':
        return t('step3.policyErrors.mismatch');
      case 'invalid_unicode':
        return t('step3.policyErrors.invalidUnicode');
    }
  }, [step3PolicyReason, t]);

  // Step 1 handlers: acquire `vault.recover` grant FIRST before any RK input
  const handleStep1PasswordSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (reauth.submitting || !step1Password) return;
      try {
        if (reauth.pendingAction !== 'vault.recover') {
          void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
        }
        const pwd = step1Password;
        setStep1Password('');
        if (step1PassInputRef.current) step1PassInputRef.current.value = '';
        await reauth.submitPassword(pwd);
        setStep('enter-key');
      } catch {
        // Error surfaced by reauth.error
      }
    },
    [reauth, step1Password],
  );

  const handleStep1GoogleReauth = useCallback(async () => {
    if (reauth.submitting) return;
    if (reauth.pendingAction !== 'vault.recover') {
      void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
    }
    await reauth.startOauthReauth('google', '/app/recovery');
  }, [reauth]);

  // Cancel / abort recovery at any point -> locks Worker (wiping VK + pendingRecovery continuation)
  const handleCancelRecovery = useCallback(async () => {
    clearAllSecrets();
    completedRecoveryRef.current = false;
    workerHoldsRecoveryStateRef.current = false;
    setRecoveryOpGeneration(null);
    setRecoveryKeyId(null);
    await vault.lock({ broadcast: false, reason: 'recovery_cancelled' });
    router.replace('/app/unlock/forgot');
  }, [clearAllSecrets, router, vault]);

  // Step 2: Enter RK -> capture opGeneration -> unlockRecovery -> POST /vault/unlock/recovery -> resumeRecovery
  const handleStep2Submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (lookingUpKey || vault.inFlight || isStep2RateLimited) return;

      setStep2Error(null);
      setStep2RateDeadline(null);

      // Verify grant is still active before doing any lookup so an OAuth user never burns a lookup before redirect
      const currentGrant = reauth.grant;
      if (
        !currentGrant ||
        currentGrant.action !== 'vault.recover' ||
        !grantStillValid(currentGrant.expires_at)
      ) {
        clearRecoveryKeyInputImmediate();
        void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
        setStep('reauth');
        return;
      }

      if (recoveryKeyInput.trim().length === 0) {
        clearRecoveryKeyInputImmediate();
        setStep2Error({ kind: 'invalid' });
        return;
      }

      // Capture immutable opGeneration BEFORE the first await (ADR 0002 §10.2).
      const client = vault.getClient();
      const opGeneration = client.captureGeneration();

      const rawRkSnapshot = recoveryKeyInput;
      // Clear RK input immediately right when unlockRecovery is invoked (Task 17A requirement #5).
      clearRecoveryKeyInputImmediate();
      setLookingUpKey(true);

      try {
        // 1. Derive lookup_hash and store wrapKey continuation inside Worker (single RK pass)
        workerHoldsRecoveryStateRef.current = true;
        const derived = await vault.unlockRecovery({
          recoveryKey: rawRkSnapshot,
          opGeneration,
        });
        if (client.getGeneration() !== opGeneration) {
          return;
        }

        // 2. Ensure we have current GET /vault metadata (`private_keys_wrapped`, `kdf`, `vault_key_id`, `version`)
        const meta = vault.vaultMeta ?? (await vault.reloadVaultMeta());
        if (!meta) {
          workerHoldsRecoveryStateRef.current = false;
          await vault.lock({ broadcast: false, reason: 'recovery_vault_absent' });
          return;
        }
        setCapturedVaultMeta(meta);

        if (client.getGeneration() !== opGeneration) {
          return;
        }

        // 3. POST /vault/unlock/recovery { lookup_hash } (does NOT consume the key)
        const lookupRes = await lookupRecoveryKey({
          lookup_hash: derived.lookup_hash,
        });

        if (client.getGeneration() !== opGeneration) {
          return;
        }

        // 4. Open `wrap` using the Worker's held continuation (`resumeRecovery`) -> transitions to `recovering`
        await vault.resumeRecovery({
          wrap: lookupRes.wrap,
          privateKeysWrapped: meta.private_keys_wrapped,
          opGeneration,
        });

        if (client.getGeneration() !== opGeneration) {
          return;
        }

        setRecoveryOpGeneration(opGeneration);
        setRecoveryKeyId(lookupRes.recovery_key_id);
        setPreparedCompleteBundle(null);
        setStep3Error(null);
        setStep3PolicyReason(null);
        setStep('new-passphrase');
      } catch (err) {
        if (err instanceof ProblemError) {
          const { status, code, retry_after } = err.problem;
          if (status === 401 && code === 'recovery_key_invalid') {
            // Wipe pending continuation in Worker
            workerHoldsRecoveryStateRef.current = false;
            await vault.lock({ broadcast: false, reason: 'recovery_key_lookup_401' });
            setStep2Error({ kind: 'invalid' });
            return;
          }
          if (status === 429 || code === 'rate_limited') {
            workerHoldsRecoveryStateRef.current = false;
            await vault.lock({ broadcast: false, reason: 'recovery_key_lookup_429' });
            const seconds = normalizeRetryAfter(retry_after, 60);
            setStep2RateDeadline(Date.now() + seconds * 1000);
            setStep2Error({ kind: 'rate_limited', initialSeconds: seconds });
            return;
          }
          workerHoldsRecoveryStateRef.current = false;
          await vault.lock({ broadcast: false, reason: 'recovery_key_lookup_error' });
          setStep2Error({
            kind: 'network',
            detail: err.problem.detail ?? err.problem.title,
          });
          return;
        }

        const classified = classifyCryptoError(err);
        if (classified.kind === 'recovery_key_invalid') {
          workerHoldsRecoveryStateRef.current = false;
          setStep2Error({ kind: 'invalid' });
          return;
        }
        if (classified.kind === 'wrong_passphrase' || classified.code === 'PRIVATE_KEYS_WRAP_INVALID') {
          // Local AEAD open of `wrap` failed after server lookup matched -> key NOT consumed
          workerHoldsRecoveryStateRef.current = false;
          setStep2Error({ kind: 'aead_failed' });
          return;
        }
        if (classified.kind === 'stale_generation' && client.getGeneration() !== opGeneration) {
          return;
        }
        if (err instanceof CryptoClientError && err.code === 'SECRET_DETACHED_OR_EMPTY') {
          workerHoldsRecoveryStateRef.current = false;
          setStep2Error({ kind: 'invalid' });
          return;
        }
        setStep2Error({
          kind: 'network',
          detail: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setLookingUpKey(false);
      }
    },
    [
      clearRecoveryKeyInputImmediate,
      isStep2RateLimited,
      lookingUpKey,
      reauth,
      recoveryKeyInput,
      vault,
    ],
  );

  // Helper to send (or replay) `POST /vault/recover/complete` + `confirmRecovery`
  const executeCompleteRequest = useCallback(
    async (bundle: PreparedCompleteBundle) => {
      const client = vault.getClient();
      setCompletingRecovery(true);
      setStep3Error(null);
      setStep3RateDeadline(null);

      try {
        bundle.sentAtLeastOnce = true;
        const completeRes = await completeRecovery(bundle.requestBodyJson, {
          idempotencyKey: bundle.idempotencyKey,
          ifMatch: bundle.ifMatch,
          reauthToken: bundle.reauthToken,
        });

        if (client.getGeneration() !== bundle.opGeneration) {
          return;
        }

        // Only after 200 from `POST /vault/recover/complete`: promote Worker from `recovering` -> `unlocked`
        await vault.confirmRecovery({
          opGeneration: bundle.opGeneration,
        });

        completedRecoveryRef.current = true;
        workerHoldsRecoveryStateRef.current = false;
        setPreparedCompleteBundle(null);

        vault.notifyVaultChanged({
          vault_key_id: bundle.vaultKeyId,
          version: completeRes.version,
        });

        // Query remaining recovery keys and empty slots to suggest regeneration (Step 4)
        try {
          const rkStatus = await fetchRecoveryKeysStatus();
          setRemainingCount(rkStatus.remaining);
          const sortedEmpty = [...rkStatus.empty_slots].sort((a, b) => a - b);
          setEmptySlots(sortedEmpty);
        } catch {
          setRemainingCount(9);
          setEmptySlots([1]);
        }

        setStep('regenerate-reauth');
      } catch (err) {
        if (err instanceof ProblemError) {
          const { status, code, retry_after } = err.problem;
          if (status === 412 || code === 'version_mismatch') {
            setPreparedCompleteBundle(null);
            setStep3Error({ kind: 'version_mismatch' });
            return;
          }
          if (status === 428 || code === 'precondition_required') {
            setPreparedCompleteBundle(null);
            setStep3Error({ kind: 'precondition_required' });
            return;
          }
          if (status === 409 && code === 'idempotency_in_progress') {
            // Keep bundle so retry reuses the exact same Idempotency-Key and requestBodyJson
            setStep3Error({ kind: 'idempotency_in_progress' });
            return;
          }
          if (status === 409 && code === 'idempotency_conflict') {
            setPreparedCompleteBundle(null);
            setStep3Error({ kind: 'idempotency_conflict' });
            return;
          }
          if (status === 503 || code === 'vault_mutations_disabled') {
            setPreparedCompleteBundle(null);
            setStep3Error({ kind: 'mutations_disabled' });
            return;
          }
          if (status === 429 || code === 'rate_limited') {
            const seconds = normalizeRetryAfter(retry_after, 60);
            setStep3RateDeadline(Date.now() + seconds * 1000);
            setStep3Error({ kind: 'rate_limited', initialSeconds: seconds });
            return;
          }
          if (
            status === 401 &&
            (code === 'reauth_required' || code === 'reauth_invalid' || code === 'reauth_expired')
          ) {
            if (reauth.capabilities.hasPassword) {
              void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
              setStep3Error({ kind: 'reauth_expired_password' });
            } else {
              // OAuth-only user: cannot redirect mid-recovery without wiping Worker -> lock & tell user to restart
              setPreparedCompleteBundle(null);
              reauth.clearGrant();
              suppressResetStepTransitionRef.current = true;
              try {
                workerHoldsRecoveryStateRef.current = false;
                await vault.lock({ broadcast: false, reason: 'recovery_oauth_grant_expired' });
              } finally {
                suppressResetStepTransitionRef.current = false;
              }
              setStep3Error({ kind: 'reauth_expired_oauth' });
            }
            return;
          }
          setStep3Error({
            kind: 'network',
            detail: err.problem.detail ?? err.problem.title,
          });
          return;
        }

        // Network / timeout error: preserve `preparedCompleteBundle` (`sentAtLeastOnce = true`) for idempotent replay
        setStep3Error({
          kind: 'network',
          detail: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setCompletingRecovery(false);
      }
    },
    [reauth, vault],
  );

  // Step 3 submit: validate policy -> check grant >= 60s before FIRST send -> rewrap (stays `recovering`) -> complete
  const handleStep3Submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (completingRecovery || vault.inFlight || isStep3RateLimited) return;

      // If we already have a prepared bundle that failed on network/5xx/409-in-progress, replay it directly!
      // Per ADR 0002 §8.3: if `sentAtLeastOnce` is true, replay with the exact same Idempotency-Key & body
      // WITHOUT applying the 60s grant preflight restart rule.
      if (preparedCompleteBundle && preparedCompleteBundle.sentAtLeastOnce) {
        await executeCompleteRequest(preparedCompleteBundle);
        return;
      }

      setStep3PolicyReason(null);
      setStep3Error(null);

      const client = vault.getClient();
      const opGen = recoveryOpGeneration ?? client.captureGeneration();

      const policy = await checkPassphrasePolicy(newPassphrase, {
        confirmPassphrase,
        userInputs,
      });

      setPolicyScore(policy.score);
      setMeetsMinLength(policy.meetsMinLength);
      setMeetsMinScore(policy.meetsMinScore);

      if (!policy.valid) {
        setStep3PolicyReason(policy.reason);
        return;
      }

      if (client.getGeneration() !== opGen) {
        clearPassphraseInputsImmediate();
        return;
      }

      const meta = capturedVaultMeta ?? vault.vaultMeta;
      if (!meta || !recoveryKeyId) {
        setStep3Error({ kind: 'version_mismatch' });
        return;
      }

      const passphraseSnapshot = newPassphrase;
      // Clear passphrase inputs before Worker call (ADR 0002 §11)
      clearPassphraseInputsImmediate();
      setCompletingRecovery(true);

      let bundle = preparedCompleteBundle;
      try {
        if (!bundle) {
          // Run `rewrap` inside Worker (Worker remains in `recovering` mode!)
          const rewrapped = await vault.rewrap({
            passphrase: passphraseSnapshot,
            currentKdf: meta.kdf,
            opGeneration: opGen,
          });

          if (client.getGeneration() !== opGen) {
            return;
          }

          const payload: VaultRecoverCompleteRequest = {
            recovery_key_id: recoveryKeyId,
            kdf: rewrapped.kdf,
            vault_key_wrapped_by_kek: rewrapped.vault_key_wrapped_by_kek,
          };

          bundle = {
            opGeneration: opGen,
            vaultKeyId: meta.vault_key_id,
            ifMatch: formatVaultIfMatch(meta.vault_key_id, meta.version),
            idempotencyKey: createIdempotencyKey(),
            requestBodyJson: JSON.stringify(payload),
            reauthToken: reauth.grant?.grant ?? '',
            sentAtLeastOnce: false,
          };
          setPreparedCompleteBundle(bundle);
        }

        // First-attempt preflight (ADR 0002 §8.3): check grant has at least 60s remaining before first send
        if (!isGrantFreshForFirstAttempt(reauth.grant, 'vault.recover')) {
          if (reauth.capabilities.hasPassword) {
            void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
            setStep3Error({ kind: 'reauth_expired_password' });
          } else {
            // OAuth-only user: grant expired mid-recovery -> lock Worker (wiping VK) and tell user to restart from Step 1
            // No redirect happens automatically, so no lookup is burned after a redirect.
            setPreparedCompleteBundle(null);
            reauth.clearGrant();
            suppressResetStepTransitionRef.current = true;
            try {
              workerHoldsRecoveryStateRef.current = false;
              await vault.lock({ broadcast: false, reason: 'recovery_oauth_grant_expired_preflight' });
            } finally {
              suppressResetStepTransitionRef.current = false;
            }
            setStep3Error({ kind: 'reauth_expired_oauth' });
          }
          return;
        }

        bundle.reauthToken = reauth.grant!.grant;
        await executeCompleteRequest(bundle);
      } catch (err) {
        const classified = classifyCryptoError(err);
        if (classified.kind === 'insufficient_memory') {
          setStep3Error({ kind: 'insufficient_memory' });
          return;
        }
        if (classified.kind === 'passphrase_invalid') {
          setStep3PolicyReason('invalid_unicode');
          return;
        }
        if (classified.kind === 'stale_generation' && client.getGeneration() !== opGen) {
          return;
        }
        setStep3Error({
          kind: 'network',
          detail: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setCompletingRecovery(false);
      }
    },
    [
      capturedVaultMeta,
      clearPassphraseInputsImmediate,
      completingRecovery,
      confirmPassphrase,
      executeCompleteRequest,
      isStep3RateLimited,
      newPassphrase,
      preparedCompleteBundle,
      reauth,
      recoveryKeyId,
      recoveryOpGeneration,
      userInputs,
      vault,
    ],
  );

  // Step 3 in-place password re-auth when grant < 60s (preserves Worker `recovering` state and `preparedCompleteBundle`)
  const handleStep3InPlacePasswordReauth = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (reauth.submitting || !step3ReauthPassword) return;
      try {
        if (reauth.pendingAction !== 'vault.recover') {
          void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
        }
        const pwd = step3ReauthPassword;
        setStep3ReauthPassword('');
        if (step3ReauthPassInputRef.current) step3ReauthPassInputRef.current.value = '';
        const freshGrant = await reauth.submitPassword(pwd);
        if (preparedCompleteBundle) {
          const updatedBundle: PreparedCompleteBundle = {
            ...preparedCompleteBundle,
            reauthToken: freshGrant.grant,
          };
          setPreparedCompleteBundle(updatedBundle);
          await executeCompleteRequest(updatedBundle);
        } else {
          setStep3Error(null);
        }
      } catch {
        // Error surfaced in reauth.error
      }
    },
    [executeCompleteRequest, preparedCompleteBundle, reauth, step3ReauthPassword],
  );

  // Step 3 reload after 412 version_mismatch or 409 idempotency_conflict:
  // Re-GET /vault, lock temporary state, and restart from Step 2 (or Step 1 if grant expired)
  const handleStep3ReloadAndRestart = useCallback(async () => {
    clearPassphraseInputsImmediate();
    setPreparedCompleteBundle(null);
    setStep3Error(null);
    workerHoldsRecoveryStateRef.current = false;
    await vault.lock({ broadcast: false, reason: 'recovery_version_mismatch_reload' });
    const freshMeta = await vault.reloadVaultMeta().catch(() => null);
    if (freshMeta) {
      setCapturedVaultMeta(freshMeta);
    }
    const stillValidGrant = isGrantFreshForFirstAttempt(reauth.grant, 'vault.recover');
    if (stillValidGrant) {
      setStep('enter-key');
    } else {
      void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
      setStep('reauth');
    }
  }, [clearPassphraseInputsImmediate, reauth, vault]);

  // Step 3 OAuth expired restart: return to Step 1 cleanly without burning any lookup
  const handleStep3OauthRestart = useCallback(async () => {
    clearAllSecrets();
    setStep3Error(null);
    reauth.clearGrant();
    suppressResetStepTransitionRef.current = true;
    try {
      workerHoldsRecoveryStateRef.current = false;
      await vault.lock({ broadcast: false, reason: 'recovery_oauth_restart' });
    } finally {
      suppressResetStepTransitionRef.current = false;
    }
    void reauth.begin('vault.recover', '/app/recovery').catch(() => undefined);
    setStep('reauth');
  }, [clearAllSecrets, reauth, vault]);

  // Step 4a: Generate replacement keys for empty slots after acquiring `vault.recovery_keys_regenerate` grant
  const prepareRegenerationKeys = useCallback(
    async (grantToUse: ReauthGrant) => {
      if (generatingRegenKeys) return;
      setGeneratingRegenKeys(true);
      setStep4Error(null);

      try {
        const client = vault.getClient();
        const opGen = client.captureGeneration();

        // Fetch fresh empty slots and vault metadata
        const [rkStatus, freshMeta] = await Promise.all([
          fetchRecoveryKeysStatus(),
          vault.reloadVaultMeta(),
        ]);

        if (!freshMeta) {
          return;
        }

        const sortedEmpty = [...rkStatus.empty_slots].sort((a, b) => a - b);
        setRemainingCount(rkStatus.remaining);
        setEmptySlots(sortedEmpty);

        if (sortedEmpty.length === 0) {
          router.replace('/app');
          return;
        }

        if (client.getGeneration() !== opGen) {
          return;
        }

        const generated = await client.makeRecoveryKeys({
          slots: sortedEmpty,
          opGeneration: opGen,
        });

        if (client.getGeneration() !== opGen) {
          return;
        }

        const payload: VaultRecoveryKeysRegenerateRequest = {
          recovery_keys: generated.recovery_keys.map((rk) => ({
            slot: rk.slot,
            lookup_hash: rk.lookup_hash,
            wrap: rk.wrap,
          })),
        };

        setPreparedRegenBundle({
          opGeneration: opGen,
          vaultKeyId: freshMeta.vault_key_id,
          ifMatch: formatVaultIfMatch(freshMeta.vault_key_id, freshMeta.version),
          idempotencyKey: createIdempotencyKey(),
          requestBodyJson: JSON.stringify(payload),
          reauthToken: grantToUse.grant,
          sentAtLeastOnce: false,
          displayRecoveryKeys: generated.recovery_keys.map((rk) => ({
            slot: rk.slot,
            display: rk.display,
          })),
          emptySlots: sortedEmpty,
        });
        setConfirmedRegenSaved(false);
        setStep('regenerate-keys');
      } catch (err) {
        if (err instanceof ProblemError) {
          setStep4Error({
            kind: 'network',
            detail: err.problem.detail ?? err.problem.title,
          });
          return;
        }
        setStep4Error({
          kind: 'network',
          detail: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setGeneratingRegenKeys(false);
      }
    },
    [generatingRegenKeys, router, vault],
  );

  const handleStep4PasswordReauth = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (reauth.submitting || generatingRegenKeys || !step4ReauthPassword) return;
      try {
        if (reauth.pendingAction !== 'vault.recovery_keys_regenerate') {
          void reauth
            .begin('vault.recovery_keys_regenerate', '/app/recovery')
            .catch(() => undefined);
        }
        const pwd = step4ReauthPassword;
        setStep4ReauthPassword('');
        if (step4ReauthPassInputRef.current) step4ReauthPassInputRef.current.value = '';
        const grant = await reauth.submitPassword(pwd);
        await prepareRegenerationKeys(grant);
      } catch {
        // Error surfaced in reauth.error
      }
    },
    [generatingRegenKeys, prepareRegenerationKeys, reauth, step4ReauthPassword],
  );

  const handleStep4GoogleReauth = useCallback(async () => {
    if (reauth.submitting) return;
    if (reauth.pendingAction !== 'vault.recovery_keys_regenerate') {
      void reauth
        .begin('vault.recovery_keys_regenerate', '/app/recovery')
        .catch(() => undefined);
    }
    await reauth.startOauthReauth('google', '/app/recovery');
  }, [reauth]);

  // Step 4b: Save regenerated replacement recovery keys
  const handleStep4SaveRegenKeys = useCallback(async () => {
    if (!confirmedRegenSaved || !preparedRegenBundle || savingRegenKeys || isStep4RateLimited) {
      return;
    }

    // Check 60s grant preflight only before the first attempt
    if (
      !preparedRegenBundle.sentAtLeastOnce &&
      !isGrantFreshForFirstAttempt(reauth.grant, 'vault.recovery_keys_regenerate')
    ) {
      if (reauth.capabilities.hasPassword) {
        void reauth
          .begin('vault.recovery_keys_regenerate', '/app/recovery')
          .catch(() => undefined);
        setStep4Error({ kind: 'reauth_expired_password' });
      } else {
        setPreparedRegenBundle(null);
        setConfirmedRegenSaved(false);
        setStep4Error({ kind: 'reauth_expired_oauth' });
      }
      return;
    }

    setSavingRegenKeys(true);
    setStep4Error(null);
    setStep4RateDeadline(null);

    try {
      preparedRegenBundle.sentAtLeastOnce = true;
      const tokenToUse =
        reauth.grant?.action === 'vault.recovery_keys_regenerate'
          ? reauth.grant.grant
          : preparedRegenBundle.reauthToken;

      const res = await regenerateRecoveryKeys(preparedRegenBundle.requestBodyJson, {
        idempotencyKey: preparedRegenBundle.idempotencyKey,
        ifMatch: preparedRegenBundle.ifMatch,
        reauthToken: tokenToUse,
      });

      // Immediately wipe the displayed replacement keys from state & DOM
      setPreparedRegenBundle(null);
      setConfirmedRegenSaved(false);
      setStep('done');

      vault.notifyVaultChanged({
        vault_key_id: preparedRegenBundle.vaultKeyId,
        version: res.version,
      });

      await refetchMe().catch(() => undefined);
      router.replace('/app');
    } catch (err) {
      if (err instanceof ProblemError) {
        const { status, code, retry_after } = err.problem;
        if (status === 412 || code === 'version_mismatch') {
          setPreparedRegenBundle(null);
          setConfirmedRegenSaved(false);
          setStep4Error({ kind: 'version_mismatch' });
          return;
        }
        if (status === 409 && code === 'recovery_key_slot_taken') {
          setPreparedRegenBundle(null);
          setConfirmedRegenSaved(false);
          setStep4Error({ kind: 'slot_taken' });
          return;
        }
        if (status === 429 || code === 'rate_limited') {
          const seconds = normalizeRetryAfter(retry_after, 60);
          setStep4RateDeadline(Date.now() + seconds * 1000);
          setStep4Error({ kind: 'rate_limited', initialSeconds: seconds });
          return;
        }
        setStep4Error({
          kind: 'network',
          detail: err.problem.detail ?? err.problem.title,
        });
        return;
      }
      setStep4Error({
        kind: 'network',
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingRegenKeys(false);
    }
  }, [
    confirmedRegenSaved,
    isStep4RateLimited,
    preparedRegenBundle,
    reauth,
    refetchMe,
    router,
    savingRegenKeys,
    vault,
  ]);

  const handleSkipRegenerate = useCallback(() => {
    setPreparedRegenBundle(null);
    setConfirmedRegenSaved(false);
    router.replace('/app');
  }, [router]);

  const barWidth = strengthBarPercentage(policyScore, newPassphrase.length > 0);
  const barColor = strengthBarColor(policyScore, newPassphrase.length > 0);

  const effectiveStep2RateSeconds =
    step2Error?.kind === 'rate_limited'
      ? Math.max(1, step2Countdown || step2Error.initialSeconds)
      : 0;
  const effectiveStep3RateSeconds =
    step3Error?.kind === 'rate_limited'
      ? Math.max(1, step3Countdown || step3Error.initialSeconds)
      : 0;
  const effectiveStep4RateSeconds =
    step4Error?.kind === 'rate_limited'
      ? Math.max(1, step4Countdown || step4Error.initialSeconds)
      : 0;

  const emptySlotsLabel = formatSlotLabels(
    preparedRegenBundle ? preparedRegenBundle.emptySlots : emptySlots,
  );
  const isRegenStep = step === 'regenerate-reauth' || step === 'regenerate-keys';

  return (
    <>
      <AppHeader vault={{ state: isRegenStep ? 'open' : 'locked' }} showLogout />
      <main
        className="mx-auto max-w-[640px] px-5 pt-10 pb-24"
        data-testid="vault-recovery-page"
      >
        {/* Stepper matching mockups/recovery.html */}
        <nav aria-label={t('stepperLabel')} className="mb-7 flex items-center gap-3">
          <div className="seg flex-wrap" data-seg>
            <button
              type="button"
              aria-current={step === 'reauth' ? 'step' : undefined}
              aria-pressed={step === 'reauth'}
              disabled
            >
              {t('steps.reauth')}
            </button>
            <button
              type="button"
              aria-current={step === 'enter-key' ? 'step' : undefined}
              aria-pressed={step === 'enter-key'}
              disabled
            >
              {t('steps.enterKey')}
            </button>
            <button
              type="button"
              aria-current={step === 'new-passphrase' ? 'step' : undefined}
              aria-pressed={step === 'new-passphrase'}
              disabled
            >
              {t('steps.newPassphrase')}
            </button>
            <button
              type="button"
              aria-current={isRegenStep ? 'step' : undefined}
              aria-pressed={isRegenStep}
              disabled
            >
              {t('steps.regenerate')}
            </button>
          </div>
        </nav>

        {/* STEP 1 — Acquire `vault.recover` grant FIRST (before entering any RK) */}
        {step === 'reauth' ? (
          <section data-view="s1" data-testid="recovery-step-reauth">
            <h1 className="t-title-lg mb-2 text-ink">{t('step1.title')}</h1>
            <p className="t-body-lg mb-6" style={{ color: 'var(--muted)' }}>
              {t('step1.lead')}
            </p>

            <div className="card mb-5 p-6" id="recovery-reauth-start">
              <p className="t-label mb-3" style={{ color: 'var(--muted)' }}>
                {t('step1.badge')}
              </p>

              {reauth.capabilities.hasPassword ? (
                <form onSubmit={handleStep1PasswordSubmit} noValidate>
                  <Field
                    ref={step1PassInputRef}
                    id="recovery-step1-password"
                    type="password"
                    label={t('step1.passwordLabel')}
                    autoComplete="current-password"
                    value={step1Password}
                    disabled={reauth.submitting}
                    onChange={(e) => setStep1Password(e.target.value)}
                    wrapperClassName="mb-4"
                    data-vault-secret="true"
                    data-testid="recovery-reauth-password-input"
                  />
                  {reauth.error ? (
                    <AuthStatus tone="error" className="mb-4">
                      {reauth.error}
                    </AuthStatus>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={reauth.submitting || step1Password.length === 0}
                    data-testid="recovery-reauth-password-submit"
                  >
                    {reauth.submitting
                      ? t('step1.passwordSubmitting')
                      : t('step1.passwordSubmit')}
                  </Button>
                </form>
              ) : null}

              {!reauth.capabilities.hasPassword &&
              reauth.capabilities.passwordEnrollmentAvailable ? (
                <div className="mb-4">
                  <p className="mb-3 text-[13px] text-body">{t('step1.oauthOnlyHint')}</p>
                  <Link
                    href="/app/auth/password-enroll"
                    className="btn btn-secondary btn-sm no-underline"
                  >
                    {t('step1.enrollCta')}
                  </Link>
                </div>
              ) : null}

              {reauth.capabilities.oauthReauthProviders.includes('google') ? (
                <div className={reauth.capabilities.hasPassword ? 'mt-4' : ''}>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void handleStep1GoogleReauth()}
                    disabled={reauth.submitting}
                    data-testid="recovery-reauth-google-button"
                  >
                    {t('step1.googleSubmit')}
                  </Button>
                </div>
              ) : null}
            </div>

            <Link
              href="/app/unlock/forgot"
              className="btn btn-tertiary no-underline"
              data-testid="recovery-step1-cancel"
            >
              {t('step1.cancel')}
            </Link>
          </section>
        ) : null}

        {/* STEP 2 — Enter one recovery key */}
        {step === 'enter-key' ? (
          <section data-view="s2" data-testid="recovery-step-enter-key">
            <p className="t-label mb-2" style={{ color: 'var(--body)' }}>
              {t('step2.grantActiveBadge')}
            </p>
            <h1 className="t-title-lg mb-2 text-ink">{t('step2.title')}</h1>
            <p className="t-body-lg mb-6" style={{ color: 'var(--muted)' }}>
              {t('step2.lead')}
            </p>

            <form onSubmit={handleStep2Submit} noValidate>
              <div className="card mb-5 p-6">
                <label
                  htmlFor="recovery-key-input"
                  className="mb-5 block"
                >
                  <span className="mb-1.5 block text-[14px] font-semibold text-body">
                    {t('step2.inputLabel')}
                  </span>
                  <input
                    ref={rkInputRef}
                    id="recovery-key-input"
                    type="text"
                    value={recoveryKeyInput}
                    onChange={(e) => {
                      setRecoveryKeyInput(e.target.value);
                      if (step2Error?.kind === 'invalid') {
                        setStep2Error(null);
                      }
                    }}
                    placeholder={t('step2.inputPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={lookingUpKey || vault.inFlight || isStep2RateLimited}
                    className="mono w-full text-[14px] sm:text-[15px]"
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r-md)',
                      padding: '11px 12px',
                      background: 'var(--canvas)',
                      color: 'var(--body)',
                      outline: 'none',
                    }}
                    data-vault-secret="true"
                    data-testid="recovery-key-input"
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary"
                    className="w-full !justify-center"
                    disabled={lookingUpKey || vault.inFlight || isStep2RateLimited}
                    data-testid="recovery-key-submit"
                  >
                    {lookingUpKey ? t('step2.submitting') : t('step2.submit')}
                  </Button>
                </div>
              </div>
            </form>

            {/* Step 2 error cards (at most 1 role="alert" at a time) */}
            {step2Error?.kind === 'invalid' ? (
              <div
                id="s2-err-invalid"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-invalid-key"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step2.errors.invalidBadge')}
                </p>
                <div role="alert" className="auth-alert">
                  <p
                    className="m-0 mb-1 text-[14px] font-semibold"
                    style={{ color: 'var(--body)' }}
                  >
                    {t('step2.errors.invalidTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                    {t('step2.errors.invalidBody')}
                  </p>
                </div>
              </div>
            ) : null}

            {step2Error?.kind === 'rate_limited' ? (
              <div
                id="s2-err-rate"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--warning)' }}
                data-testid="recovery-error-lookup-rate-limited"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step2.errors.rateLimitedBadge')}
                </p>
                <div role="alert">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step2.errors.rateLimitedTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {t('step2.errors.rateLimitedBody', {
                      clock: formatRetryClock(effectiveStep2RateSeconds),
                      seconds: effectiveStep2RateSeconds,
                    })}
                  </p>
                </div>
              </div>
            ) : null}

            {step2Error?.kind === 'aead_failed' ? (
              <div
                id="s2-err-aead"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-aead-failed"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step2.errors.aeadBadge')}
                </p>
                <div role="alert" className="auth-alert">
                  <p
                    className="m-0 mb-1 text-[14px] font-semibold"
                    style={{ color: 'var(--body)' }}
                  >
                    {t('step2.errors.aeadTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                    {t('step2.errors.aeadBody')}
                  </p>
                </div>
              </div>
            ) : null}

            {step2Error?.kind === 'network' ? (
              <div
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-lookup-network"
              >
                <div role="alert">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step2.errors.networkTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {step2Error.detail ?? t('step2.errors.networkBody')}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="t-caption m-0 flex-1" style={{ color: 'var(--muted)' }}>
                {t('step2.caption')}
              </p>
              <Button
                type="button"
                variant="tertiary"
                size="sm"
                onClick={() => void handleCancelRecovery()}
                data-testid="recovery-step2-cancel"
              >
                {t('step2.cancel')}
              </Button>
            </div>
          </section>
        ) : null}

        {/* STEP 3 — Set a new passphrase while Worker is in `recovering` state */}
        {step === 'new-passphrase' ? (
          <section data-view="s3" data-testid="recovery-step-new-passphrase">
            <h1 className="t-title-lg mb-2 text-ink">{t('step3.title')}</h1>
            <p className="t-body-lg mb-5" style={{ color: 'var(--muted)' }}>
              {t('step3.lead')}
            </p>

            <div
              className="mb-5 rounded-md p-4"
              id="s3-recovering-note"
              style={{ background: 'var(--pale-orange)' }}
              data-testid="recovery-recovering-note"
            >
              <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                <strong>{t('step3.recoveringNoteTitle')}</strong>{' '}
                {t('step3.recoveringNoteBody')}
              </p>
            </div>

            <form onSubmit={handleStep3Submit} noValidate>
              <div className="card mb-4 p-6">
                <div className="mb-3">
                  <Field
                    ref={newPassInputRef}
                    id="recovery-new-passphrase"
                    type="password"
                    label={t('step3.passphraseLabel')}
                    hint={t('step3.passphraseHint')}
                    autoComplete="new-password"
                    value={newPassphrase}
                    disabled={completingRecovery || vault.inFlight || isStep3RateLimited}
                    passwordToggleLabels={{
                      show: t('step3.showPassphrase'),
                      hide: t('step3.hidePassphrase'),
                    }}
                    error={
                      step3PolicyReason && step3PolicyReason !== 'mismatch'
                        ? (step3PolicyErrorText ?? undefined)
                        : undefined
                    }
                    onChange={(e) => {
                      setNewPassphrase(e.target.value);
                      if (step3PolicyReason) setStep3PolicyReason(null);
                      if (preparedCompleteBundle && !preparedCompleteBundle.sentAtLeastOnce) {
                        setPreparedCompleteBundle(null);
                      }
                    }}
                    data-vault-secret="true"
                    data-testid="recovery-new-passphrase-input"
                  />
                </div>

                {/* Strength meter */}
                <div
                  className="mb-4 flex items-center gap-2"
                  role="region"
                  aria-label={t('step3.strengthMeterLabel')}
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
                      data-testid="recovery-passphrase-strength-bar"
                      data-score={policyScore}
                      data-meets-length={meetsMinLength}
                      data-meets-score={meetsMinScore}
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
                    data-testid="recovery-passphrase-strength-label"
                    className="text-[12px]"
                    style={{ color: 'var(--body)' }}
                  >
                    {strengthLabel}
                  </span>
                </div>

                <div className="mb-6">
                  <Field
                    ref={confirmPassInputRef}
                    id="recovery-confirm-passphrase"
                    type="password"
                    label={t('step3.confirmLabel')}
                    autoComplete="new-password"
                    value={confirmPassphrase}
                    disabled={completingRecovery || vault.inFlight || isStep3RateLimited}
                    passwordToggleLabels={{
                      show: t('step3.showPassphrase'),
                      hide: t('step3.hidePassphrase'),
                    }}
                    error={
                      step3PolicyReason === 'mismatch'
                        ? (step3PolicyErrorText ?? undefined)
                        : undefined
                    }
                    onChange={(e) => {
                      setConfirmPassphrase(e.target.value);
                      if (step3PolicyReason) setStep3PolicyReason(null);
                      if (preparedCompleteBundle && !preparedCompleteBundle.sentAtLeastOnce) {
                        setPreparedCompleteBundle(null);
                      }
                    }}
                    data-vault-secret="true"
                    data-testid="recovery-confirm-passphrase-input"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="tertiary"
                    disabled={completingRecovery}
                    onClick={() => void handleCancelRecovery()}
                    data-testid="recovery-step3-cancel"
                  >
                    {t('step3.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    className="ml-auto"
                    disabled={completingRecovery || vault.inFlight || isStep3RateLimited}
                    data-testid="recovery-step3-submit"
                  >
                    {completingRecovery ? t('step3.submitting') : t('step3.submit')}
                  </Button>
                </div>
              </div>
            </form>

            {/* Step 3 error states matching mockups/recovery.html (s3-err) */}
            {step3Error?.kind === 'reauth_expired_password' ? (
              <div
                id="s3-reauth-expired-password"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--warning)' }}
                data-testid="recovery-error-reauth-expired-password"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.reauthExpiredPasswordBadge')}
                </p>
                <div role="alert" className="mb-3">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step3.errors.reauthExpiredPasswordTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {t('step3.errors.reauthExpiredPasswordBody')}
                  </p>
                </div>
                <form onSubmit={handleStep3InPlacePasswordReauth} noValidate>
                  <Field
                    ref={step3ReauthPassInputRef}
                    id="s3-reauth-password"
                    type="password"
                    label={t('step3.errors.reauthExpiredPasswordLabel')}
                    autoComplete="current-password"
                    value={step3ReauthPassword}
                    disabled={reauth.submitting || completingRecovery}
                    onChange={(e) => setStep3ReauthPassword(e.target.value)}
                    wrapperClassName="mb-3"
                    data-vault-secret="true"
                    data-testid="recovery-step3-reauth-password-input"
                  />
                  {reauth.error ? (
                    <AuthStatus tone="error" className="mb-3">
                      {reauth.error}
                    </AuthStatus>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      reauth.submitting ||
                      completingRecovery ||
                      step3ReauthPassword.length === 0
                    }
                    data-testid="recovery-step3-reauth-password-submit"
                  >
                    {reauth.submitting
                      ? t('step3.errors.reauthExpiredPasswordSubmitting')
                      : t('step3.errors.reauthExpiredPasswordSubmit')}
                  </Button>
                </form>
              </div>
            ) : null}

            {step3Error?.kind === 'reauth_expired_oauth' ? (
              <div
                id="s3-reauth-expired-oauth"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-reauth-expired-oauth"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.reauthExpiredOauthBadge')}
                </p>
                <div role="alert" className="auth-alert mb-3">
                  <p
                    className="m-0 mb-1 text-[14px] font-semibold"
                    style={{ color: 'var(--body)' }}
                  >
                    {t('step3.errors.reauthExpiredOauthTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                    {t('step3.errors.reauthExpiredOauthBody')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleStep3OauthRestart()}
                  data-testid="recovery-step3-oauth-restart-button"
                >
                  {t('step3.errors.reauthExpiredOauthRestart')}
                </Button>
              </div>
            ) : null}

            {step3Error?.kind === 'insufficient_memory' ? (
              <div
                id="s3-err-oom"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-oom"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.oomBadge')}
                </p>
                <div role="alert" className="auth-alert">
                  <p
                    className="m-0 mb-1 text-[14px] font-semibold"
                    style={{ color: 'var(--body)' }}
                  >
                    {t('step3.errors.oomTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                    {t('step3.errors.oomBody')}
                  </p>
                </div>
              </div>
            ) : null}

            {step3Error?.kind === 'version_mismatch' ||
            step3Error?.kind === 'precondition_required' ||
            step3Error?.kind === 'idempotency_conflict' ? (
              <div
                id="s3-err-version"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-version-mismatch"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {step3Error.kind === 'version_mismatch'
                    ? t('step3.errors.versionMismatchBadge')
                    : step3Error.kind === 'precondition_required'
                      ? t('step3.errors.preconditionBadge')
                      : t('step3.errors.idempotencyConflictBadge')}
                </p>
                <div role="alert" className="auth-alert mb-3">
                  <p
                    className="m-0 mb-1 text-[14px] font-semibold"
                    style={{ color: 'var(--body)' }}
                  >
                    {step3Error.kind === 'version_mismatch'
                      ? t('step3.errors.versionMismatchTitle')
                      : step3Error.kind === 'precondition_required'
                        ? t('step3.errors.preconditionTitle')
                        : t('step3.errors.idempotencyConflictTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                    {step3Error.kind === 'version_mismatch'
                      ? t('step3.errors.versionMismatchBody')
                      : step3Error.kind === 'precondition_required'
                        ? t('step3.errors.preconditionBody')
                        : t('step3.errors.idempotencyConflictBody')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleStep3ReloadAndRestart()}
                  data-testid="recovery-version-mismatch-reload-button"
                >
                  {t('step3.errors.versionMismatchReloadCta')}
                </Button>
              </div>
            ) : null}

            {step3Error?.kind === 'idempotency_in_progress' ? (
              <div
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--warning)' }}
                data-testid="recovery-error-in-progress"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.idempotencyInProgressBadge')}
                </p>
                <div role="alert" className="mb-3">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step3.errors.idempotencyInProgressTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {t('step3.errors.idempotencyInProgressBody')}
                  </p>
                </div>
                {preparedCompleteBundle ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void executeCompleteRequest(preparedCompleteBundle)}
                    disabled={completingRecovery}
                    data-testid="recovery-step3-retry-button"
                  >
                    {t('step3.errors.retryCta')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {step3Error?.kind === 'mutations_disabled' ? (
              <div
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-mutations-disabled"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.mutationsDisabledBadge')}
                </p>
                <div role="alert">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step3.errors.mutationsDisabledTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {t('step3.errors.mutationsDisabledBody')}
                  </p>
                </div>
              </div>
            ) : null}

            {step3Error?.kind === 'rate_limited' ? (
              <div
                id="s3-err-rate"
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--warning)' }}
                data-testid="recovery-error-complete-rate-limited"
              >
                <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                  {t('step3.errors.rateLimitedBadge')}
                </p>
                <div role="alert">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step3.errors.rateLimitedTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {t('step3.errors.rateLimitedBody', {
                      clock: formatRetryClock(effectiveStep3RateSeconds),
                      seconds: effectiveStep3RateSeconds,
                    })}
                  </p>
                </div>
              </div>
            ) : null}

            {step3Error?.kind === 'network' ? (
              <div
                className="card mb-4 p-5"
                style={{ borderColor: 'var(--error)' }}
                data-testid="recovery-error-complete-network"
              >
                <div role="alert" className="mb-3">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('step3.errors.networkTitle')}
                  </p>
                  <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
                    {step3Error.detail ?? t('step3.errors.networkBody')}
                  </p>
                </div>
                {preparedCompleteBundle ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void executeCompleteRequest(preparedCompleteBundle)}
                    disabled={completingRecovery}
                    data-testid="recovery-step3-retry-button"
                  >
                    {t('step3.errors.retryCta')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-md p-4" style={{ background: 'var(--surface)' }}>
              <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                {t('step3.footerNote')}
              </p>
            </div>
          </section>
        ) : null}

        {/* STEP 4A — Re-auth for `vault.recovery_keys_regenerate` before generating replacement keys */}
        {step === 'regenerate-reauth' ? (
          <section data-view="s4-reauth" data-testid="recovery-step-regenerate-reauth">
            <div
              className="mb-5 rounded-md p-4"
              style={{ background: 'var(--pale-accent)' }}
              data-testid="recovery-unlocked-banner"
            >
              <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                {emptySlots.length > 0
                  ? t('step4Reauth.unlockedBanner', {
                      remaining: remainingCount,
                      emptySlots: emptySlotsLabel,
                    })
                  : t('step4Reauth.allFullBanner')}
              </p>
            </div>

            <h1 className="t-title-lg mb-2 text-ink">{t('step4Reauth.title')}</h1>
            <p className="t-body-lg mb-5" style={{ color: 'var(--muted)' }}>
              {t('step4Reauth.lead')}
            </p>

            <div className="card mb-5 p-5" id="s4-regenerate-reauth">
              <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
                {t('step4Reauth.cardBadge')}
              </p>
              <p className="m-0 mb-3 text-[13px]" style={{ color: 'var(--body)' }}>
                {t('step4Reauth.cardBody')}
              </p>

              {reauth.capabilities.hasPassword ? (
                <form onSubmit={handleStep4PasswordReauth} noValidate>
                  <Field
                    ref={step4ReauthPassInputRef}
                    id="s4-reauth-pwd"
                    type="password"
                    label={t('step4Reauth.passwordLabel')}
                    autoComplete="current-password"
                    value={step4ReauthPassword}
                    disabled={reauth.submitting || generatingRegenKeys}
                    onChange={(e) => setStep4ReauthPassword(e.target.value)}
                    wrapperClassName="mb-3"
                    data-vault-secret="true"
                    data-testid="recovery-step4-reauth-password-input"
                  />
                  {reauth.error ? (
                    <AuthStatus tone="error" className="mb-3">
                      {reauth.error}
                    </AuthStatus>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={
                        reauth.submitting ||
                        generatingRegenKeys ||
                        step4ReauthPassword.length === 0
                      }
                      data-testid="recovery-step4-reauth-password-submit"
                    >
                      {reauth.submitting || generatingRegenKeys
                        ? t('step4Reauth.confirming')
                        : t('step4Reauth.confirmPassword')}
                    </Button>
                    {reauth.capabilities.oauthReauthProviders.includes('google') ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleStep4GoogleReauth()}
                        disabled={reauth.submitting || generatingRegenKeys}
                        data-testid="recovery-step4-reauth-google-button"
                      >
                        {t('step4Reauth.confirmGoogle')}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="tertiary"
                      className="ml-auto"
                      onClick={handleSkipRegenerate}
                      data-testid="recovery-step4-skip-button"
                    >
                      {t('step4Reauth.skip', { remaining: remainingCount })}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {reauth.capabilities.oauthReauthProviders.includes('google') ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void handleStep4GoogleReauth()}
                      disabled={reauth.submitting || generatingRegenKeys}
                      data-testid="recovery-step4-reauth-google-button"
                    >
                      {t('step4Reauth.confirmGoogle')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="tertiary"
                    className="ml-auto"
                    onClick={handleSkipRegenerate}
                    data-testid="recovery-step4-skip-button"
                  >
                    {t('step4Reauth.skip', { remaining: remainingCount })}
                  </Button>
                </div>
              )}
            </div>

            <p className="t-caption m-0 mb-3" style={{ color: 'var(--muted)' }}>
              {t('step4Reauth.googleCaption')}
            </p>
            <p className="t-caption m-0" style={{ color: 'var(--muted)' }}>
              {t('step4Reauth.skipCaption', { remaining: remainingCount })}
            </p>
          </section>
        ) : null}

        {/* STEP 4B — Replacement recovery keys for empty slots (reusing RecoveryKeysSheet) */}
        {step === 'regenerate-keys' && preparedRegenBundle ? (
          <section data-view="s4" data-testid="recovery-step-regenerate-keys">
            <div
              className="mb-5 rounded-md p-4"
              style={{ background: 'var(--pale-accent)' }}
            >
              <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                {t('step4.unlockedBanner', {
                  remaining: remainingCount,
                  emptySlots: emptySlotsLabel,
                })}
              </p>
            </div>

            <h1 className="t-title-lg mb-2 text-ink">{t('step4.title')}</h1>
            <p className="t-body-lg mb-5" style={{ color: 'var(--muted)' }}>
              {t('step4.lead', { remaining: remainingCount })}
            </p>

            {/* Slot chips 1..10 highlighting only the newly generated empty slots */}
            <div
              className="mb-4 flex flex-wrap gap-1.5"
              data-testid="recovery-regenerate-slot-chips"
            >
              {Array.from({ length: 10 }, (_, idx) => {
                const slot = idx + 1;
                const isNew = preparedRegenBundle.emptySlots.includes(slot);
                return (
                  <span
                    key={slot}
                    className={`chip !font-mono ${isNew ? 'chip-accent' : ''}`}
                    data-testid={`recovery-slot-chip-${slot}`}
                    data-slot-new={isNew}
                  >
                    {isNew
                      ? t('step4.slotNewChip', { slot })
                      : t('step4.slotExistingChip', { slot })}
                  </span>
                );
              })}
            </div>

            <p className="t-caption mb-3" style={{ color: 'var(--muted)' }}>
              {t('step4.newKeyCaption', { emptySlots: emptySlotsLabel })}
            </p>

            <RecoveryKeysSheet
              keys={preparedRegenBundle.displayRecoveryKeys}
              accountEmail={me?.user.email}
              confirmedSaved={confirmedRegenSaved}
              onConfirmedSavedChange={setConfirmedRegenSaved}
              disabled={savingRegenKeys || isStep4RateLimited}
              checkboxId={regenCheckboxId}
              labels={{
                gridLabel: t('step4.gridLabel'),
                slotLabel: (slot) => t('step4.slotLabel', { slot }),
                screenshotWarningStrong: t('step4.screenshotWarningStrong'),
                screenshotWarningBody: t('step4.screenshotWarningBody'),
                downloadTxt: t('step4.downloadTxt'),
                print: t('step4.print'),
                copyAll: t('step4.copyAll'),
                downloadedStatus: t('step4.downloadedStatus'),
                printedStatus: t('step4.printedStatus'),
                copiedStatus: t('step4.copiedStatus'),
                confirmSavedLabel: t('step4.confirmSavedLabel', {
                  emptySlots: emptySlotsLabel,
                  remaining: remainingCount,
                }),
              }}
            />

            {step4Error ? (
              <div
                role="alert"
                className="auth-alert mb-4"
                data-testid="recovery-step4-error"
              >
                <p
                  className="m-0 mb-1 text-[14px] font-semibold"
                  style={{ color: 'var(--body)' }}
                >
                  {step4Error.kind === 'version_mismatch' &&
                    t('step4.errors.versionMismatchTitle')}
                  {step4Error.kind === 'slot_taken' && t('step4.errors.slotTakenTitle')}
                  {step4Error.kind === 'rate_limited' && t('step4.errors.rateLimitedTitle')}
                  {step4Error.kind === 'reauth_expired_password' &&
                    t('step4.errors.reauthExpiredPasswordTitle')}
                  {step4Error.kind === 'reauth_expired_oauth' &&
                    t('step4.errors.reauthExpiredOauthTitle')}
                  {step4Error.kind === 'network' && t('step4.errors.networkTitle')}
                </p>
                <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
                  {step4Error.kind === 'version_mismatch' &&
                    t('step4.errors.versionMismatchBody')}
                  {step4Error.kind === 'slot_taken' && t('step4.errors.slotTakenBody')}
                  {step4Error.kind === 'rate_limited' &&
                    t('step4.errors.rateLimitedBody', {
                      clock: formatRetryClock(effectiveStep4RateSeconds),
                      seconds: effectiveStep4RateSeconds,
                    })}
                  {step4Error.kind === 'network' &&
                    (step4Error.detail ?? t('step4.errors.networkBody'))}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="tertiary"
                onClick={handleSkipRegenerate}
                disabled={savingRegenKeys}
                data-testid="recovery-step4-keys-skip-button"
              >
                {t('step4.skip', { remaining: remainingCount })}
              </Button>
              <Button
                type="button"
                variant="primary"
                className="ml-auto"
                id="s4DoneBtn"
                disabled={
                  !confirmedRegenSaved || savingRegenKeys || isStep4RateLimited
                }
                onClick={() => void handleStep4SaveRegenKeys()}
                data-testid="recovery-step4-save-button"
              >
                {savingRegenKeys ? t('step4.saving') : t('step4.save')}
              </Button>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}
