'use client';

import { ProblemError } from '@engram/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  purgeDeviceKeysOnRevoked,
  setKnownDeviceSessionUserId,
} from '@/features/vault/device-store';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  classifyAccountDeleteError,
  deleteAccount,
  type DeleteAccountOptions,
} from '@/lib/api/account';
import { reauthPassword, type ReauthAction, type ReauthGrant } from '@/lib/api/auth';
import { grantStillValid } from '@/lib/auth/audit-catalog';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import { createIdempotencyKey } from '@/lib/api/vault';

export type DeleteAccountViewState =
  | 'del-s1'
  | 'del-s2'
  | 'del-busy'
  | 'del-failed'
  | 'del-reauth-expired'
  | 'del-done';

export const DELETE_ACCOUNT_ACTION: ReauthAction = 'account.delete';
export const DELETE_ACCOUNT_RETURN_TO = '/app/settings?reauth=account.delete#xoataikhoan';
export const LOGIN_DELETED_HREF = '/app/auth/login?deleted=1';

const defaultNow = () => Date.now();
const defaultNavigateToDeletedLogin = (href: string) => {
  if (typeof window !== 'undefined') {
    window.location.href = href;
  }
};

export function normalizeConfirmEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isConfirmEmailMatching(input: string, targetEmail: string): boolean {
  const normalizedTarget = normalizeConfirmEmail(targetEmail);
  if (!normalizedTarget) return false;
  return normalizeConfirmEmail(input) === normalizedTarget;
}

export interface DeleteAccountDialogDeps {
  deleteAccount?: (opts: DeleteAccountOptions) => Promise<void>;
  reauthPassword?: (action: ReauthAction, password: string) => Promise<ReauthGrant>;
  purgeDeviceKeysOnRevoked?: typeof purgeDeviceKeysOnRevoked;
  navigateToDeletedLogin?: (href: string) => void;
}

export interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  now?: () => number;
  resume?: boolean;
  initialView?: DeleteAccountViewState;
  deps?: DeleteAccountDialogDeps;
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
  returnFocusRef,
  now = defaultNow,
  resume,
  initialView,
  deps,
}: DeleteAccountDialogProps) {
  const t = useTranslations('settings.data.deleteDialog');
  const tAuth = useTranslations('auth');
  const queryClient = useQueryClient();
  const { me, reauth, clearPrivateCache } = useSession();
  const vault = useOptionalVault();

  const hasPassword = reauth.capabilities.hasPassword;
  const hasGoogleOauth = reauth.capabilities.oauthReauthProviders.includes('google');
  const userEmail = me?.user.email ?? '';

  const [viewState, setViewState] = useState<DeleteAccountViewState>(
    () => initialView ?? 'del-s1',
  );
  const [loginPassword, setLoginPassword] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [emailServerError, setEmailServerError] = useState<string | null>(null);
  const [submittingReauth, setSubmittingReauth] = useState(false);
  const [failedKind, setFailedKind] = useState<'generic' | 'rate_limited'>('generic');
  const [rateLimitClock, setRateLimitClock] = useState('14:12');
  const [verifiedGrant, setVerifiedGrant] = useState<ReauthGrant | null>(null);

  const keepAccountBtnRef = useRef<HTMLButtonElement | null>(null);
  const step2PasswordRef = useRef<HTMLInputElement | null>(null);
  const step2OauthBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmEmailInputRef = useRef<HTMLInputElement | null>(null);
  const expiredPasswordRef = useRef<HTMLInputElement | null>(null);
  const expiredOauthBtnRef = useRef<HTMLButtonElement | null>(null);
  const statusHeadingRef = useRef<HTMLDivElement | null>(null);

  const activeGrantRef = useRef<ReauthGrant | null>(null);
  const deleteIdempotencyKeyRef = useRef<string | null>(null);
  const inFlightDeleteRef = useRef(false);
  const wasOpenRef = useRef(false);
  const skipFocusReturnRef = useRef(false);
  const skipFocusTargetSelectorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const nowRef = useRef(now);
  nowRef.current = now;
  const reauthRef = useRef(reauth);
  reauthRef.current = reauth;
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const meRef = useRef(me);
  meRef.current = me;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const isBusy = viewState === 'del-busy';

  const getUsableGrant = useCallback((): ReauthGrant | null => {
    const currentNow = nowRef.current();
    if (
      activeGrantRef.current &&
      activeGrantRef.current.action === DELETE_ACCOUNT_ACTION &&
      grantStillValid(activeGrantRef.current.expires_at, currentNow)
    ) {
      return activeGrantRef.current;
    }
    const providerGrant = reauthRef.current.grant;
    if (
      providerGrant &&
      providerGrant.action === DELETE_ACCOUNT_ACTION &&
      grantStillValid(providerGrant.expires_at, currentNow)
    ) {
      return providerGrant;
    }
    return null;
  }, []);

  const wipeSecretInputs = useCallback(() => {
    setLoginPassword('');
    setReauthError(null);
    setEmailServerError(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (inFlightDeleteRef.current) {
        wasOpenRef.current = false;
      }
    };
  }, []);

  // Register secret form reset on vault lock / wake
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      setLoginPassword('');
    });
  }, [vault]);

  // Open / close lifecycle (mirrors ReadableExportDialog StrictMode & N1/R1 handling)
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      if (!inFlightDeleteRef.current) {
        wipeSecretInputs();
        setConfirmEmail('');
        setVerifiedGrant(null);
        activeGrantRef.current = null;
        deleteIdempotencyKeyRef.current = null;
        setViewState(initialView ?? 'del-s1');
      }
      return;
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      wipeSecretInputs();
      setConfirmEmail('');

      if (initialView) {
        setViewState(initialView);
        return;
      }

      const currentReauth = reauthRef.current;
      if (currentReauth.grant && currentReauth.grant.action === DELETE_ACCOUNT_ACTION) {
        if (resume === false) {
          currentReauth.clearGrant();
          activeGrantRef.current = null;
          setVerifiedGrant(null);
        } else if (grantStillValid(currentReauth.grant.expires_at, nowRef.current())) {
          activeGrantRef.current = currentReauth.grant;
          setVerifiedGrant(currentReauth.grant);
          setViewState('del-s2');
          return;
        } else {
          currentReauth.clearGrant();
          activeGrantRef.current = null;
          setVerifiedGrant(null);
          setViewState('del-reauth-expired');
          return;
        }
      } else if (resume === true) {
        void currentReauth.begin(DELETE_ACCOUNT_ACTION, DELETE_ACCOUNT_RETURN_TO).catch(() => undefined);
        setViewState('del-s2');
        return;
      }

      setViewState('del-s1');
    }
  }, [initialView, open, resume, wipeSecretInputs]);

  // Focus management on state transitions (FE-R1-13)
  useEffect(() => {
    if (!open) return;
    const handle = window.requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (viewState === 'del-s1') {
        keepAccountBtnRef.current?.focus();
        return;
      }
      if (viewState === 'del-s2') {
        if (hasPassword && step2PasswordRef.current) {
          step2PasswordRef.current.focus();
        } else if (!hasPassword && getUsableGrant() && confirmEmailInputRef.current) {
          confirmEmailInputRef.current.focus();
        } else if (step2OauthBtnRef.current) {
          step2OauthBtnRef.current.focus();
        } else if (confirmEmailInputRef.current) {
          confirmEmailInputRef.current.focus();
        }
        return;
      }
      if (viewState === 'del-reauth-expired') {
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
  }, [getUsableGrant, hasPassword, open, viewState]);

  const handleClose = useCallback(() => {
    if (inFlightDeleteRef.current || viewState === 'del-busy') return;
    wipeSecretInputs();
    setConfirmEmail('');
    activeGrantRef.current = null;
    setVerifiedGrant(null);
    deleteIdempotencyKeyRef.current = null;
    if (reauth.grant?.action === DELETE_ACCOUNT_ACTION) {
      reauth.clearGrant();
    }
    if (reauth.pendingAction === DELETE_ACCOUNT_ACTION) {
      reauth.cancel();
    }
    onOpenChange(false);
  }, [onOpenChange, reauth, viewState, wipeSecretInputs]);

  const handleContinueToStep2 = useCallback(() => {
    wipeSecretInputs();
    const usable = getUsableGrant();
    if (usable) {
      activeGrantRef.current = usable;
      setVerifiedGrant(usable);
    } else {
      void reauth.begin(DELETE_ACCOUNT_ACTION, DELETE_ACCOUNT_RETURN_TO).catch(() => undefined);
    }
    setViewState('del-s2');
  }, [getUsableGrant, reauth, wipeSecretInputs]);

  const handleBackToStep1 = useCallback(() => {
    if (inFlightDeleteRef.current || submittingReauth) return;
    wipeSecretInputs();
    setViewState('del-s1');
  }, [submittingReauth, wipeSecretInputs]);

  const executeDeleteWithGrant = useCallback(
    async (grantToken: string) => {
      if (inFlightDeleteRef.current) return;
      inFlightDeleteRef.current = true;
      setReauthError(null);
      setEmailServerError(null);
      setViewState('del-busy');

      if (!deleteIdempotencyKeyRef.current) {
        deleteIdempotencyKeyRef.current = createIdempotencyKey();
      }
      const submittedEmail = normalizeConfirmEmail(confirmEmail || userEmail);
      const userId = meRef.current?.user.id ?? null;

      try {
        const callDelete = depsRef.current?.deleteAccount ?? deleteAccount;
        await callDelete({
          confirmEmail: submittedEmail,
          reauthToken: grantToken,
          idempotencyKey: deleteIdempotencyKeyRef.current,
        });

        // Post-204 cleanup per plan Task 13:
        // vault.lock() + purgeDeviceKeysOnRevoked(user.id) + clear TanStack cache + navigate to /app/auth/login?deleted=1
        const purgeFn = depsRef.current?.purgeDeviceKeysOnRevoked ?? purgeDeviceKeysOnRevoked;
        const purgePromise = purgeFn(userId);
        try {
          if (vaultRef.current?.lock) {
            await vaultRef.current.lock({ broadcast: false, reason: 'logout' });
          }
        } catch {
          // Best-effort local vault lock after 204
        }
        try {
          await purgePromise;
        } catch {
          // Best-effort DevKey purge after 204
        }
        setKnownDeviceSessionUserId(null);
        try {
          clearPrivateCache();
          queryClient.clear();
        } catch {
          // Best-effort query cache clear
        }
        try {
          postSessionBroadcast({ type: 'signed_out', reason: 'revoked' });
        } catch {
          // Best-effort cross-tab broadcast
        }

        deleteIdempotencyKeyRef.current = null;
        activeGrantRef.current = null;
        inFlightDeleteRef.current = false;

        if (mountedRef.current) {
          setLoginPassword('');
          setConfirmEmail('');
          setVerifiedGrant(null);
          setViewState('del-done');
        }

        const navigate = depsRef.current?.navigateToDeletedLogin ?? defaultNavigateToDeletedLogin;
        navigate(LOGIN_DELETED_HREF);
      } catch (err) {
        inFlightDeleteRef.current = false;
        if (!mountedRef.current) return;

        const classified = classifyAccountDeleteError(err, nowRef.current());
        if (!classified.canRetrySameOperation) {
          deleteIdempotencyKeyRef.current = null;
        }

        if (classified.kind === 'confirm_email_invalid') {
          setEmailServerError(t('confirmEmailMismatchError'));
          setViewState('del-s2');
          window.requestAnimationFrame(() => {
            if (!mountedRef.current) return;
            confirmEmailInputRef.current?.focus();
          });
          return;
        }

        if (classified.kind === 'reauth_expired') {
          activeGrantRef.current = null;
          setVerifiedGrant(null);
          if (reauthRef.current.grant?.action === DELETE_ACCOUNT_ACTION) {
            reauthRef.current.clearGrant();
          }
          setLoginPassword('');
          setReauthError(null);
          setViewState('del-reauth-expired');
          return;
        }

        if (classified.kind === 'rate_limited') {
          setFailedKind('rate_limited');
          setRateLimitClock(classified.retryClock ?? '14:12');
          setViewState('del-failed');
          return;
        }

        setFailedKind('generic');
        setViewState('del-failed');
      }
    },
    [clearPrivateCache, confirmEmail, queryClient, t, userEmail],
  );

  const handleStep2Submit = useCallback(async () => {
    if (inFlightDeleteRef.current || submittingReauth) return;
    if (!isConfirmEmailMatching(confirmEmail, userEmail)) return;

    const existingGrant = getUsableGrant();
    if (existingGrant && (!hasPassword || !loginPassword)) {
      await executeDeleteWithGrant(existingGrant.grant);
      return;
    }

    if (!hasPassword || !loginPassword) return;

    setSubmittingReauth(true);
    setReauthError(null);
    setEmailServerError(null);
    const pwd = loginPassword;
    setLoginPassword('');

    try {
      const doReauth = depsRef.current?.reauthPassword ?? reauthPassword;
      const grant = await doReauth(DELETE_ACCOUNT_ACTION, pwd);
      if (!mountedRef.current) return;
      activeGrantRef.current = grant;
      setVerifiedGrant(grant);
      setSubmittingReauth(false);
      await executeDeleteWithGrant(grant.grant);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ProblemError) {
        if (err.problem.code === 'invalid_credentials') {
          setReauthError(t('invalidPasswordError'));
        } else if (err.problem.code === 'rate_limited') {
          setReauthError(tAuth('errors.rateLimitedTitle'));
        } else {
          setReauthError(tAuth('reauth.failed'));
        }
      } else {
        setReauthError(tAuth('errors.network'));
      }
      window.requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        step2PasswordRef.current?.focus();
      });
    } finally {
      if (mountedRef.current) {
        setSubmittingReauth(false);
      }
    }
  }, [
    confirmEmail,
    executeDeleteWithGrant,
    getUsableGrant,
    hasPassword,
    loginPassword,
    submittingReauth,
    t,
    tAuth,
    userEmail,
  ]);

  const handleExpiredVerifyAndDelete = useCallback(async () => {
    if (inFlightDeleteRef.current || submittingReauth || !hasPassword || !loginPassword) return;
    setSubmittingReauth(true);
    setReauthError(null);
    const pwd = loginPassword;
    setLoginPassword('');

    try {
      const doReauth = depsRef.current?.reauthPassword ?? reauthPassword;
      const grant = await doReauth(DELETE_ACCOUNT_ACTION, pwd);
      if (!mountedRef.current) return;
      activeGrantRef.current = grant;
      setVerifiedGrant(grant);
      setSubmittingReauth(false);
      await executeDeleteWithGrant(grant.grant);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ProblemError) {
        if (err.problem.code === 'invalid_credentials') {
          setReauthError(t('invalidPasswordError'));
        } else if (err.problem.code === 'rate_limited') {
          setReauthError(tAuth('errors.rateLimitedTitle'));
        } else {
          setReauthError(tAuth('reauth.failed'));
        }
      } else {
        setReauthError(tAuth('errors.network'));
      }
      window.requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        expiredPasswordRef.current?.focus();
      });
    } finally {
      if (mountedRef.current) {
        setSubmittingReauth(false);
      }
    }
  }, [executeDeleteWithGrant, hasPassword, loginPassword, submittingReauth, t, tAuth]);

  const handleGoogleReauth = useCallback(async () => {
    if (submittingReauth || inFlightDeleteRef.current) return;
    setReauthError(null);
    try {
      if (reauth.pendingAction !== DELETE_ACCOUNT_ACTION) {
        void reauth.begin(DELETE_ACCOUNT_ACTION, DELETE_ACCOUNT_RETURN_TO).catch(() => undefined);
      }
      await reauth.startOauthReauth('google', DELETE_ACCOUNT_RETURN_TO);
    } catch {
      if (!mountedRef.current) return;
      setReauthError(tAuth('reauth.failed'));
    }
  }, [reauth, submittingReauth, tAuth]);

  const handleRetryFailed = useCallback(() => {
    const usable = getUsableGrant();
    if (usable && isConfirmEmailMatching(confirmEmail, userEmail)) {
      void executeDeleteWithGrant(usable.grant);
      return;
    }
    activeGrantRef.current = null;
    setVerifiedGrant(null);
    if (reauth.grant?.action === DELETE_ACCOUNT_ACTION) {
      reauth.clearGrant();
    }
    setLoginPassword('');
    setReauthError(null);
    setViewState('del-reauth-expired');
  }, [confirmEmail, executeDeleteWithGrant, getUsableGrant, reauth, userEmail]);

  const usableGrant = verifiedGrant && grantStillValid(verifiedGrant.expires_at, now())
    ? verifiedGrant
    : getUsableGrant();
  const hasReadyAuth = Boolean(usableGrant) || (hasPassword && loginPassword.length > 0);
  const emailTrimmed = confirmEmail.trim();
  const emailMatches = isConfirmEmailMatching(confirmEmail, userEmail);
  const showEmailMismatchError = emailTrimmed.length > 0 && !emailMatches;
  const effectiveEmailError = emailServerError ?? (showEmailMismatchError ? t('confirmEmailMismatchError') : null);
  const canDeletePermanently =
    !submittingReauth && !inFlightDeleteRef.current && hasReadyAuth && emailMatches;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (isBusy || inFlightDeleteRef.current) return;
          handleClose();
        }
      }}
    >
      <DialogContent
        id="deleteDlg"
        aria-labelledby="deleteDlgTitle"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (viewState === 'del-s1') {
            keepAccountBtnRef.current?.focus();
          } else if (viewState === 'del-s2') {
            if (hasPassword && step2PasswordRef.current) {
              step2PasswordRef.current.focus();
            } else if (!hasPassword && usableGrant && confirmEmailInputRef.current) {
              confirmEmailInputRef.current.focus();
            } else if (step2OauthBtnRef.current) {
              step2OauthBtnRef.current.focus();
            } else {
              confirmEmailInputRef.current?.focus();
            }
          } else if (viewState === 'del-reauth-expired') {
            if (hasPassword && expiredPasswordRef.current) {
              expiredPasswordRef.current.focus();
            } else if (expiredOauthBtnRef.current) {
              expiredOauthBtnRef.current.focus();
            } else {
              statusHeadingRef.current?.focus();
            }
          } else {
            statusHeadingRef.current?.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (isBusy || inFlightDeleteRef.current) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (isBusy || inFlightDeleteRef.current) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isBusy || inFlightDeleteRef.current) {
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (skipFocusReturnRef.current) {
            skipFocusReturnRef.current = false;
            const selector = skipFocusTargetSelectorRef.current;
            skipFocusTargetSelectorRef.current = null;
            event.preventDefault();
            if (selector) {
              const target = document.querySelector<HTMLElement>(selector);
              target?.focus();
            }
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
            title={<span id="deleteDlgTitle">{t('title')}</span>}
            className="mb-4"
          />

          {viewState === 'del-s1' && (
            <section data-view="del-s1">
              <p className="m-0 mb-2 text-[14px] font-semibold text-body">
                {t('step1Heading')}
              </p>
              <ul className="mt-0 mb-4 list-disc space-y-1.5 pl-5 text-[13px] text-body">
                <li>{t('step1Bullet1')}</li>
                <li>{t('step1Bullet2')}</li>
                <li>{t('step1Bullet3')}</li>
                <li>{t('step1Bullet4')}</li>
              </ul>

              <div className="card mb-4 p-4">
                <p className="m-0 mb-3 text-[13px] text-body">{t('backupPrompt')}</p>
                <a
                  href="#dulieu"
                  className="btn btn-secondary btn-sm !whitespace-normal text-left no-underline"
                  data-testid="delete-account-download-backup-link"
                  onClick={(e) => {
                    e.preventDefault();
                    skipFocusReturnRef.current = true;
                    skipFocusTargetSelectorRef.current = '[data-testid="export-encrypted-start-btn"]';
                    handleClose();
                    const el = document.getElementById('dulieu');
                    el?.scrollIntoView?.({ behavior: 'smooth' });
                    const startBtn = document.querySelector<HTMLElement>(
                      '[data-testid="export-encrypted-start-btn"]',
                    );
                    startBtn?.focus();
                  }}
                >
                  {t('downloadBackupFirst')}
                </a>
              </div>

              <p className="m-0 mb-4 text-[12px] text-muted">
                {t('resetAlternativePrefix')}
                <a
                  href="#baomat"
                  className="text-link"
                  data-testid="delete-account-reset-vault-link"
                  onClick={(e) => {
                    e.preventDefault();
                    skipFocusReturnRef.current = true;
                    skipFocusTargetSelectorRef.current = '[data-open-dialog="resetDlg"]';
                    handleClose();
                    const el =
                      document.getElementById('baomat') ??
                      document.querySelector<HTMLElement>('[data-testid="vault-reset-card"]');
                    el?.scrollIntoView?.({ behavior: 'smooth' });
                    const resetBtn = document.querySelector<HTMLElement>(
                      '[data-open-dialog="resetDlg"]',
                    );
                    resetBtn?.focus();
                  }}
                >
                  {t('resetAlternativeLink')}
                </a>
                {t('resetAlternativeSuffix')}
              </p>

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  ref={keepAccountBtnRef}
                  type="button"
                  className="btn touch-target btn-tertiary"
                  data-testid="delete-account-keep-btn"
                  onClick={handleClose}
                >
                  {t('keepAccountButton')}
                </button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="delete-account-continue-btn"
                  onClick={handleContinueToStep2}
                >
                  {t('continueButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'del-s2' && (
            <section data-view="del-s2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canDeletePermanently) {
                    void handleStep2Submit();
                  }
                }}
              >
                {usableGrant && !hasPassword && (
                  <div
                    role="status"
                    className="auth-status mb-4"
                    data-testid="delete-account-oauth-verified-status"
                  >
                    {t('verifiedStatus')}
                  </div>
                )}

                {hasPassword && (
                  <Field
                    ref={step2PasswordRef}
                    id="delete-account-password"
                    label={t('passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => {
                      setLoginPassword(e.target.value);
                      if (reauthError) setReauthError(null);
                    }}
                    hint={hasGoogleOauth ? t('passwordHint') : t('passwordOnlyHint')}
                    error={reauthError ?? undefined}
                    readOnly={submittingReauth}
                    aria-busy={submittingReauth || undefined}
                    wrapperClassName="mb-4"
                  />
                )}

                {!hasPassword && hasGoogleOauth && !usableGrant && (
                  <p className="field-hint m-0 mb-3">{t('oauthOnlyHint')}</p>
                )}

                {!hasPassword && reauthError && (
                  <div role="alert" className="auth-alert mb-3">
                    {reauthError}
                  </div>
                )}

                {hasGoogleOauth && (
                  <button
                    ref={step2OauthBtnRef}
                    type="button"
                    className="touch-target btn btn-secondary btn-sm mb-4"
                    data-testid="delete-account-oauth-btn"
                    disabled={submittingReauth}
                    onClick={() => void handleGoogleReauth()}
                  >
                    {t('verifyGoogleButton')}
                  </button>
                )}

                <div className="field mb-4">
                  <label className="field-label" htmlFor="delete-account-confirm-email">
                    {t('confirmEmailLabel', { email: userEmail })}
                  </label>
                  <input
                    ref={confirmEmailInputRef}
                    id="delete-account-confirm-email"
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                    className="field-input"
                    data-testid="delete-account-email-input"
                    value={confirmEmail}
                    readOnly={submittingReauth}
                    aria-invalid={effectiveEmailError ? 'true' : undefined}
                    aria-describedby={effectiveEmailError ? 'delEmailErr' : undefined}
                    onChange={(e) => {
                      setConfirmEmail(e.target.value);
                      if (emailServerError) setEmailServerError(null);
                    }}
                  />
                  {effectiveEmailError && (
                    <span
                      id="delEmailErr"
                      role="alert"
                      className="field-error text-error-ink"
                    >
                      {effectiveEmailError}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap justify-between gap-2">
                  <Button
                    type="button"
                    variant="tertiary"
                    data-testid="delete-account-back-btn"
                    disabled={submittingReauth}
                    onClick={handleBackToStep1}
                  >
                    {t('backButton')}
                  </Button>
                  <Button
                    type="submit"
                    variant="danger"
                    className="!whitespace-normal text-left"
                    data-testid="delete-account-submit-btn"
                    disabled={!canDeletePermanently}
                    aria-busy={submittingReauth || undefined}
                  >
                    {t('deletePermanentlyButton')}
                  </Button>
                </div>
              </form>
            </section>
          )}

          {viewState === 'del-busy' && (
            <section data-view="del-busy">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                className="auth-status mb-0 outline-none"
                data-testid="delete-account-busy-status"
              >
                {t('busyStatus')}
              </div>
            </section>
          )}

          {viewState === 'del-failed' && (
            <section data-view="del-failed">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="alert"
                className="auth-alert mb-3 outline-none"
                data-testid="delete-account-failed-alert"
              >
                {failedKind === 'rate_limited'
                  ? t('rateLimitedAlert', { clock: rateLimitClock })
                  : t('failedAlert')}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="tertiary"
                  data-testid="delete-account-close-btn"
                  onClick={handleClose}
                >
                  {t('closeButton')}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  data-testid="delete-account-retry-btn"
                  onClick={handleRetryFailed}
                >
                  {t('retryButton')}
                </Button>
              </div>
            </section>
          )}

          {viewState === 'del-reauth-expired' && (
            <section data-view="del-reauth-expired">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hasPassword && loginPassword && !submittingReauth) {
                    void handleExpiredVerifyAndDelete();
                  }
                }}
              >
                <div
                  ref={statusHeadingRef}
                  tabIndex={-1}
                  role="alert"
                  className="auth-alert mb-3 outline-none"
                  data-testid="delete-account-reauth-expired-alert"
                >
                  {hasGoogleOauth ? t('reauthExpiredAlert') : t('reauthExpiredPasswordOnlyAlert')}
                </div>

                {hasPassword && (
                  <Field
                    ref={expiredPasswordRef}
                    id="delete-account-expired-password"
                    label={t('passwordLabel')}
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => {
                      setLoginPassword(e.target.value);
                      if (reauthError) setReauthError(null);
                    }}
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
                      data-testid="delete-account-expired-oauth-btn"
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
                      data-testid="delete-account-cancel-btn"
                      disabled={submittingReauth}
                      onClick={handleClose}
                    >
                      {t('cancelButton')}
                    </Button>
                    {hasPassword ? (
                      <Button
                        type="submit"
                        variant="danger"
                        data-testid="delete-account-verify-delete-btn"
                        disabled={submittingReauth || !loginPassword}
                        aria-busy={submittingReauth || undefined}
                      >
                        {t('verifyAndDeleteButton')}
                      </Button>
                    ) : (
                      hasGoogleOauth && (
                        <button
                          ref={expiredOauthBtnRef}
                          type="button"
                          className="touch-target btn btn-danger"
                          data-testid="delete-account-expired-oauth-btn"
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

          {viewState === 'del-done' && (
            <section data-view="del-done">
              <div
                ref={statusHeadingRef}
                tabIndex={-1}
                role="status"
                className="auth-status mb-3 outline-none"
                data-testid="delete-account-done-status"
              >
                {t('doneStatus')}
              </div>
              <Link
                href="/"
                className="btn btn-tertiary touch-target no-underline"
                data-testid="delete-account-go-home-link"
              >
                {t('goHomeButton')}
              </Link>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
