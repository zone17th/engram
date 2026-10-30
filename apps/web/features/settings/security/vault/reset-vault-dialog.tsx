'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { purgeDeviceKeysOnRevoked } from '@/features/vault/device-store';
import { useVault } from '@/features/vault/vault-provider';
import { reauthPassword, type ReauthGrant } from '@/lib/api/auth';
import {
  createIdempotencyKey,
  formatVaultIfMatch,
  resetVault,
  type VaultState,
} from '@/lib/api/vault';
import {
  classifyVaultSettingsError,
  hasGrantMinRemainingTtl,
} from './vault-security-errors';

export interface ResetVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultMeta: VaultState | null;
  remainingRecoveryKeys: number | null;
  passkeysCount: number;
  canChangePassphraseNow: boolean;
  onSwitchToChangePassphrase?: () => void;
  onSuccessToast?: (message: string) => void;
}

type ResetStep =
  | 's1_paths'
  | 's2_backup'
  | 's3_reauth'
  | 's4_confirm'
  | 's5_done'
  | 'reauth_expired'
  | 'mismatch';

export function isResetConfirmationWordValid(input: string): boolean {
  const trimmed = input.trim().normalize('NFC');
  return trimmed === 'RESET' || trimmed === 'ĐẶT LẠI';
}

export function ResetVaultDialog({
  open,
  onOpenChange,
  vaultMeta,
  remainingRecoveryKeys,
  passkeysCount,
  canChangePassphraseNow,
  onSwitchToChangePassphrase,
  onSuccessToast,
}: ResetVaultDialogProps) {
  const t = useTranslations('settings.vaultSecurity');
  const { me, reauth, refetchMe } = useSession();
  const {
    inFlight,
    vaultMeta: providerVaultMeta,
    registerSecretFormReset,
    reloadVaultMeta,
    setActiveOperation,
    markResetPurged,
    lock,
    notifyVaultChanged,
  } = useVault();

  const [step, setStep] = useState<ResetStep>('s1_paths');
  const [loginPassword, setLoginPassword] = useState('');
  const [inlineReauthPassword, setInlineReauthPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [canRetrySameOp, setCanRetrySameOp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadingVault, setReloadingVault] = useState(false);

  const inFlightGuardRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const activeGrantRef = useRef<ReauthGrant | null>(null);
  const committedResetRef = useRef(false);

  const hasPassword = reauth.capabilities.hasPassword;
  const hasGoogleOauth = reauth.capabilities.oauthReauthProviders.includes('google');

  const clearInputs = useCallback(() => {
    setLoginPassword('');
    setInlineReauthPassword('');
    setConfirmWord('');
  }, []);

  const resetDialogState = useCallback(() => {
    clearInputs();
    setStep('s1_paths');
    setErrorMessage(null);
    setCanRetrySameOp(false);
    setSubmitting(false);
    inFlightGuardRef.current = false;
    idempotencyKeyRef.current = null;
    activeGrantRef.current = null;
  }, [clearInputs]);

  useEffect(() => {
    return registerSecretFormReset(() => {
      // Secret material is always wiped synchronously, even mid-operation.
      clearInputs();
      // R9-4: a provider wake wipe must not tear down an in-flight reset (step, loading state, close
      // guard, Idempotency-Key, grant). The operation's own settlement path clears those.
      if (inFlightGuardRef.current || committedResetRef.current) return;
      resetDialogState();
    });
  }, [clearInputs, registerSecretFormReset, resetDialogState]);

  useEffect(() => {
    if (!open) {
      committedResetRef.current = false;
      resetDialogState();
    }
  }, [open, resetDialogState]);

  const handleClose = useCallback(() => {
    if (submitting || inFlightGuardRef.current) return;
    if (reauth.pendingAction === 'vault.reset') {
      reauth.cancel();
    }
    committedResetRef.current = false;
    resetDialogState();
    onOpenChange(false);
  }, [onOpenChange, reauth, resetDialogState, submitting]);

  const goToStep3Reauth = useCallback(() => {
    setErrorMessage(null);
    if (
      reauth.grant &&
      reauth.grant.action === 'vault.reset' &&
      hasGrantMinRemainingTtl(reauth.grant.expires_at)
    ) {
      activeGrantRef.current = reauth.grant;
      setStep('s4_confirm');
      return;
    }
    void reauth.begin('vault.reset', '/app/settings').catch(() => undefined);
    setStep('s3_reauth');
  }, [reauth]);

  const handleError = useCallback(
    (err: unknown, options: { isReauthStep?: boolean } = {}) => {
      const classified = classifyVaultSettingsError(err, options);
      setCanRetrySameOp(classified.canRetrySameOperation);
      if (!classified.canRetrySameOperation) {
        idempotencyKeyRef.current = null;
      }

      switch (classified.kind) {
        case 'version_mismatch':
          setStep('mismatch');
          void reloadVaultMeta().catch(() => undefined);
          return;
        case 'reauth_expired':
          setStep('reauth_expired');
          return;
        case 'reauth_failed':
          setErrorMessage(t('errors.reauthFailed'));
          return;
        case 'rate_limited':
          setErrorMessage(
            t('errors.rateLimitedBody', {
              seconds: classified.retryAfterSeconds ?? 45,
            }),
          );
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
        case 'network':
          setErrorMessage(t('errors.networkError'));
          return;
        default:
          setErrorMessage(t('errors.genericError'));
      }
    },
    [reloadVaultMeta, t],
  );

  const handleStep3ReauthSubmit = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !loginPassword) return;
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const grantResult = await reauthPassword('vault.reset', loginPassword);
      setLoginPassword('');
      activeGrantRef.current = grantResult;
      setStep('s4_confirm');
    } catch (err) {
      handleError(err, { isReauthStep: true });
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [handleError, loginPassword, submitting]);

  const executeResetDelete = useCallback(
    async (grantToken: string) => {
      let currentMeta = vaultMeta ?? providerVaultMeta;
      if (!currentMeta) {
        currentMeta = await reloadVaultMeta();
      }
      if (!currentMeta) {
        throw new Error('Missing vault metadata for If-Match');
      }

      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = createIdempotencyKey();
      }
      const ifMatch = formatVaultIfMatch(currentMeta.vault_key_id, currentMeta.version);

      setActiveOperation('resetting');
      try {
        await resetVault({
          ifMatch,
          idempotencyKey: idempotencyKeyRef.current,
          reauthToken: grantToken,
        });
      } finally {
        setActiveOperation(null);
      }

      // R2-1: Mark reset committed before calling vault.lock so registerSecretFormReset does not flash s1_paths,
      // and transition to s5_done right after lock before awaiting refetchMe().
      committedResetRef.current = true;

      // R3-1 / R1-5 / VS-R4-1 / ADR 0003 §3 item 7 & §6: ResetVaultDialog is the single acting-tab owner of
      // the `sabk.device` readwrite DevKey purge (+ incarnation/deviceRevision rotation) on 204 DELETE /vault.
      // Record `vault.markResetPurged(resetVaultKeyId)` immediately alongside the dialog's single purge
      // (and `vault.notifyVaultChanged({ vault_key_id, version: null })` also sets `resetPurgedVaultKeyIdRef`
      // synchronously) so any subsequent `VaultProvider.reloadVaultMeta()` 404 branch in the acting tab is
      // idempotent and never runs a second purge.
      // R1-6: Wrap post-commit steps after 204 in try/catch so a transient failure after DELETE never leaves step 4 showing an error.
      // R4-5: Start the purge transaction first, run local lock and broadcast immediately so the Worker
      // drops VK and peer tabs hear about the reset without waiting on IDB, then await the purge before refetchMe.
      const resetVaultKeyId = currentMeta.vault_key_id;
      const purgePromise = purgeDeviceKeysOnRevoked(me?.user.id);
      markResetPurged(resetVaultKeyId);
      try {
        await lock({ broadcast: false, reason: 'vault_reset' });
      } catch {
        // Best-effort local lock after 204
      }
      notifyVaultChanged({
        vault_key_id: resetVaultKeyId,
        version: null,
      });
      clearInputs();
      idempotencyKeyRef.current = null;
      activeGrantRef.current = null;
      reauth.clearGrant();
      setStep('s5_done');
      try {
        await purgePromise;
      } catch {
        // Best-effort DevKey purge after 204
      }
      try {
        onSuccessToast?.(t('reset.toastDone'));
        await refetchMe();
      } catch {
        // Best-effort Me refresh after 204 (TanStack Query refetch resolves on error)
      }
    },
    [
      clearInputs,
      lock,
      markResetPurged,
      me?.user.id,
      notifyVaultChanged,
      onSuccessToast,
      providerVaultMeta,
      reauth,
      refetchMe,
      reloadVaultMeta,
      setActiveOperation,
      t,
      vaultMeta,
    ],
  );

  const handleConfirmReset = useCallback(async () => {
    if (
      inFlightGuardRef.current ||
      submitting ||
      inFlight ||
      !isResetConfirmationWordValid(confirmWord)
    ) {
      return;
    }

    setErrorMessage(null);
    setCanRetrySameOp(false);

    const currentGrant = activeGrantRef.current ?? reauth.grant;
    if (
      !currentGrant ||
      currentGrant.action !== 'vault.reset' ||
      !hasGrantMinRemainingTtl(currentGrant.expires_at)
    ) {
      setStep('reauth_expired');
      return;
    }

    inFlightGuardRef.current = true;
    setSubmitting(true);
    try {
      await executeResetDelete(currentGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [
    confirmWord,
    executeResetDelete,
    handleError,
    reauth.grant,
    submitting,
    inFlight,
  ]);

  const handleInlineReauthAndReset = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !inlineReauthPassword) return;
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      let freshGrant: ReauthGrant;
      try {
        freshGrant = await reauthPassword('vault.reset', inlineReauthPassword);
      } catch (reauthErr) {
        handleError(reauthErr, { isReauthStep: true });
        return;
      }
      setInlineReauthPassword('');
      activeGrantRef.current = freshGrant;
      await executeResetDelete(freshGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [executeResetDelete, handleError, inlineReauthPassword, submitting]);

  const handleRestartFromStep1 = useCallback(() => {
    clearInputs();
    idempotencyKeyRef.current = null;
    activeGrantRef.current = null;
    setErrorMessage(null);
    setCanRetrySameOp(false);
    setStep('s1_paths');
  }, [clearInputs]);

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

  const confirmValid = isResetConfirmationWordValid(confirmWord);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent id="resetDlg" aria-labelledby="resetDlgTitle" className="w-[min(600px,94vw)]">
        <div
          className="panel"
          style={{ width: '100%', maxHeight: '90vh', overflow: 'auto', padding: '28px' }}
        >
          <DialogHeader
            title={<span id="resetDlgTitle">{t('reset.dialogTitle')}</span>}
            description={t('reset.dialogDescription')}
            className="mb-4"
          />

          {step === 's1_paths' && (
            <section data-view="rst-s1">
              <p className="mb-3 text-[13px] text-body">{t('reset.step1Label')}</p>
              <div className="mb-6 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-3">
                  <span className="mono text-muted">1</span>
                  <span className="min-w-[180px] flex-1 text-[14px] text-body">
                    {t('reset.path1Label', { passkeys: passkeysCount })}
                  </span>
                  <Link
                    href="/app/unlock"
                    className="btn btn-tertiary btn-sm ml-auto no-underline"
                  >
                    {t('reset.path1Action')}
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-3">
                  <span className="mono text-muted">2</span>
                  <span className="min-w-[180px] flex-1 text-[14px] text-body">
                    {remainingRecoveryKeys !== null
                      ? t('reset.path2Label', { remaining: remainingRecoveryKeys })
                      : t('reset.path2LabelUnknown')}
                  </span>
                  <Link
                    href="/app/recovery"
                    className="btn btn-tertiary btn-sm ml-auto no-underline"
                  >
                    {t('reset.path2Action')}
                  </Link>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-3">
                  <span className="mono text-muted">3</span>
                  <span className="min-w-[180px] flex-1 text-[14px] text-body">
                    {t('reset.path3Label')}
                  </span>
                  <Link
                    href="/app/unlock"
                    className="btn btn-tertiary btn-sm ml-auto no-underline"
                  >
                    {t('reset.path3Action')}
                  </Link>
                </div>
                <div className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-3">
                  <span className="mono text-muted">4</span>
                  <span className="min-w-[180px] flex-1 text-[14px] text-body">
                    {t('reset.path4Label')}
                  </span>
                  {canChangePassphraseNow && onSwitchToChangePassphrase ? (
                    <Button
                      type="button"
                      variant="tertiary"
                      size="sm"
                      className="ml-auto"
                      onClick={() => {
                        handleClose();
                        onSwitchToChangePassphrase();
                      }}
                    >
                      {t('reset.path4Action')}
                    </Button>
                  ) : (
                    <Link
                      href="/app/unlock"
                      className="btn btn-tertiary btn-sm ml-auto no-underline"
                    >
                      {t('reset.path1Action')}
                    </Link>
                  )}
                </div>
              </div>

              <DialogFooter className="min-w-0 flex-wrap">
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('reset.step1Cancel')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="min-w-0 whitespace-normal text-center"
                  onClick={() => setStep('s2_backup')}
                >
                  {t('reset.step1Next')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 's2_backup' && (
            <section data-view="rst-s2">
              <div className="card mb-5 p-5">
                <p className="t-label mb-2 text-muted">{t('reset.step2Label')}</p>
                <p className="m-0 mb-2 text-[14px] font-semibold text-body">
                  {t('reset.step2Title')}
                </p>
                <p className="m-0 mb-3 text-[13px] text-body">{t('reset.step2Body')}</p>
                <a
                  href="#dulieu"
                  className="btn btn-tertiary btn-sm no-underline"
                  onClick={() => handleClose()}
                >
                  {t('reset.step2ExportLink')}
                </a>
              </div>

              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => setStep('s1_paths')}
                >
                  {t('common.back')}
                </Button>
                <Button type="button" variant="secondary" onClick={goToStep3Reauth}>
                  {t('reset.step2Next')}
                </Button>
              </div>
            </section>
          )}

          {step === 's3_reauth' && (
            <section data-view="rst-s3">
              <div className="card mb-5 p-5">
                <p className="t-label mb-2 text-muted">{t('reset.step3Label')}</p>
                <p className="m-0 mb-4 text-[13px] text-body">{t('reset.step3Body')}</p>

                {hasPassword && (
                  <Field
                    id="rst-reauth-pwd"
                    label={t('reauth.passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    data-vault-secret="true"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    hint={t('reauth.passwordHint')}
                    passwordToggleLabels={{ show: t('common.show'), hide: t('common.hide') }}
                    disabled={submitting}
                    wrapperClassName="mb-4"
                  />
                )}

                {hasGoogleOauth && (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      className="mb-3 w-full !justify-center"
                      disabled={submitting}
                      onClick={() => void reauth.startOauthReauth('google', '/app/settings')}
                    >
                      {t('reauth.oauthButton')}
                    </Button>
                    <p className="m-0 text-[12px] text-muted">{t('reset.step3OauthHint')}</p>
                  </>
                )}
              </div>

              {errorMessage && (
                <AuthStatus tone="error" className="mb-4">
                  {errorMessage}
                </AuthStatus>
              )}

              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={submitting}
                  onClick={() => setStep('s2_backup')}
                >
                  {t('common.back')}
                </Button>
                {hasPassword && (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={submitting || !loginPassword}
                    aria-busy={submitting}
                    onClick={() => void handleStep3ReauthSubmit()}
                  >
                    {submitting ? t('reauth.submittingButton') : t('reauth.confirmButton')}
                  </Button>
                )}
              </div>
            </section>
          )}

          {step === 's4_confirm' && (
            <section data-view="rst-s4">
              <div className="card mb-5 border-error p-5">
                <p className="t-label mb-2 text-muted">{t('reset.step4Label')}</p>
                <p className="m-0 mb-4 text-[13px] text-body">{t('reset.step4Body')}</p>
                <Field
                  id="rst-confirm-word"
                  label={t('reset.confirmInputLabel')}
                  type="text"
                  value={confirmWord}
                  placeholder={t('reset.confirmInputPlaceholder')}
                  onChange={(e) => setConfirmWord(e.target.value)}
                  disabled={submitting}
                  className="mono"
                  wrapperClassName="mb-0"
                />
              </div>

              {errorMessage && (
                <AuthStatus tone="error" className="mb-4">
                  {errorMessage}
                </AuthStatus>
              )}

              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={submitting}
                  onClick={() => setStep('s3_reauth')}
                >
                  {t('common.back')}
                </Button>
                <Button
                  id="rstConfirmBtn"
                  type="button"
                  variant="danger"
                  disabled={!confirmValid || submitting || inFlight}
                  aria-busy={submitting}
                  onClick={() => void handleConfirmReset()}
                >
                  {submitting
                    ? t('reset.submittingButton')
                    : canRetrySameOp
                      ? t('common.retry')
                      : t('reset.submitButton')}
                </Button>
              </div>
            </section>
          )}

          {step === 's5_done' && (
            <section data-view="rst-s5">
              <div className="card mb-5 p-5">
                <AuthStatus tone="sent" className="mb-2">
                  {t('reset.step5Status')}
                </AuthStatus>
                <p className="m-0 text-[13px] text-body">{t('reset.step5Body')}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.close')}
                </Button>
                <Link href="/app/onboarding" className="btn btn-primary no-underline">
                  {t('reset.createNewVaultLink')}
                </Link>
              </DialogFooter>
            </section>
          )}

          {step === 'reauth_expired' && (
            <section data-view="rst-reauth-expired">
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
                    id="rst-reauth-inline"
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
                    variant="danger"
                    disabled={submitting || !inlineReauthPassword}
                    onClick={() => void handleInlineReauthAndReset()}
                  >
                    {t('reset.expiredPasswordSubmit')}
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
                  <Button type="button" variant="secondary" onClick={handleRestartFromStep1}>
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
            <section data-view="rst-mismatch">
              <div className="card mb-5 border-error p-5">
                <p className="t-label mb-2 text-muted">
                  <span className="mono">412 version_mismatch</span>
                </p>
                <AuthStatus tone="error" className="mb-0">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('errors.versionMismatchTitle')}
                  </p>
                  <p className="m-0 text-[13px] text-body">{t('errors.versionMismatchResetBody')}</p>
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
