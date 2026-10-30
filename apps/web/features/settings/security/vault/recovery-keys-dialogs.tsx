'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { RecoveryKeysSheet } from '@/features/vault/onboarding';
import { useVault } from '@/features/vault/vault-provider';
import { reauthPassword, type ReauthAction, type ReauthGrant } from '@/lib/api/auth';
import {
  createIdempotencyKey,
  formatVaultIfMatch,
  regenerateRecoveryKeys,
  rotateRecoveryKeys,
  type RecoveryKeyUploadItem,
  type VaultState,
} from '@/lib/api/vault';
import type { RecoveryKeyItemResult } from '@/lib/crypto/protocol';
import {
  classifyVaultSettingsError,
  formatSlotRange,
  hasGrantMinRemainingTtl,
  type ClassifiedVaultSettingsError,
} from './vault-security-errors';

export type RecoveryKeysDialogMode = 'regenerate' | 'rotate';

export interface RecoveryKeysDialogsProps {
  mode: RecoveryKeysDialogMode | null;
  onClose: () => void;
  vaultMeta: VaultState | null;
  emptySlots: readonly number[];
  remainingRecoveryKeys: number | null;
  onSuccessToast?: (message: string) => void;
  onStatusChanged?: () => void;
}

type RkDialogStep = 'reauth' | 'keys' | 'reauth_expired' | 'mismatch' | 'ratelimit' | 'done';

const ALL_TEN_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function RecoveryKeysDialog({
  mode,
  onClose,
  vaultMeta,
  emptySlots,
  remainingRecoveryKeys,
  onSuccessToast,
  onStatusChanged,
}: RecoveryKeysDialogsProps) {
  const t = useTranslations('settings.vaultSecurity');
  const { me, reauth } = useSession();
  const {
    inFlight,
    vaultMeta: providerVaultMeta,
    registerSecretFormReset,
    beginOp,
    notifyVaultChanged,
    reloadVaultMeta,
  } = useVault();

  const open = mode !== null;
  const isRotate = mode === 'rotate';
  const requiredAction: ReauthAction = isRotate
    ? 'vault.recovery_keys_rotate'
    : 'vault.recovery_keys_regenerate';

  const targetSlots = isRotate
    ? [...ALL_TEN_SLOTS]
    : [...emptySlots].sort((a, b) => a - b);
  const slotRangeLabel = formatSlotRange(targetSlots);

  const [step, setStep] = useState<RkDialogStep>('reauth');
  const [loginPassword, setLoginPassword] = useState('');
  const [inlineReauthPassword, setInlineReauthPassword] = useState('');
  const [generatedKeys, setGeneratedKeys] = useState<RecoveryKeyItemResult[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [classifiedError, setClassifiedError] = useState<ClassifiedVaultSettingsError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadingVault, setReloadingVault] = useState(false);

  const inFlightGuardRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const activeGrantRef = useRef<ReauthGrant | null>(null);
  const uploadPayloadRef = useRef<RecoveryKeyUploadItem[] | null>(null);
  const openedModeRef = useRef<RecoveryKeysDialogMode | null>(null);

  const hasPassword = reauth.capabilities.hasPassword;
  const hasGoogleOauth = reauth.capabilities.oauthReauthProviders.includes('google');

  const wipeKeysAndSecrets = useCallback(() => {
    setGeneratedKeys([]);
    setAcknowledged(false);
    setLoginPassword('');
    setInlineReauthPassword('');
    uploadPayloadRef.current = null;
  }, []);

  const resetDialogState = useCallback(() => {
    wipeKeysAndSecrets();
    setStep('reauth');
    setErrorMessage(null);
    setClassifiedError(null);
    setSubmitting(false);
    inFlightGuardRef.current = false;
    idempotencyKeyRef.current = null;
    activeGrantRef.current = null;
  }, [wipeKeysAndSecrets]);

  // Register secret form reset so locking the vault immediately wipes displayed RK from DOM/state,
  // clears idempotencyKeyRef, and returns to the first step (R1-7).
  // R9-4: while an operation is in flight (provider wake wipe) only secret material (plaintext keys, ack,
  // password fields, upload payload) is wiped; the step, loading state, close guard, Idempotency-Key and
  // grant stay until the operation's own settlement path (`finally`) clears them.
  useEffect(() => {
    return registerSecretFormReset(() => {
      if (inFlightGuardRef.current) {
        wipeKeysAndSecrets();
        return;
      }
      resetDialogState();
    });
  }, [registerSecretFormReset, resetDialogState, wipeKeysAndSecrets]);

  // Also wipe keys on component unmount
  useEffect(() => {
    return () => {
      wipeKeysAndSecrets();
    };
  }, [wipeKeysAndSecrets]);

  const generateKeysInWorker = useCallback(
    async (grant: ReauthGrant) => {
      const { opGeneration, client, isCurrent } = beginOp();
      const slotsToGenerate = isRotate
        ? [...ALL_TEN_SLOTS]
        : [...emptySlots].sort((a, b) => a - b);

      if (slotsToGenerate.length === 0) {
        return;
      }

      const result = await client.makeRecoveryKeys({
        slots: slotsToGenerate,
        opGeneration,
      });

      if (!isCurrent()) {
        setGeneratedKeys([]);
        return;
      }

      activeGrantRef.current = grant;
      setGeneratedKeys(result.recovery_keys);
      uploadPayloadRef.current = result.recovery_keys.map((item) => ({
        slot: item.slot,
        lookup_hash: item.lookup_hash,
        wrap: item.wrap,
      }));
      setAcknowledged(false);
      setStep('keys');
    },
    [beginOp, emptySlots, isRotate],
  );

  // When dialog opens, begin re-auth at flow start before any Worker call (plan §1)
  useEffect(() => {
    if (!open || !mode) {
      openedModeRef.current = null;
      resetDialogState();
      return;
    }
    if (openedModeRef.current === mode) return;
    openedModeRef.current = mode;

    if (
      reauth.grant &&
      reauth.grant.action === requiredAction &&
      hasGrantMinRemainingTtl(reauth.grant.expires_at)
    ) {
      const existingGrant = reauth.grant;
      void generateKeysInWorker(existingGrant).catch((err) => {
        const classified = classifyVaultSettingsError(err);
        setClassifiedError(classified);
        setErrorMessage(t('errors.genericError'));
      });
      return;
    }

    void reauth.begin(requiredAction, '/app/settings').catch(() => undefined);
  }, [generateKeysInWorker, mode, open, reauth, requiredAction, resetDialogState, t]);

  const handleClose = useCallback(() => {
    if (submitting || inFlightGuardRef.current) return;
    if (reauth.pendingAction === requiredAction) {
      reauth.cancel();
    }
    resetDialogState();
    onClose();
  }, [onClose, reauth, requiredAction, resetDialogState, submitting]);

  const handleError = useCallback(
    (err: unknown, options: { isReauthStep?: boolean } = {}) => {
      const classified = classifyVaultSettingsError(err, options);
      setClassifiedError(classified);
      if (!classified.canRetrySameOperation) {
        idempotencyKeyRef.current = null;
      }

      switch (classified.kind) {
        case 'version_mismatch':
          // Wipe displayed keys immediately on 412 so unsaved keys are not left in DOM
          setGeneratedKeys([]);
          uploadPayloadRef.current = null;
          setStep('mismatch');
          void reloadVaultMeta().catch(() => undefined);
          return;
        case 'rate_limited':
          setStep('ratelimit');
          return;
        case 'reauth_expired':
          if (!hasPassword) {
            setGeneratedKeys([]);
            uploadPayloadRef.current = null;
          }
          setStep('reauth_expired');
          return;
        case 'reauth_failed':
          setErrorMessage(t('errors.reauthFailed'));
          return;
        case 'recovery_key_slot_taken':
          setGeneratedKeys([]);
          uploadPayloadRef.current = null;
          setErrorMessage(t('errors.recoveryKeySlotTaken'));
          void reloadVaultMeta().catch(() => undefined);
          onStatusChanged?.();
          return;
        case 'recovery_key_conflict':
          setErrorMessage(t('errors.recoveryKeyConflict'));
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
          setGeneratedKeys([]);
          setErrorMessage(t('errors.vaultLocked'));
          return;
        case 'stale_generation':
          setGeneratedKeys([]);
          setErrorMessage(t('errors.staleGeneration'));
          return;
        case 'network':
          setErrorMessage(t('errors.networkError'));
          return;
        default:
          setErrorMessage(t('errors.genericError'));
      }
    },
    [hasPassword, onStatusChanged, reloadVaultMeta, t],
  );

  const handleStep1ReauthSubmit = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !loginPassword) return;
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);
    setClassifiedError(null);

    try {
      let grantResult: ReauthGrant;
      try {
        grantResult = await reauthPassword(requiredAction, loginPassword);
      } catch (reauthErr) {
        handleError(reauthErr, { isReauthStep: true });
        return;
      }
      setLoginPassword('');
      await generateKeysInWorker(grantResult);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [generateKeysInWorker, handleError, loginPassword, requiredAction, submitting]);

  const executeSaveKeys = useCallback(
    async (grantToken: string) => {
      const currentMeta = vaultMeta ?? providerVaultMeta;
      if (!currentMeta) {
        throw new Error('Missing vault metadata for If-Match');
      }
      const uploadItems = uploadPayloadRef.current;
      if (!uploadItems || uploadItems.length === 0) {
        throw new Error('Missing generated recovery keys payload');
      }
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = createIdempotencyKey();
      }
      const ifMatch = formatVaultIfMatch(currentMeta.vault_key_id, currentMeta.version);

      if (isRotate) {
        const res = await rotateRecoveryKeys(
          { recovery_keys: uploadItems },
          {
            ifMatch,
            idempotencyKey: idempotencyKeyRef.current,
            reauthToken: grantToken,
          },
        );
        notifyVaultChanged({
          vault_key_id: currentMeta.vault_key_id,
          version: res.version,
        });
        onSuccessToast?.(t('recoveryKeys.rotate.toastDone'));
      } else {
        const res = await regenerateRecoveryKeys(
          { recovery_keys: uploadItems },
          {
            ifMatch,
            idempotencyKey: idempotencyKeyRef.current,
            reauthToken: grantToken,
          },
        );
        notifyVaultChanged({
          vault_key_id: currentMeta.vault_key_id,
          version: res.version,
        });
        onSuccessToast?.(t('recoveryKeys.regenerate.toastDone', { count: uploadItems.length }));
      }

      // Wipe plaintext keys from state & DOM immediately after server commit
      wipeKeysAndSecrets();
      idempotencyKeyRef.current = null;
      activeGrantRef.current = null;
      reauth.clearGrant();
      onStatusChanged?.();
      onClose();
    },
    [isRotate, notifyVaultChanged, onClose, onStatusChanged, onSuccessToast, providerVaultMeta, reauth, t, vaultMeta, wipeKeysAndSecrets],
  );

  const handleConfirmSaveKeys = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !acknowledged) return;
    setErrorMessage(null);
    setClassifiedError(null);

    const currentGrant = activeGrantRef.current ?? reauth.grant;
    if (
      !currentGrant ||
      currentGrant.action !== requiredAction ||
      !hasGrantMinRemainingTtl(currentGrant.expires_at)
    ) {
      if (!hasPassword) {
        // OAuth-only user: time ran out, clear temporary keys and require restart
        wipeKeysAndSecrets();
      }
      setStep('reauth_expired');
      return;
    }

    inFlightGuardRef.current = true;
    setSubmitting(true);
    try {
      await executeSaveKeys(currentGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [
    acknowledged,
    executeSaveKeys,
    handleError,
    hasPassword,
    reauth.grant,
    requiredAction,
    submitting,
    wipeKeysAndSecrets,
  ]);

  const handleInlineReauthAndSave = useCallback(async () => {
    if (inFlightGuardRef.current || submitting || !inlineReauthPassword) return;
    inFlightGuardRef.current = true;
    setSubmitting(true);
    setErrorMessage(null);

    try {
      let freshGrant: ReauthGrant;
      try {
        freshGrant = await reauthPassword(requiredAction, inlineReauthPassword);
      } catch (reauthErr) {
        handleError(reauthErr, { isReauthStep: true });
        return;
      }
      setInlineReauthPassword('');
      activeGrantRef.current = freshGrant;
      await executeSaveKeys(freshGrant.grant);
    } catch (err) {
      handleError(err);
    } finally {
      inFlightGuardRef.current = false;
      setSubmitting(false);
    }
  }, [executeSaveKeys, handleError, inlineReauthPassword, requiredAction, submitting]);

  const handleRestartOauthFlow = useCallback(() => {
    wipeKeysAndSecrets();
    idempotencyKeyRef.current = null;
    activeGrantRef.current = null;
    setErrorMessage(null);
    setClassifiedError(null);
    setStep('reauth');
    void reauth.begin(requiredAction, '/app/settings').catch(() => undefined);
  }, [reauth, requiredAction, wipeKeysAndSecrets]);

  const handleReloadVault = useCallback(async () => {
    setReloadingVault(true);
    try {
      await reloadVaultMeta();
      onStatusChanged?.();
      onSuccessToast?.(t('common.vaultReloadedToast'));
      handleClose();
    } catch {
      handleClose();
    } finally {
      setReloadingVault(false);
    }
  }, [handleClose, onStatusChanged, onSuccessToast, reloadVaultMeta, t]);

  if (!open || !mode) return null;

  const dialogId = isRotate ? 'rotateDlg' : 'rkDlg';
  const dialogTitleId = isRotate ? 'rotateDlgTitle' : 'rkDlgTitle';
  const checkboxId = isRotate ? 'rkRotateSaved' : 'rkRegenSaved';
  const confirmBtnId = isRotate ? 'rkRotateConfirmBtn' : 'rkRegenDoneBtn';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent
        id={dialogId}
        aria-labelledby={dialogTitleId}
        className={isRotate ? 'w-[min(620px,94vw)]' : 'w-[min(600px,94vw)]'}
      >
        <div
          className="panel"
          style={{
            width: '100%',
            maxHeight: '90vh',
            overflow: 'auto',
            padding: '28px',
          }}
        >
          <DialogHeader
            title={
              <span id={dialogTitleId}>
                {isRotate
                  ? t('recoveryKeys.rotate.dialogTitle')
                  : t('recoveryKeys.regenerate.dialogTitle')}
              </span>
            }
            description={
              isRotate
                ? t('recoveryKeys.rotate.dialogDescription')
                : remainingRecoveryKeys !== null
                  ? t('recoveryKeys.regenerate.dialogDescription', {
                      emptyCount: targetSlots.length,
                      slotRange: slotRangeLabel,
                      remaining: remainingRecoveryKeys,
                    })
                  : t('recoveryKeys.regenerate.dialogDescriptionUnknown', {
                      emptyCount: targetSlots.length,
                      slotRange: slotRangeLabel,
                    })
            }
            className="mb-4"
          />

          {step === 'reauth' && (
            <section data-view={isRotate ? 'rot-reauth' : 'rk-reauth'}>
              <div className="card mb-5 p-5">
                <p className="t-label mb-2 text-muted">{t('reauth.flowStartLabel')}</p>
                <p className="m-0 mb-4 text-[13px] text-body">
                  {isRotate
                    ? t('recoveryKeys.rotate.reauthBody')
                    : t('recoveryKeys.regenerate.reauthBody')}
                </p>

                {hasPassword && (
                  <Field
                    id={isRotate ? 'rot-reauth-pwd' : 'rk-reauth-pwd'}
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
                    <p className="m-0 text-[12px] text-muted">{t('reauth.oauthRedirectHint')}</p>
                  </>
                )}
              </div>

              {errorMessage && (
                <AuthStatus tone="error" className="mb-4">
                  {errorMessage}
                </AuthStatus>
              )}

              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose} disabled={submitting}>
                  {t('common.cancel')}
                </Button>
                {hasPassword && (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={submitting || !loginPassword}
                    aria-busy={submitting}
                    onClick={() => void handleStep1ReauthSubmit()}
                  >
                    {submitting ? t('reauth.submittingButton') : t('reauth.confirmButton')}
                  </Button>
                )}
              </DialogFooter>
            </section>
          )}

          {step === 'keys' && (
            <section data-view={isRotate ? 'rot-keys' : 'rk-keys'}>
              {isRotate && (
                <div className="mb-4 rounded-md bg-paleOrange p-4">
                  <p className="m-0 mb-1.5 text-[13px] font-semibold text-body">
                    {t('recoveryKeys.rotate.warningTitle')}
                  </p>
                  <p className="m-0 text-[12px] text-body">
                    {t('recoveryKeys.rotate.warningBody')}
                  </p>
                </div>
              )}

              {generatedKeys.length > 0 && (
                <RecoveryKeysSheet
                  keys={generatedKeys}
                  accountEmail={me?.user.email}
                  confirmedSaved={acknowledged}
                  onConfirmedSavedChange={setAcknowledged}
                  disabled={submitting}
                  checkboxId={checkboxId}
                  labels={{
                    gridLabel: t('recoveryKeys.cardTitle'),
                    slotLabel: (slot) => t('recoveryKeys.slotChipActive', { slot }),
                    screenshotWarningBody: t('recoveryKeys.grid.shownOnceWarning'),
                    downloadTxt: t('recoveryKeys.grid.downloadTxt'),
                    print: t('recoveryKeys.grid.print'),
                    copyAll: t('recoveryKeys.grid.copy'),
                    downloadedStatus: t('recoveryKeys.grid.downloadedToast'),
                    printedStatus: t('recoveryKeys.grid.print'),
                    copiedStatus: t('recoveryKeys.grid.copiedToast'),
                    confirmSavedLabel: isRotate
                      ? t('recoveryKeys.rotate.ackCheckbox')
                      : t('recoveryKeys.regenerate.ackCheckbox'),
                  }}
                />
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
                <Button
                  id={confirmBtnId}
                  type="button"
                  variant="primary"
                  disabled={!acknowledged || submitting || inFlight}
                  aria-busy={submitting}
                  onClick={() => void handleConfirmSaveKeys()}
                >
                  {submitting
                    ? t('common.saving')
                    : classifiedError?.canRetrySameOperation
                      ? t('common.retry')
                      : isRotate
                        ? t('recoveryKeys.rotate.submitButton')
                        : t('recoveryKeys.regenerate.submitButton')}
                </Button>
              </DialogFooter>
            </section>
          )}

          {step === 'reauth_expired' && (
            <section data-view={isRotate ? 'rot-reauth-expired' : 'rk-reauth-expired'}>
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
                    id={isRotate ? 'rot-reauth-inline' : 'rk-reauth-inline'}
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
            <section data-view={isRotate ? 'rot-mismatch' : 'rk-mismatch'}>
              <div className="card mb-5 border-error p-5">
                <p className="t-label mb-2 text-muted">
                  <span className="mono">412 version_mismatch</span>
                </p>
                <AuthStatus tone="error" className="mb-0">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {t('errors.versionMismatchTitle')}
                  </p>
                  <p className="m-0 text-[13px] text-body">
                    {t('errors.versionMismatchKeysBody')}
                  </p>
                </AuthStatus>
              </div>
              <DialogFooter>
                <Button type="button" variant="tertiary" onClick={handleClose}>
                  {t('common.close')}
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
            <section data-view={isRotate ? 'rot-ratelimit' : 'rk-ratelimit'}>
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
