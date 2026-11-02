'use client';

import { ProblemError } from '@engram/shared-types';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { useVault } from '@/features/vault/vault-provider';
import type { ReauthAction } from '@/lib/api/auth';
import { PASSKEY_NAME_MAX_RUNES } from './credential-name';
import type { PasskeyRegisterErrorCode, PasskeyRegisterOutcome } from './register-flow';
import { usePasskeyRegister } from './use-passkey-register';

const REGISTER_ACTION: ReauthAction = 'vault.passkey_register';

export interface PasskeyAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where an OAuth re-auth returns to (it navigates the whole page, which drops the Worker and the VK). */
  returnPath: string;
  /** Called with the saved passkey; the dialog closes itself afterwards. */
  onRegistered?: (outcome: Extract<PasskeyRegisterOutcome, { ok: true }>) => void;
  /** Opener button to return keyboard focus to on Cancel / Escape (`PasskeyAddEntry` sets this on press). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function failureKey(error: PasskeyRegisterErrorCode, nameReason?: string): string | null {
  switch (error) {
    case 'name_invalid':
      return `register.name.${nameReason ?? 'forbidden_chars'}`;
    case 'reauth_cancelled':
      return 'register.reauthCancelled';
    case 'reauth_restart_required':
      return 'register.reauthRestart';
    case 'network_unknown':
      return 'register.unconfirmedNotice';
    case 'stale':
      return null;
    default:
      return error;
  }
}

/**
 * Naming dialog of mockups/settings.html `#passkeyAddDlg`. Step 1 takes the `vault.passkey_register` grant the moment
 * the dialog opens (password in place, or Google which leaves the page), step 2 names the credential and runs plan
 * §2.5 steps 2-6. Self-contained: the host only mounts it (Settings is T20B, onboarding step 3 is T16B).
 */
export function PasskeyAddDialog({ open, onOpenChange, returnPath, onRegistered, returnFocusRef }: PasskeyAddDialogProps) {
  const t = useTranslations('vault.passkey');
  const tAuth = useTranslations('auth');
  const { reauth } = useSession();
  const vault = useVault();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const { pending, renewing, failure, register, clearFailure } = usePasskeyRegister({
    returnPath,
    onRegistered: (outcome) => {
      onRegistered?.(outcome);
      setName('');
      onOpenChange(false);
    },
  });

  const reauthOpen = reauth.pendingAction === REGISTER_ACTION;
  const grantReady = reauth.hasUsableGrant(REGISTER_ACTION);
  // Post-wrap renewal is in-place only: a full-page Google redirect would destroy the Worker and pending wrap.
  const canUseGoogle = reauth.capabilities.oauthReauthProviders.includes('google') && !renewing;
  const reauthBusy = reauth.submitting || oauthPending;

  // Remember the element that held focus before the dialog opened so Cancel / Escape restores it even when the caller
  // opened the dialog without a DialogTrigger.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  // Step 1: the grant is taken when "Add passkey" is pressed, before anything else.
  useEffect(() => {
    if (open && !grantReady && !reauthOpen && !pending) {
      void reauth.begin(REGISTER_ACTION, returnPath).catch(() => undefined);
    }
  }, [grantReady, open, pending, reauth, reauthOpen, returnPath]);

  // Lock / logout wipes the re-auth password field synchronously.
  const { registerSecretFormReset } = vault;
  useEffect(() => registerSecretFormReset(() => setPassword('')), [registerSecretFormReset]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // An authenticator prompt cannot be withdrawn; an in-place re-auth prompt can.
      if (pending && !reauthOpen) return;
      if (reauthOpen) reauth.cancel();
      setPassword('');
      setName('');
      setOauthPending(false);
      setOauthError(null);
      clearFailure();
    }
    onOpenChange(next);
  };

  const confirmPassword = async () => {
    const typed = password;
    setPassword('');
    setOauthError(null);
    try {
      await reauth.submitPassword(typed);
    } catch {
      /* the failure is shown through reauth.error and the prompt stays open */
    }
  };

  const startGoogleReauth = async () => {
    if (reauthBusy) return;
    setOauthPending(true);
    setOauthError(null);
    try {
      await reauth.startOauthReauth('google', returnPath);
    } catch (err) {
      const detail = err instanceof ProblemError ? err.problem.detail ?? err.problem.title : null;
      setOauthError(detail || t('add.oauthStartFailed'));
    } finally {
      setOauthPending(false);
    }
  };

  const key = failure ? failureKey(failure.error, failure.nameReason) : null;
  const cancelledQuietly = failure?.error === 'register_cancelled';
  const statusError = reauth.error ?? oauthError;
  const noMethodAtAll =
    !reauth.capabilities.hasPassword && !canUseGoogle && !reauth.capabilities.passwordEnrollmentAvailable;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        id="passkeyAddDlg"
        onCloseAutoFocus={(event) => {
          const opener = returnFocusRef?.current ?? openerRef.current;
          if (opener && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <div className="panel max-h-[90vh] w-[min(560px,94vw)] overflow-auto p-7">
          <DialogHeader title={t('add.title')} description={t('add.description')} />

          <div className="card p-5 my-5">
            {reauthOpen && (
              <div className="mb-4">
                <p className="t-label mb-2 text-muted">
                  {t('add.reauthStep')}
                </p>
                {reauth.capabilities.hasPassword && (
                  <>
                    <Field
                      label={tAuth('fields.password')}
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void confirmPassword();
                      }}
                      disabled={reauthBusy}
                      passwordToggleLabels={{ show: t('add.showPassword'), hide: t('add.hidePassword') }}
                      wrapperClassName="mb-3"
                      data-vault-secret="true"
                    />
                    <Button
                      className="w-full !justify-center mb-2"
                      onClick={() => void confirmPassword()}
                      disabled={reauthBusy || password.length === 0}
                    >
                      {reauth.submitting ? tAuth('reauth.submitting') : tAuth('reauth.confirm')}
                    </Button>
                  </>
                )}
                {!reauth.capabilities.hasPassword && reauth.capabilities.passwordEnrollmentAvailable && (
                  <div className="mb-3">
                    <p className="mb-3 text-[13px] text-body">
                      {tAuth('reauth.oauthOnlyHint')}
                    </p>
                    <Link
                      href="/app/auth/password-enroll"
                      className="btn btn-secondary btn-sm no-underline"
                      onClick={() => handleOpenChange(false)}
                    >
                      {tAuth('reauth.enrollCta')}
                    </Link>
                  </div>
                )}
                {canUseGoogle && (
                  <>
                    <Button
                      variant="secondary"
                      className="w-full !justify-center mb-2"
                      onClick={() => void startGoogleReauth()}
                      disabled={reauthBusy}
                      aria-busy={oauthPending}
                    >
                      {oauthPending ? tAuth('reauth.submitting') : tAuth('reauth.google')}
                    </Button>
                    <p className="text-[12px] m-0 text-muted">
                      {t('add.googleNote')}
                    </p>
                  </>
                )}
                {noMethodAtAll && (
                  <p role="status" className="m-0 text-[13px] text-muted">
                    {t('add.noReauthMethod')}
                  </p>
                )}
                {statusError && (
                  <AuthStatus tone="error" className="mt-3">
                    {statusError}
                  </AuthStatus>
                )}
              </div>
            )}
            <Field
              label={t('register.nameLabel')}
              hint={t('register.nameHint', { max: PASSKEY_NAME_MAX_RUNES })}
              value={name}
              maxLength={PASSKEY_NAME_MAX_RUNES * 2}
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                if (failure?.error === 'name_invalid') clearFailure();
              }}
              disabled={pending}
              wrapperClassName="mb-0"
            />
          </div>

          {key && (
            <div
              role="alert"
              className={`card mb-4 p-4${cancelledQuietly ? '' : ' card-error'}`}
            >
              <p className="m-0 text-[14px] font-semibold text-body">
                {t(key)}
              </p>
            </div>
          )}
          {failure?.orphan && (
            <div role="status" className="card p-4 mb-4">
              <p className="m-0 text-[13px] text-muted">
                {t('register.orphanNotice')}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="tertiary" onClick={() => handleOpenChange(false)} disabled={pending && !reauthOpen}>
              {t('add.cancel')}
            </Button>
            <Button
              onClick={() => void register(name)}
              disabled={pending || reauthOpen || !grantReady}
              aria-busy={pending}
            >
              {pending ? t('register.pending') : t('add.continue')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface PasskeyAddEntryProps extends Omit<PasskeyAddDialogProps, 'open' | 'onOpenChange'> {
  className?: string;
}

/** "Add passkey" button + its naming dialog; the host places it (Settings passkey card, onboarding step 3). */
export function PasskeyAddEntry({ className, ...dialogProps }: PasskeyAddEntryProps) {
  const t = useTranslations('vault.passkey');
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <>
      <Button
        variant="tertiary"
        className={className}
        onClick={(e) => {
          openerRef.current = e.currentTarget;
          setOpen(true);
        }}
      >
        {t('add.button')}
      </Button>
      <PasskeyAddDialog {...dialogProps} open={open} onOpenChange={setOpen} returnFocusRef={openerRef} />
    </>
  );
}
