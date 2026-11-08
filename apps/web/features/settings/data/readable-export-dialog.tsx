'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { useVault } from '@/features/vault/vault-provider';
import { reauthPassword, type ReauthAction, type ReauthGrant } from '@/lib/api/auth';
import { type ExportJob } from '@/lib/api/export';
import { grantStillValid } from '@/lib/auth/audit-catalog';
import { createIdempotencyKey } from '@/lib/api/vault';
import {
  DecryptedExportError,
  formatReadableExportFilename,
  isReusableReadySourceJob,
  runDecryptedExport,
  type DecryptedExportRunnerDeps,
} from './decrypted-export-runner';
import { LIVE_REGION_THROTTLE_MS } from './encrypted-backup-card';

export type ReadableExportViewState =
  | 'pl-confirm'
  | 'pl-locked'
  | 'pl-progress'
  | 'pl-done'
  | 'pl-failed'
  | 'pl-limit'
  | 'pl-offline'
  | 'pl-reauth-expired'
  | 'pl-too-large';

export const READABLE_EXPORT_ACTION: ReauthAction = 'export.decrypted';
export const READABLE_EXPORT_RETURN_TO = '/app/settings?reauth=export.decrypted#dulieu';
const defaultNow = () => Date.now();

export interface ReadableExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  runnerDeps?: DecryptedExportRunnerDeps;
  now?: () => number;
  resume?: boolean;
}

export function ReadableExportDialog({
  open,
  onOpenChange,
  returnFocusRef,
  runnerDeps,
  now = defaultNow,
  resume,
}: ReadableExportDialogProps) {
  const t = useTranslations('settings.data.readable');
  const tAuth = useTranslations('auth');
  const { reauth } = useSession();
  const vault = useVault();
  const [progressPhase, setProgressPhase] = useState<'preparing_source' | 'decrypting'>('preparing_source');

  const isVaultUnlocked = vault.state === 'unlocked';
  const hasPassword = reauth.capabilities.hasPassword;
  const hasGoogleOauth = reauth.capabilities.oauthReauthProviders.includes('google');

  const [viewState, setViewState] = useState<ReadableExportViewState>(() =>
    isVaultUnlocked ? 'pl-confirm' : 'pl-locked',
  );
  const [loginPassword, setLoginPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [submittingReauth, setSubmittingReauth] = useState(false);

  const [rawProcessed, setRawProcessed] = useState(0);
  const [rawTotal, setRawTotal] = useState(0);
  const [announcedProcessed, setAnnouncedProcessed] = useState(0);
  const [announcedTotal, setAnnouncedTotal] = useState(0);
  const [savedFilename, setSavedFilename] = useState<string>(() =>
    formatReadableExportFilename(now()),
  );
  const [limitClock, setLimitClock] = useState('14:12');
  const [isPausedLimit, setIsPausedLimit] = useState(false);
  const [failedKind, setFailedKind] = useState<'key_mismatch' | 'generic'>('key_mismatch');
  const [wasCancelledInProgress, setWasCancelledInProgress] = useState(false);
  const confirmPasswordRef = useRef<HTMLInputElement | null>(null);
  const confirmOauthBtnRef = useRef<HTMLButtonElement | null>(null);
  const unlockLinkRef = useRef<HTMLAnchorElement | null>(null);
  const expiredPasswordRef = useRef<HTMLInputElement | null>(null);
  const expiredOauthBtnRef = useRef<HTMLButtonElement | null>(null);
  const statusHeadingRef = useRef<HTMLDivElement | null>(null);

  const activeAbortRef = useRef<AbortController | null>(null);
  const reusableSourceJobRef = useRef<ExportJob | null>(null);
  const auditIdempotencyKeyRef = useRef<string | null>(null);
  const createIdempotencyKeyRef = useRef<string | null>(null);
  const activeGrantRef = useRef<ReauthGrant | null>(null);
  const wasOpenRef = useRef(false);
  const skipFocusReturnRef = useRef(false);
  const mountedRef = useRef(true);
  const nowRef = useRef(now);
  nowRef.current = now;
  const reauthRef = useRef(reauth);
  reauthRef.current = reauth;
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const sinkDisposeRef = useRef<(() => void) | null>(null);
  const lastLiveUpdateAtRef = useRef(0);
  const pendingLiveTimerRef = useRef<number | null>(null);
  const clearLiveTimer = useCallback(() => {
    if (pendingLiveTimerRef.current !== null) {
      clearTimeout(pendingLiveTimerRef.current);
      pendingLiveTimerRef.current = null;
    }
  }, []);

  const disposeCompletedSink = useCallback(() => {
    if (sinkDisposeRef.current) {
      sinkDisposeRef.current();
      sinkDisposeRef.current = null;
    }
  }, []);

  const updateProgressState = useCallback(
    (processed: number, total: number, force = false) => {
      setRawProcessed(processed);
      setRawTotal(total);
      const currentNow = nowRef.current();
      const elapsed = currentNow - lastLiveUpdateAtRef.current;
      if (force || lastLiveUpdateAtRef.current === 0 || elapsed >= LIVE_REGION_THROTTLE_MS) {
        clearLiveTimer();
        lastLiveUpdateAtRef.current = currentNow;
        setAnnouncedProcessed(processed);
        setAnnouncedTotal(total);
        return;
      }
      clearLiveTimer();
      const remaining = Math.max(10, LIVE_REGION_THROTTLE_MS - elapsed);
      pendingLiveTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return;
        lastLiveUpdateAtRef.current = nowRef.current();
        setAnnouncedProcessed(processed);
        setAnnouncedTotal(total);
      }, remaining);
    },
    [clearLiveTimer],
  );

  const abortInFlightExport = useCallback(() => {
    if (activeAbortRef.current) {
      activeAbortRef.current.abort();
      activeAbortRef.current = null;
    }
    disposeCompletedSink();
    clearLiveTimer();
    lastLiveUpdateAtRef.current = 0;
  }, [clearLiveTimer, disposeCompletedSink]);

  const wipeSecretInputs = useCallback(() => {
    setLoginPassword('');
    setReauthError(null);
    setWasCancelledInProgress(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortInFlightExport();
      // Clear any residual export.decrypted grant on unmount unless navigating to unlock from pl-locked (Delta N1)
      if (
        viewStateRef.current !== 'pl-locked' &&
        reauthRef.current.grant?.action === READABLE_EXPORT_ACTION
      ) {
        reauthRef.current.clearGrant();
      }
    };
  }, [abortInFlightExport]);

  // Register synchronous wipe on vault lock / logout
  useEffect(() => {
    return vault.registerSecretFormReset(() => {
      wipeSecretInputs();
      abortInFlightExport();
      if (open) {
        setViewState('pl-locked');
      }
    });
  }, [abortInFlightExport, open, vault, wipeSecretInputs]);
  const startExportFlow = useCallback(
    async (grantToken: string) => {
      abortInFlightExport();
      const abortController = new AbortController();
      activeAbortRef.current = abortController;

      setWasCancelledInProgress(false);
      setProgressPhase('preparing_source');
      setViewState('pl-progress');
      updateProgressState(0, 0, true);

      if (!auditIdempotencyKeyRef.current) {
        auditIdempotencyKeyRef.current = createIdempotencyKey();
      }
      if (!createIdempotencyKeyRef.current) {
        createIdempotencyKeyRef.current = createIdempotencyKey();
      }

      const { opGeneration, isCurrent, client } = vault.beginOp();
      const candidateReuse = isReusableReadySourceJob(reusableSourceJobRef.current, nowRef.current())
        ? reusableSourceJobRef.current
        : null;

      try {
        const result = await runDecryptedExport({
          getVaultState: () => vault.state,
          getCurrentVaultKeyId: () => vault.vaultMeta?.vault_key_id ?? null,
          openEntry: (entryParams) => client.openEntry(entryParams),
          opGeneration,
          isOpCurrent: isCurrent,
          reauthToken: grantToken,
          auditIdempotencyKey: auditIdempotencyKeyRef.current,
          createIdempotencyKey: createIdempotencyKeyRef.current,
          preferredSourceJob: candidateReuse,
          registerSecretFormReset: vault.registerSecretFormReset,
          signal: abortController.signal,
          onSourceJobReady: (sourceJob) => {
            reusableSourceJobRef.current = sourceJob;
          },
          onProgress: (prog) => {
            if (!mountedRef.current || abortController.signal.aborted) return;
            setProgressPhase(prog.phase);
            if (prog.phase === 'decrypting') {
              updateProgressState(prog.processedEntries, prog.totalEntries);
            }
          },
          deps: {
            now: () => nowRef.current(),
            ...runnerDeps,
          },
        });

        if (!mountedRef.current || abortController.signal.aborted) {
          result.dispose?.();
          return;
        }
        activeAbortRef.current = null;
        sinkDisposeRef.current = result.dispose ?? null;
        clearLiveTimer();
        setSavedFilename(result.filename);
        auditIdempotencyKeyRef.current = null;
        createIdempotencyKeyRef.current = null;
        reauth.clearGrant();
        setViewState('pl-done');
      } catch (err) {
        if (!mountedRef.current) return;
        activeAbortRef.current = null;
        clearLiveTimer();

        if (err instanceof DecryptedExportError) {
          if (err.sourceJob && isReusableReadySourceJob(err.sourceJob, nowRef.current())) {
            reusableSourceJobRef.current = err.sourceJob;
          }
          switch (err.kind) {
            case 'aborted':
              return;
            case 'vault_locked':
              setViewState('pl-locked');
              return;
            case 'reauth_expired':
              setLoginPassword('');
              setReauthError(null);
              setViewState('pl-reauth-expired');
              return;
            case 'rate_limited':
              createIdempotencyKeyRef.current = null;
              setIsPausedLimit(false);
              setLimitClock(err.retryClock ?? '14:12');
              setViewState('pl-limit');
              return;
            case 'paused':
              createIdempotencyKeyRef.current = null;
              setIsPausedLimit(true);
              setLimitClock(err.retryClock ?? '14:12');
              setViewState('pl-limit');
              return;
            case 'offline':
              setViewState('pl-offline');
              return;
            case 'too_large':
              setViewState('pl-too-large');
              return;
            case 'key_mismatch':
              setFailedKind('key_mismatch');
              setViewState('pl-failed');
              return;
            default:
              setFailedKind('generic');
              setViewState('pl-failed');
              return;
          }
        }
        setFailedKind('generic');
        setViewState('pl-failed');
      }
    },
    [abortInFlightExport, clearLiveTimer, reauth, runnerDeps, updateProgressState, vault],
  );

  // When dialog opens or vault state changes while open
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      abortInFlightExport();
      wipeSecretInputs();
      auditIdempotencyKeyRef.current = null;
      createIdempotencyKeyRef.current = null;
      return;
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      wipeSecretInputs();

      if (!isVaultUnlocked) {
        setViewState('pl-locked');
        return;
      }

      // Check if returning from OAuth or holding a grant for export.decrypted (Delta N1: auto-start only when resume !== false)
      if (reauth.grant && reauth.grant.action === READABLE_EXPORT_ACTION) {
        if (resume === false) {
          reauth.clearGrant();
        } else if (grantStillValid(reauth.grant.expires_at, nowRef.current())) {
          activeGrantRef.current = reauth.grant;
          void startExportFlow(reauth.grant.grant);
          return;
        } else {
          setViewState('pl-reauth-expired');
          return;
        }
      }

      void reauth.begin(READABLE_EXPORT_ACTION, READABLE_EXPORT_RETURN_TO).catch(() => undefined);
      setViewState('pl-confirm');
    }
  }, [abortInFlightExport, isVaultUnlocked, open, reauth, resume, startExportFlow, wipeSecretInputs]);

  // If dialog was in pl-locked and the user unlocked the vault while dialog is open
  useEffect(() => {
    if (!open || viewState !== 'pl-locked' || !isVaultUnlocked) return;
    if (reauth.grant && reauth.grant.action === READABLE_EXPORT_ACTION) {
      if (grantStillValid(reauth.grant.expires_at, nowRef.current())) {
        activeGrantRef.current = reauth.grant;
        void startExportFlow(reauth.grant.grant);
        return;
      }
      setViewState('pl-reauth-expired');
      return;
    }
    void reauth.begin(READABLE_EXPORT_ACTION, READABLE_EXPORT_RETURN_TO).catch(() => undefined);
    setViewState('pl-confirm');
  }, [isVaultUnlocked, open, reauth, startExportFlow, viewState]);

  // Focus management on state transitions (FE-R1-13)
  useEffect(() => {
    if (!open) return;
    const handle = window.requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (viewState === 'pl-confirm') {
        if (wasCancelledInProgress && statusHeadingRef.current) {
          statusHeadingRef.current.focus();
        } else if (hasPassword && confirmPasswordRef.current) {
          confirmPasswordRef.current.focus();
        } else if (confirmOauthBtnRef.current) {
          confirmOauthBtnRef.current.focus();
        }
        return;
      }
      if (viewState === 'pl-locked') {
        unlockLinkRef.current?.focus();
        return;
      }
      if (viewState === 'pl-reauth-expired') {
        if (hasPassword && expiredPasswordRef.current) {
          expiredPasswordRef.current.focus();
        } else if (expiredOauthBtnRef.current) {
          expiredOauthBtnRef.current.focus();
        } else {
          statusHeadingRef.current?.focus();
        }
        return;
      }
      statusHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [hasPassword, open, viewState, wasCancelledInProgress]);

  const handleClose = useCallback(() => {
    abortInFlightExport();
    wipeSecretInputs();
    activeGrantRef.current = null;
    if (reauth.grant?.action === READABLE_EXPORT_ACTION) {
      reauth.clearGrant();
    }
    if (reauth.pendingAction === READABLE_EXPORT_ACTION) {
      reauth.cancel();
    }
    onOpenChange(false);
  }, [abortInFlightExport, onOpenChange, reauth, wipeSecretInputs]);

  const handleCancelProgress = useCallback(() => {
    abortInFlightExport();
    wipeSecretInputs();
    activeGrantRef.current = null;
    if (reauth.grant?.action === READABLE_EXPORT_ACTION) {
      reauth.clearGrant();
    }
    if (reauth.pendingAction === READABLE_EXPORT_ACTION) {
      reauth.cancel();
    }
    void reauth.begin(READABLE_EXPORT_ACTION, READABLE_EXPORT_RETURN_TO).catch(() => undefined);
    setWasCancelledInProgress(true);
    setViewState('pl-confirm');
  }, [abortInFlightExport, reauth, wipeSecretInputs]);

  const handlePasswordConfirm = useCallback(async () => {
    if (submittingReauth || !loginPassword) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setViewState('pl-offline');
      return;
    }
    setSubmittingReauth(true);
    setReauthError(null);
    const pwd = loginPassword;
    setLoginPassword('');
    try {
      const grant = await reauthPassword(READABLE_EXPORT_ACTION, pwd);
      if (!mountedRef.current) return;
      activeGrantRef.current = grant;
      setSubmittingReauth(false);
      await startExportFlow(grant.grant);
    } catch (err) {
      if (!mountedRef.current) return;
      let wentOffline = false;
      if (err instanceof ProblemError) {
        if (err.problem.code === 'invalid_credentials') {
          setReauthError(t('invalidPasswordError'));
        } else if (err.problem.code === 'rate_limited') {
          setReauthError(tAuth('errors.rateLimitedTitle'));
        } else {
          setReauthError(tAuth('reauth.failed'));
        }
      } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        wentOffline = true;
        setViewState('pl-offline');
      } else {
        setReauthError(tAuth('errors.network'));
      }
      if (!wentOffline) {
        window.requestAnimationFrame(() => {
          if (!mountedRef.current) return;
          const targetInput =
            viewState === 'pl-reauth-expired'
              ? expiredPasswordRef.current
              : confirmPasswordRef.current;
          targetInput?.focus();
        });
      }
    } finally {
      if (mountedRef.current) {
        setSubmittingReauth(false);
      }
    }
  }, [loginPassword, startExportFlow, submittingReauth, t, tAuth, viewState]);

  const handleGoogleReauth = useCallback(async () => {
    if (submittingReauth) return;
    setReauthError(null);
    try {
      if (reauth.pendingAction !== READABLE_EXPORT_ACTION) {
        void reauth.begin(READABLE_EXPORT_ACTION, READABLE_EXPORT_RETURN_TO).catch(() => undefined);
      }
      await reauth.startOauthReauth('google', READABLE_EXPORT_RETURN_TO);
    } catch {
      if (!mountedRef.current) return;
      setReauthError(tAuth('reauth.failed'));
    }
  }, [reauth, submittingReauth, tAuth]);

  const handleRetryFailed = useCallback(() => {
    if (!isVaultUnlocked) {
      setViewState('pl-locked');
      return;
    }
    const currentGrant = activeGrantRef.current ?? reauth.grant;
    if (
      currentGrant &&
      currentGrant.action === READABLE_EXPORT_ACTION &&
      grantStillValid(currentGrant.expires_at, nowRef.current())
    ) {
      void startExportFlow(currentGrant.grant);
      return;
    }
    setViewState('pl-reauth-expired');
  }, [isVaultUnlocked, reauth.grant, startExportFlow]);

  const unlockHref = `/app/unlock?returnTo=${encodeURIComponent(READABLE_EXPORT_RETURN_TO)}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (viewState === 'pl-progress') {
            handleCancelProgress();
          } else {
            handleClose();
          }
        }
      }}
    >
      <DialogContent
        id="plainDlg"
        aria-labelledby="plainDlgTitle"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (viewState === 'pl-confirm') {
            if (hasPassword && confirmPasswordRef.current) {
              confirmPasswordRef.current.focus();
            } else if (confirmOauthBtnRef.current) {
              confirmOauthBtnRef.current.focus();
            }
          } else if (viewState === 'pl-locked') {
            unlockLinkRef.current?.focus();
          } else if (viewState === 'pl-reauth-expired') {
            if (hasPassword && expiredPasswordRef.current) {
              expiredPasswordRef.current.focus();
            } else if (expiredOauthBtnRef.current) {
              expiredOauthBtnRef.current.focus();
            }
          } else {
            statusHeadingRef.current?.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (viewState === 'pl-progress') {
            event.preventDefault();
            handleCancelProgress();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (skipFocusReturnRef.current) {
            skipFocusReturnRef.current = false;
            return;
          }
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
            title={<span id="plainDlgTitle">{t('title')}</span>}
            description={t('description')}
            className="mb-4"
          />

          {viewState === 'pl-confirm' && (
            <section data-view="pl-confirm">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hasPassword && loginPassword && !submittingReauth) {
                    void handlePasswordConfirm();
                  }
                }}
              >
                {wasCancelledInProgress && (
                  <div
                    ref={statusHeadingRef}
                    tabIndex={-1}
                    role="status"
                    aria-live="polite"
                    className="auth-status mb-4 outline-none"
                    data-testid="readable-export-cancelled-status"
                  >
                    {t('cancelledStatus')}
                  </div>
                )}

                <div
                  className="mb-4 rounded-md p-3.5"
                  style={{ background: 'var(--pale-orange)' }}
                >
                  <p className="m-0 text-[13px] text-body">
                    <strong>{t('warningStrong')}</strong> {t('warningRest')}
                  </p>
                </div>

                {hasPassword && (
                  <Field
                    ref={confirmPasswordRef}
                    id="plain-export-password"
                    label={t('passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    hint={hasGoogleOauth ? t('passwordHint') : t('passwordOnlyHint')}
                    error={reauthError ?? undefined}
                    readOnly={submittingReauth}
                    aria-busy={submittingReauth || undefined}
                    wrapperClassName="mb-4"
                  />
                )}

                {!hasPassword && hasGoogleOauth && (
                  <p className="field-hint m-0 mb-3">{t('oauthOnlyHint')}</p>
                )}

                {!hasPassword && reauthError && (
                  <div role="alert" className="auth-alert mb-3">
                    {reauthError}
                  </div>
                )}

                {hasPassword && hasGoogleOauth && (
                  <button
                    ref={confirmOauthBtnRef}
                    type="button"
                    className="touch-target btn btn-secondary btn-sm mb-4"
                    data-testid="readable-export-oauth-btn"
                    disabled={submittingReauth}
                    onClick={() => void handleGoogleReauth()}
                  >
                    {t('verifyGoogleButton')}
                  </button>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="tertiary"
                    data-testid="readable-export-cancel-btn"
                    disabled={submittingReauth}
                    onClick={handleClose}
                  >
                    {t('cancelButton')}
                  </Button>
                  {hasPassword ? (
                    <Button
                      type="submit"
                      variant="primary"
                      data-testid="readable-export-submit-btn"
                      disabled={submittingReauth || !loginPassword}
                    >
                      {t('exportButton')}
                    </Button>
                  ) : (
                    hasGoogleOauth && (
                      <button
                        ref={confirmOauthBtnRef}
                        type="button"
                        className="touch-target btn btn-primary"
                        data-testid="readable-export-oauth-btn"
                        disabled={submittingReauth}
                        onClick={() => void handleGoogleReauth()}
                      >
                        {t('verifyGoogleButton')}
                      </button>
                    )
                  )}
                </div>
              </form>
            </section>
          )}

          {viewState === 'pl-locked' && (
            <section data-view="pl-locked">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="alert"
                className="auth-alert mb-4 outline-none"
              >
                {t('lockedAlert')}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-cancel-btn"
                  onClick={handleClose}
                >
                  {t('cancelButton')}
                </Button>
                <Link
                  ref={unlockLinkRef}
                  href={unlockHref}
                  className="btn btn-primary touch-target no-underline"
                  data-testid="readable-export-unlock-link"
                >
                  {t('unlockVaultButton')}
                </Link>
              </div>
            </section>
          )}

          {viewState === 'pl-progress' && (
            <section data-view="pl-progress">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                className="auth-status mb-3 outline-none"
              >
                <span>
                  {progressPhase === 'preparing_source'
                    ? t('preparingSourceStatus')
                    : t('progressStatus', {
                        processed: announcedProcessed,
                        total: announcedTotal,
                      })}
                </span>
                <progress
                  className="mt-2 block w-full"
                  max={progressPhase === 'decrypting' && rawTotal > 0 ? rawTotal : 1}
                  value={progressPhase === 'decrypting' && rawTotal > 0 ? Math.min(rawProcessed, rawTotal) : 0}
                  aria-label={t('progressLabel')}
                />
              </div>
              <p className="m-0 mb-3 text-[12px] text-muted">{t('progressHint')}</p>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-progress-cancel-btn"
                  onClick={handleCancelProgress}
                >
                  {t('cancelButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'pl-done' && (
            <section data-view="pl-done">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="status"
                className="auth-status mb-3 outline-none"
              >
                {t('doneStatusPrefix')}{' '}
                <span className="mono">{savedFilename}</span>
                {t('doneStatusSuffix')}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="primary"
                  data-testid="readable-export-done-btn"
                  onClick={handleClose}
                >
                  {t('doneButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'pl-failed' && (
            <section data-view="pl-failed">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="alert"
                className="auth-alert mb-3 outline-none"
              >
                {failedKind === 'key_mismatch' ? t('failedAlert') : t('failedGenericAlert')}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-close-btn"
                  onClick={handleClose}
                >
                  {t('closeButton')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  data-testid="readable-export-retry-btn"
                  onClick={handleRetryFailed}
                >
                  {t('retryButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'pl-limit' && (
            <section data-view="pl-limit">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="alert"
                className="auth-warning mb-3 outline-none"
              >
                {isPausedLimit
                  ? t('pausedWarning', { clock: limitClock })
                  : t('limitWarning', { clock: limitClock })}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-close-btn"
                  onClick={handleClose}
                >
                  {t('closeButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'pl-offline' && (
            <section data-view="pl-offline">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="status"
                className="auth-status mb-3 outline-none"
              >
                {t('offlineStatus')}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-close-btn"
                  onClick={handleClose}
                >
                  {t('closeButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'pl-reauth-expired' && (
            <section data-view="pl-reauth-expired">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hasPassword && loginPassword && !submittingReauth) {
                    void handlePasswordConfirm();
                  }
                }}
              >
                <div
                  ref={statusHeadingRef}
                  tabIndex={-1}
                  role="alert"
                  className="auth-alert mb-3 outline-none"
                >
                  {t('reauthExpiredAlert')}
                </div>

                {hasPassword && (
                  <Field
                    ref={expiredPasswordRef}
                    id="plain-export-expired-password"
                    label={t('passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    error={reauthError ?? undefined}
                    readOnly={submittingReauth}
                    aria-busy={submittingReauth || undefined}
                    wrapperClassName="mb-4"
                  />
                )}

                {!hasPassword && reauthError && (
                  <div role="alert" className="auth-alert mb-3">
                    {reauthError}
                  </div>
                )}

                <div className="flex flex-wrap justify-between gap-2">
                  {hasPassword && hasGoogleOauth ? (
                    <button
                      ref={expiredOauthBtnRef}
                      type="button"
                      className="touch-target btn btn-secondary btn-sm"
                      data-testid="readable-export-expired-oauth-btn"
                      disabled={submittingReauth}
                      onClick={() => void handleGoogleReauth()}
                    >
                      {t('verifyGoogleButton')}
                    </button>
                  ) : (
                    <span />
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="tertiary"
                      data-testid="readable-export-cancel-btn"
                      disabled={submittingReauth}
                      onClick={handleClose}
                    >
                      {t('cancelButton')}
                    </Button>
                    {hasPassword ? (
                      <Button
                        type="submit"
                        variant="primary"
                        data-testid="readable-export-continue-btn"
                        disabled={submittingReauth || !loginPassword}
                      >
                        {t('continueButton')}
                      </Button>
                    ) : (
                      hasGoogleOauth && (
                        <button
                          ref={expiredOauthBtnRef}
                          type="button"
                          className="touch-target btn btn-primary"
                          data-testid="readable-export-expired-oauth-btn"
                          disabled={submittingReauth}
                          onClick={() => void handleGoogleReauth()}
                        >
                          {t('verifyGoogleButton')}
                        </button>
                      )
                    )}
                  </div>
                </div>
              </form>
            </section>
          )}

          {viewState === 'pl-too-large' && (
            <section data-view="pl-too-large">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="alert"
                className="auth-alert mb-3 outline-none"
              >
                {t('tooLargeAlert')}
              </div>
              <div className="flex flex-col-reverse flex-wrap justify-end gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="readable-export-close-btn"
                  onClick={handleClose}
                >
                  {t('closeButton')}
                </Button>
                <a
                  href="#dulieu"
                  className="btn btn-primary touch-target no-underline"
                  data-testid="readable-export-fallback-backup-link"
                  onClick={(e) => {
                    e.preventDefault();
                    skipFocusReturnRef.current = true;
                    handleClose();
                    const el = document.getElementById('dulieu');
                    el?.scrollIntoView?.({ behavior: 'smooth' });
                    const startBtn = document.querySelector<HTMLElement>(
                      '[data-testid="export-encrypted-start-btn"]',
                    );
                    startBtn?.focus();
                  }}
                >
                  {t('downloadEncryptedBackupButton')}
                </a>
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
