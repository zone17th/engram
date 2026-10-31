'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  checkPassphrasePolicy,
  type PassphrasePolicyResult,
} from '@/features/vault/passphrase-policy';
import { useVault } from '@/features/vault/vault-provider';
import { reauthPassword, type ReauthGrant } from '@/lib/api/auth';
import {
  createIdempotencyKey,
  formatVaultIfMatch,
  rewrapVault,
  type VaultState,
} from '@/lib/api/vault';
import type { RewrapResult } from '@/lib/crypto/protocol';
import {
  classifyVaultSettingsError,
  hasGrantMinRemainingTtl,
  type ClassifiedVaultSettingsError,
} from './vault-security-errors';

export interface ChangePassphraseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultMeta: VaultState | null;
  remainingRecoveryKeys: number | null;
  passkeysCount: number;
  onSuccessToast?: (message: string) => void;
  onOpenSignOutOthers?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

type ChangePassphraseStep = 'form' | 'reauth_expired' | 'mismatch' | 'oom' | 'ratelimit' | 'done';

export function ChangePassphraseDialog({
  open,
  onOpenChange,
  vaultMeta,
  remainingRecoveryKeys,
  passkeysCount,
  onSuccessToast,
  onOpenSignOutOthers,
  returnFocusRef,
}: ChangePassphraseDialogProps) {
  const t = useTranslations('settings.vaultSecurity');
  const { me, reauth } = useSession();
  const {
    inFlight,
    vaultMeta: providerVaultMeta,
    registerSecretFormReset,
    beginOp,
    rewrap,
    notifyVaultChanged,
    reloadVaultMeta,
  } = useVault();
  const skipFocusReturnRef = useRef(false);

  const [step, setStep] = useState<ChangePassphraseStep>('form');
  const [loginPassword, setLoginPassword] = useState('');
  const [inlineReauthPassword, setInlineReauthPassword] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [policyResult, setPolicyResult] = useState<PassphrasePolicyResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [classifiedError, setClassifiedError] = useState<ClassifiedVaultSettingsError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadingVault, setReloadingVault] = useState(false);

  const inFlightGuardRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const pendingRewrapResultRef = useRef<RewrapResult | null>(null);
  const activeGrantRef = useRef<ReauthGrant | null>(null);
  const policySeqRef = useRef(0);
  const wasOpenRef = useRef(false);

  const hasPassword = reauth.capabilities.hasPassword;
  const hasGoogleOauth = reauth.capabilities.oauthReauthProviders.includes('google');
  const isOauthOnly = !hasPassword && hasGoogleOauth;
  const hasActiveRewrapGrant = Boolean(
    reauth.grant &&
      reauth.grant.action === 'vault.rewrap' &&
      hasGrantMinRemainingTtl(reauth.grant.expires_at, 1_000),
  );

  // Input-only wipe: clears every secret field (and the derived policy result) but keeps operation identity.
  const wipeSecretInputs = useCallback(() => {
    setLoginPassword('');
    setInlineReauthPassword('');
    setNewPassphrase('');
    setConfirmPassphrase('');
    setPolicyResult(null);
  }, []);

  const wipeSecretState = useCallback(() => {
    wipeSecretInputs();
    pendingRewrapResultRef.current = null;
    activeGrantRef.current = null;
  }, [wipeSecretInputs]);

  const resetDialogState = useCallback(() => {
    wipeSecretState();
    setStep('form');
    setErrorMessage(null);
    setClassifiedError(null);
    setSubmitting(false);
    inFlightGuardRef.current = false;
    idempotencyKeyRef.current = null;
  }, [wipeSecretState]);

  // Register secret form reset on vault lock / logout (R1-7: also clear idempotencyKeyRef, pendingRewrapResultRef, and return to form step)
  // R9-4: while an operation is in flight (provider wake / lock wipe) only the secret inputs are wiped; the
  // step, loading state, close guard, Idempotency-Key, derived rewrap result and grant stay until the
  // operation's own settlement path (`finally`) clears them.
  useEffect(() => {
    return registerSecretFormReset(() => {
      if (inFlightGuardRef.current) {
        wipeSecretInputs();
        return;
      }
      resetDialogState();
    });
  }, [registerSecretFormReset, resetDialogState, wipeSecretInputs]);

  // Obtain / begin re-auth (`vault.rewrap`) WHEN THE DIALOG OPENS, before any secret goes to the Worker (plan §1).
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      resetDialogState();
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    if (!reauth.hasUsableGrant('vault.rewrap')) {
      void reauth.begin('vault.rewrap', '/app/settings').catch(() => undefined);
    }
  }, [open, reauth, resetDialogState]);

  // Evaluate passphrase policy asynchronously on every input change using the shared helper
  useEffect(() => {
    if (!open) return;
    if (newPassphrase.length === 0 && confirmPassphrase.length === 0) {
      setPolicyResult(null);
      return;
    }
    const seq = ++policySeqRef.current;
    const emailLocal = me?.user.email.split('@')[0] ?? '';
    void checkPassphrasePolicy(newPassphrase, {
      confirmPassphrase,
      userInputs: emailLocal ? [emailLocal, me?.user.email ?? ''] : [],
    })
      .then((res) => {
        if (policySeqRef.current === seq) {
          setPolicyResult(res);
        }
      })
      .catch(() => undefined);
  }, [confirmPassphrase, me?.user.email, newPassphrase, open]);

  const handleClose = useCallback(() => {
    if (submitting || inFlightGuardRef.current) return;
    if (reauth.pendingAction === 'vault.rewrap') {
      reauth.cancel();
    }
    resetDialogState();
    onOpenChange(false);
  }, [onOpenChange, reauth, resetDialogState, submitting]);

  const executePutKek = useCallback(
    async (rewrapped: RewrapResult, grantToken: string) => {
      const currentMeta = vaultMeta ?? providerVaultMeta;
      if (!currentMeta) {
        throw new Error('Missing vault metadata for If-Match');
      }
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = createIdempotencyKey();
      }
      const ifMatch = formatVaultIfMatch(currentMeta.vault_key_id, currentMeta.version);
      const response = await rewrapVault(
        {
          kdf: rewrapped.kdf,
          vault_key_wrapped_by_kek: rewrapped.vault_key_wrapped_by_kek,
        },
        {
          ifMatch,
          idempotencyKey: idempotencyKeyRef.current,
          reauthToken: grantToken,
        },
      );

      notifyVaultChanged({
        vault_key_id: currentMeta.vault_key_id,
        version: response.version,
      });
      // R1-2: reload GET /vault best-effort so the acting tab's cached `vaultMeta` reflects the new kdf.salt and wrap
      await reloadVaultMeta().catch(() => undefined);
      wipeSecretState();
      idempotencyKeyRef.current = null;
      reauth.clearGrant();
      onSuccessToast?.(t('passphrase.toastUpdated'));
      // R1-8: route through the mockup's 'done' step (`data-view="pass-done"`) before closing
      setStep('done');
    },
    [notifyVaultChanged, onSuccessToast, providerVaultMeta, reauth, reloadVaultMeta, t, vaultMeta, wipeSecretState],
  );

  const handleError = useCallback(
    (err: unknown, options: { isReauthStep?: boolean } = {}) => {
      const classified = classifyVaultSettingsError(err, options);
      setClassifiedError(classified);
      if (!classified.canRetrySameOperation) {
        idempotencyKeyRef.current = null;
        pendingRewrapResultRef.current = null;
      }

      switch (classified.kind) {
        case 'version_mismatch':
          setStep('mismatch');
          void reloadVaultMeta().catch(() => undefined);
          return;
        case 'insufficient_memory':
          setStep('oom');
          return;
        case 'rate_limited':
          setStep('ratelimit');
          return;
        case 'reauth_expired':
          setStep('reauth_expired');
          return;
        case 'reauth_failed':
          setErrorMessage(t('errors.reauthFailed'));
          return;
        case 'precondition_required':
          setErrorMessage(t('errors.preconditionRequired'));
          return;
        case 'idempotency_conflict':
          setErrorMessage(t('errors.idempotencyConflict'));
          return;
        case 'idempotency_in_progress':
          setErrorMessage(t('errors.idempotencyInProgress'));
          return;
        case 'kill_switch_disabled':
          setErrorMessage(t('errors.killSwitchDisabled'));
          return;
        case 'client_busy':
          setErrorMessage(t('errors.clientBusy'));
          return;
        case 'vault_recovering':
          setErrorMessage(t('errors.vaultRecovering'));
          return;
        case 'vault_locked':
          setErrorMessage(t('errors.vaultLocked'));
          return;
        case 'stale_generation':
          setErrorMessage(t('errors.staleGeneration'));
          return;
        case 'passphrase_invalid':
          setErrorMessage(t('errors.passphraseInvalid'));
          return;
        case 'network':
          setErrorMessage(t('errors.networkError'));
          return;
        default:
          setErrorMessage(t('errors.genericError'));
      }
    },
    [reloadVaultMeta, t],
  );

  const handleSubmitForm = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || inFlight) return;
    // R1-4: set single-flight guard synchronously BEFORE the first await (`checkPassphrasePolicy`)
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    setClassifiedError(null);

    try {
      // 1. Validate passphrase policy using shared NFC policy helper before any API or Worker call
      // (skip when retrying an already-derived pendingRewrapResult after a network / rate-limit error).
      if (!pendingRewrapResultRef.current) {
        const emailLocal = me?.user.email.split('@')[0] ?? '';
        const policy = await checkPassphrasePolicy(newPassphrase, {
          confirmPassphrase,
          userInputs: emailLocal ? [emailLocal, me?.user.email ?? ''] : [],
        });
        setPolicyResult(policy);
        const matchesLoginPwd = Boolean(
          loginPassword.length > 0 &&
            newPassphrase.normalize('NFC') === loginPassword.normalize('NFC'),
        );
        if (!policy.valid || matchesLoginPwd) {
          if (matchesLoginPwd) {
            setErrorMessage(t('passphrase.policyDistinct'));
          } else if (policy.reason === 'invalid_unicode') {
            setErrorMessage(t('errors.passphraseInvalid'));
          } else if (policy.reason === 'too_short') {
            setErrorMessage(t('passphrase.policyTooShort'));
          } else if (policy.reason === 'mismatch') {
            setErrorMessage(t('passphrase.policyMismatch'));
          } else {
            setErrorMessage(t('passphrase.policyTooWeak'));
          }
          return;
        }
      }

      // 2. Capture immutable opGeneration BEFORE the first await of the operation (ADR 0002 §10.2)
      const { opGeneration, isCurrent } = beginOp();

      // 3. Obtain re-auth grant (`vault.rewrap`) BEFORE sending passphrase to Worker (plan §1)
      const candidateGrant = activeGrantRef.current ?? reauth.grant;
      let activeGrant =
        candidateGrant &&
        candidateGrant.action === 'vault.rewrap' &&
        hasGrantMinRemainingTtl(candidateGrant.expires_at)
          ? candidateGrant
          : null;

      if (!activeGrant) {
        if (hasPassword) {
          if (!loginPassword) {
            setErrorMessage(t('reauth.passwordHint'));
            return;
          }
          try {
            activeGrant = await reauthPassword('vault.rewrap', loginPassword);
            activeGrantRef.current = activeGrant;
            setLoginPassword('');
          } catch (reauthErr) {
            // Re-auth failed -> surface distinct error/rate-limit message and do NOT call Worker or PUT /vault/kek (R1-3, R2-2)
            handleError(reauthErr, { isReauthStep: true });
            return;
          }
        } else {
          // OAuth-only without usable grant must re-authenticate first or restart if expired
          setStep('reauth_expired');
          return;
        }
      }

      if (!isCurrent()) {
        setErrorMessage(t('errors.staleGeneration'));
        return;
      }

      const currentMeta = vaultMeta ?? providerVaultMeta;
      if (!currentMeta) {
        setErrorMessage(t('errors.genericError'));
        return;
      }

      // 4. Derive new KEK & wrap VK inside Worker if not already derived for this retry
      let rewrapped = pendingRewrapResultRef.current;
      if (!rewrapped) {
        const passphraseToTransfer = newPassphrase;
        // Clear passphrase input strings immediately as we hand off to Worker
        setNewPassphrase('');
        setConfirmPassphrase('');
        rewrapped = await rewrap({
          passphrase: passphraseToTransfer,
          currentKdf: currentMeta.kdf,
          opGeneration,
        });
        pendingRewrapResultRef.current = rewrapped;
      }

      // 5. Before POST/PUT, verify grant still has >= 60 s left (plan §1)
      if (!hasGrantMinRemainingTtl(activeGrant.expires_at)) {
        if (!hasPassword) {
          pendingRewrapResultRef.current = null;
        }
        setStep('reauth_expired');
        return;
      }

      // 6. PUT /vault/kek with If-Match and reused per-operation Idempotency-Key
      await executePutKek(rewrapped, activeGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [
    beginOp,
    confirmPassphrase,
    executePutKek,
    handleError,
    hasPassword,
    inFlight,
    loginPassword,
    me?.user.email,
    newPassphrase,
    providerVaultMeta,
    reauth,
    rewrap,
    submitting,
    t,
    vaultMeta,
  ]);

  const handleInlineReauthAndSave = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !inlineReauthPassword) return;
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      let freshGrant: ReauthGrant;
      try {
        freshGrant = await reauthPassword('vault.rewrap', inlineReauthPassword);
      } catch (reauthErr) {
        handleError(reauthErr, { isReauthStep: true });
        return;
      }
      activeGrantRef.current = freshGrant;
      setInlineReauthPassword('');
      const rewrapped = pendingRewrapResultRef.current;
      if (!rewrapped) {
        setStep('form');
        return;
      }
      await executePutKek(rewrapped, freshGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [executePutKek, handleError, inlineReauthPassword, submitting]);

  const handleRestartOauthFlow = useCallback(() => {
    wipeSecretState();
    idempotencyKeyRef.current = null;
    setErrorMessage(null);
    setClassifiedError(null);
    setStep('form');
    void reauth.begin('vault.rewrap', '/app/settings').catch(() => undefined);
  }, [reauth, wipeSecretState]);

  const handleReloadVault = useCallback(async () => {
    setReloadingVault(true);
    try {
      await reloadVaultMeta();
      onSuccessToast?.(t('common.vaultReloadedToast'));
      handleClose();
    } catch {
      handleClose();
    } finally {
      setReloadingVault(false);
    }
  }, [handleClose, onSuccessToast, reloadVaultMeta, t]);

  const strengthPercent = policyResult ? Math.min(100, Math.round(((policyResult.score + 1) / 5) * 100)) : 0;
  const isStrong = Boolean(policyResult?.meetsMinScore && policyResult?.meetsMinLength);
  const isDistinctFromLogin = Boolean(
    newPassphrase.length > 0 &&
      loginPassword.length > 0 &&
      newPassphrase.normalize('NFC') !== loginPassword.normalize('NFC'),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent
        id="passDlg"
        aria-labelledby="passDlgTitle"
        onCloseAutoFocus={(event) => {
          if (skipFocusReturnRef.current) return;
          const opener = returnFocusRef?.current;
          if (opener && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <div
          className="panel"
          style={{ width: 'min(560px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: '28px' }}
        >
          <DialogHeader
            title={<span id="passDlgTitle">{t('passphrase.dialogTitle')}</span>}
            description={t('passphrase.dialogDescription')}
            className="mb-4"
          />

          {step === 'form' && (
            <section data-view="pass-form">
              {isOauthOnly && !hasActiveRewrapGrant ? (
                <div className="card mb-4 p-4" data-view="pass-oauth">
                  <p className="t-label mb-2 text-muted">{t('reauth.oauthLabel')}</p>
                  <p className="m-0 mb-3 text-[13px] text-body">{t('reauth.oauthBody')}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="mb-3 w-full !justify-center"
                    disabled={submitting}
                    onClick={() => void reauth.startOauthReauth('google', '/app/settings')}
                  >
                    {t('reauth.oauthButton')}
                  </Button>
                  <p className="m-0 text-[12px] text-muted">{t('reauth.oauthRedirectHint')}</p>
                </div>
              ) : (
                <>
                  {hasPassword && !hasActiveRewrapGrant && (
                    <div className="mb-4 rounded-md bg-surface p-3.5">
                      <p className="t-label mb-2 text-muted">{t('reauth.stepLabel')}</p>
                      <Field
                        id="pass-login-pwd"
                        label={t('reauth.passwordLabel')}
                        type="password"
                        autoComplete="current-password"
                        data-vault-secret="true"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        hint={t('reauth.passwordHint')}
                        passwordToggleLabels={{ show: t('common.show'), hide: t('common.hide') }}
                        disabled={submitting}
                        wrapperClassName="mb-0"
                      />
                    </div>
                  )}

                  <Field
                    id="pass-new-pp"
                    label={t('passphrase.newLabel')}
                    type="password"
                    autoComplete="new-password"
                    data-vault-secret="true"
                    value={newPassphrase}
                    onChange={(e) => setNewPassphrase(e.target.value)}
                    passwordToggleLabels={{ show: t('common.show'), hide: t('common.hide') }}
                    disabled={submitting}
                    wrapperClassName="mb-2"
                  />

                  <div
                    className="mb-4 flex items-center gap-2"
                    data-testid="passphrase-strength-bar"
                  >
                    <div
                      role="progressbar"
                      aria-label={t('passphrase.strengthMeterLabel')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={strengthPercent}
                      aria-valuetext={
                        isStrong ? t('passphrase.strengthStrong') : t('passphrase.strengthWeak')
                      }
                      style={{
                        height: '4px',
                        flex: 1,
                        borderRadius: 'var(--r-pill)',
                        background: 'var(--border)',
                      }}
                    >
                      <div
                        style={{
                          height: '4px',
                          width: `${strengthPercent}%`,
                          borderRadius: 'var(--r-pill)',
                          background: isStrong ? 'var(--success)' : 'var(--warning)',
                        }}
                      />
                    </div>
                    <span className="text-[12px] text-body" aria-live="polite">
                      {isStrong ? t('passphrase.strengthStrong') : t('passphrase.strengthWeak')}
                    </span>
                  </div>

                  <Field
                    id="pass-confirm-pp"
                    label={t('passphrase.confirmLabel')}
                    type="password"
                    autoComplete="new-password"
                    data-vault-secret="true"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    passwordToggleLabels={{ show: t('common.show'), hide: t('common.hide') }}
                    disabled={submitting}
                    wrapperClassName="mb-4"
                  />

                  <ul className="m-0 mb-4 flex list-none flex-col gap-1 p-0 text-[12px] text-muted">
                    <li>
                      <span
                        aria-hidden="true"
                        className={policyResult?.meetsMinLength ? 'text-body' : 'text-muted'}
                      >
                        {policyResult?.meetsMinLength ? '✓' : '○'}
                      </span>{' '}
                      <span className="sr-only">
                        {policyResult?.meetsMinLength
                          ? t('passphrase.policyMet')
                          : t('passphrase.policyNotMet')}
                        :{' '}
                      </span>
                      {t('passphrase.policyMinLength')}
                    </li>
                    <li>
                      <span
                        aria-hidden="true"
                        className={isDistinctFromLogin ? 'text-body' : 'text-muted'}
                      >
                        {isDistinctFromLogin ? '✓' : '○'}
                      </span>{' '}
                      <span className="sr-only">
                        {isDistinctFromLogin
                          ? t('passphrase.policyMet')
                          : t('passphrase.policyNotMet')}
                        :{' '}
                      </span>
                      {t('passphrase.policyDistinct')}
                    </li>
                    <li>
                      <span
                        aria-hidden="true"
                        className={policyResult?.meetsMinScore ? 'text-body' : 'text-muted'}
                      >
                        {policyResult?.meetsMinScore ? '✓' : '○'}
                      </span>{' '}
                      <span className="sr-only">
                        {policyResult?.meetsMinScore
                          ? t('passphrase.policyMet')
                          : t('passphrase.policyNotMet')}
                        :{' '}
                      </span>
                      {t('passphrase.policyScore')}
                    </li>
                  </ul>

                  <div className="mb-5 rounded-md bg-surface p-3.5">
                    <p className="m-0 text-[13px] text-body">
                      {remainingRecoveryKeys !== null
                        ? t('passphrase.preserveNote', {
                            remaining: remainingRecoveryKeys,
                            passkeys: passkeysCount,
                          })
                        : t('passphrase.preserveNoteUnknown', {
                            passkeys: passkeysCount,
                          })}
                    </p>
                  </div>
                </>
              )}

              {errorMessage && (
                <AuthStatus tone="error" className="mb-4">
                  {errorMessage}
                </AuthStatus>
              )}

              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose} disabled={submitting}>
                  {t('common.cancel')}
                </Button>
                {(!isOauthOnly || hasActiveRewrapGrant) && (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={submitting || inFlight}
                    aria-busy={submitting}
                    onClick={() => void handleSubmitForm()}
                  >
                    {submitting
                      ? t('passphrase.submittingButton')
                      : classifiedError?.canRetrySameOperation && pendingRewrapResultRef.current
                        ? t('common.retry')
                        : t('passphrase.submitButton')}
                  </Button>
                )}
              </DialogFooter>
            </section>
          )}

          {step === 'oom' && (
            <section data-view="pass-oom">
              <div className="card mb-5 border-error p-5">
                <p className="t-label mb-2 text-muted">Argon2id 64 MiB · derive error</p>
                <AuthStatus tone="error" className="mb-0">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">{t('errors.oomTitle')}</p>
                  <p className="m-0 text-[13px] text-body">{t('errors.oomBody')}</p>
                </AuthStatus>
              </div>
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setErrorMessage(null);
                    setClassifiedError(null);
                    setStep('form');
                  }}
                >
                  {t('common.retry')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 'reauth_expired' && (
            <section data-view="pass-reauth-expired">
              {hasPassword ? (
                <div className="card mb-4 border-warning p-4">
                  <p className="t-label mb-2 text-muted">{t('reauth.expiredPasswordLabel')}</p>
                  <div role="alert" className="mb-3">
                    <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                      {t('reauth.expiredPasswordTitle')}
                    </p>
                    <p className="m-0 text-[13px] text-body">{t('reauth.expiredPasswordBody')}</p>
                  </div>
                  <Field
                    id="pass-reauth-inline"
                    label={t('reauth.passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    data-vault-secret="true"
                    value={inlineReauthPassword}
                    onChange={(e) => setInlineReauthPassword(e.target.value)}
                    passwordToggleLabels={{ show: t('common.show'), hide: t('common.hide') }}
                    disabled={submitting}
                    wrapperClassName="mb-3"
                  />
                  {errorMessage && (
                    <AuthStatus tone="error" className="mb-3">
                      {errorMessage}
                    </AuthStatus>
                  )}
                  <Button
                    type="button"
                    variant="primary"
                    disabled={submitting || !inlineReauthPassword}
                    onClick={() => void handleInlineReauthAndSave()}
                  >
                    {t('reauth.expiredPasswordSubmit')}
                  </Button>
                </div>
              ) : (
                <div className="card mb-5 border-error p-4">
                  <p className="t-label mb-2 text-muted">{t('reauth.expiredOauthLabel')}</p>
                  <AuthStatus tone="error" className="mb-3">
                    <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                      {t('reauth.expiredOauthTitle')}
                    </p>
                    <p className="m-0 text-[13px] text-body">{t('reauth.expiredOauthBody')}</p>
                  </AuthStatus>
                  <Button type="button" variant="secondary" onClick={handleRestartOauthFlow}>
                    {t('common.restartFlow')}
                  </Button>
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.close')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 'mismatch' && (
            <section data-view="pass-mismatch">
              <div className="card mb-5 border-error p-5">
                <p className="t-label mb-2 text-muted">
                  <span className="mono">412 version_mismatch</span>
                </p>
                <AuthStatus tone="error" className="mb-0">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('errors.versionMismatchTitle')}
                  </p>
                  <p className="m-0 text-[13px] text-body">{t('errors.versionMismatchBody')}</p>
                </AuthStatus>
              </div>
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={reloadingVault}
                  onClick={() => void handleReloadVault()}
                >
                  {reloadingVault ? t('common.reloadingVault') : t('common.reloadVault')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 'ratelimit' && (
            <section data-view="pass-ratelimit">
              <div className="card mb-5 border-warning p-5">
                <p className="t-label mb-2 text-muted">
                  <span className="mono">429 rate_limited</span> ·{' '}
                  <span className="mono">Retry-After: {classifiedError?.retryAfterSeconds ?? 45}</span>
                </p>
                <AuthStatus tone="error" className="mb-0">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('errors.rateLimitedTitle')}
                  </p>
                  <p className="m-0 text-[13px] text-body">
                    {t('errors.rateLimitedBody', {
                      seconds: classifiedError?.retryAfterSeconds ?? 45,
                    })}
                  </p>
                </AuthStatus>
              </div>
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.close')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 'done' && (
            <section data-view="pass-done">
              <div className="card mb-5 p-5">
                <AuthStatus tone="sent" className="mb-2">
                  {t('passphrase.doneStatus')}
                </AuthStatus>
                <p className="m-0 mb-3 text-[13px] text-body">
                  {remainingRecoveryKeys !== null
                    ? t('passphrase.doneBody', {
                        remaining: remainingRecoveryKeys,
                        passkeys: passkeysCount,
                      })
                    : t('passphrase.doneBodyUnknown', {
                        passkeys: passkeysCount,
                      })}
                </p>
                {onOpenSignOutOthers && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      // Another dialog takes focus on purpose: do not return focus to the opener.
                      skipFocusReturnRef.current = true;
                      handleClose();
                      onOpenSignOutOthers();
                    }}
                  >
                    {t('passphrase.signOutOthersButton')}
                  </Button>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="primary" onClick={handleClose}>
                  {t('common.done')}
                </Button>
              </DialogFooter>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
