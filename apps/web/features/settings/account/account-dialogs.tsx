'use client';

import { ProblemError } from '@engram/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  changeEmail,
  changePassword,
  oauthLinkStart,
  revokeOtherSessions,
  unlinkIdentity,
  type IdentityProvider,
  type OauthProvider,
  type ReauthAction,
} from '@/lib/api/auth';

export type AccountDialogId =
  | 'emailChangeDlg'
  | 'passwordChangeDlg'
  | 'linkProviderDlg'
  | 'unlinkProviderDlg'
  | 'reauthDlg'
  | 'revokeSessionsDlg';

type DialogContext = { provider?: OauthProvider | IdentityProvider };

export type AccountNotice = { tone: 'sent' | 'error'; message: string };

export function useAccountDialogs() {
  const [active, setActive] = useState<AccountDialogId | null>(null);
  const [context, setContext] = useState<DialogContext>({});
  return {
    active,
    context,
    open: (id: AccountDialogId, ctx: DialogContext = {}) => {
      setContext(ctx);
      setActive(id);
    },
    close: () => setActive(null),
  };
}

function DialogShell({ children }: { children: React.ReactNode }) {
  return <div className="panel p-7">{children}</div>;
}

export function AccountDialogs({
  active,
  context,
  close,
  open,
  onNotice,
}: {
  active: AccountDialogId | null;
  context: DialogContext;
  close: () => void;
  open: (id: AccountDialogId, ctx?: DialogContext) => void;
  onNotice?: (notice: AccountNotice) => void;
}) {
  const t = useTranslations('settings');
  const queryClient = useQueryClient();
  const { me, reauth, refetchMe } = useSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reauthPassword, setReauthPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingKind, setPendingKind] = useState<
    'email' | 'password' | 'link' | 'unlink' | 'revoke' | null
  >(null);

  const clearSensitiveFields = useCallback(() => {
    setPassword('');
    setConfirm('');
    setReauthPassword('');
  }, []);

  const dismissIf = (id: AccountDialogId) => (openState: boolean) => {
    if (!openState && active === id && !pending) {
      if (id === 'passwordChangeDlg' || id === 'reauthDlg') {
        clearSensitiveFields();
      }
      if (id === 'reauthDlg') {
        reauth.cancel();
      }
      close();
    }
  };

  const runMutation = useCallback(
    async (token: string, kind: NonNullable<typeof pendingKind>) => {
      if (kind === 'email') {
        await changeEmail(email.trim(), token);
        onNotice?.({ tone: 'sent', message: t('account.emailPending', { email: email.trim() }) });
      } else if (kind === 'password') {
        await changePassword({ new_password: password }, token);
        clearSensitiveFields();
        onNotice?.({ tone: 'sent', message: t('account.passwordReplaced') });
      } else if (kind === 'link') {
        const provider = context.provider as OauthProvider;
        const { authorization_url } = await oauthLinkStart(provider, token);
        window.location.assign(authorization_url);
        return;
      } else if (kind === 'unlink') {
        await unlinkIdentity(context.provider as IdentityProvider, token);
      } else if (kind === 'revoke') {
        await revokeOtherSessions(token);
      }
      reauth.clearGrant();
      await refetchMe();
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
      close();
    },
    [clearSensitiveFields, close, context.provider, email, onNotice, password, queryClient, reauth, refetchMe, t],
  );

  const goReauth = useCallback(
    (action: ReauthAction, kind: NonNullable<typeof pendingKind>) => {
      setPendingKind(kind);
      setError(null);
      void reauth.begin(action).catch(() => undefined);
      open('reauthDlg', context);
    },
    [context, open, reauth],
  );

  const runOrReauth = useCallback(
    (action: ReauthAction, kind: NonNullable<typeof pendingKind>) => {
      if (reauth.hasUsableGrant(action) && reauth.grant) {
        const grantToken = reauth.grant.grant;
        void (async () => {
          setPending(true);
          setError(null);
          try {
            await runMutation(grantToken, kind);
          } catch (err) {
            setError(
              err instanceof ProblemError
                ? err.problem.code === 'email_not_verified'
                  ? t('account.linkRequiresVerifiedEmail')
                  : kind === 'link'
                    ? t('errors.generic')
                    : (err.problem.detail ?? err.problem.title)
                : t('errors.generic'),
            );
          } finally {
            setPending(false);
          }
        })();
        return;
      }
      goReauth(action, kind);
    },
    [goReauth, reauth, runMutation, t],
  );

  const handleReauthSubmit = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const grantResult = await reauth.submitPassword(reauthPassword);
      setReauthPassword('');
      if (!grantResult || !pendingKind) throw new Error('missing grant');
      await runMutation(grantResult.grant, pendingKind);
    } catch (err) {
      setError(
        err instanceof ProblemError
          ? err.problem.code === 'email_not_verified'
            ? t('account.linkRequiresVerifiedEmail')
            : (err.problem.detail ?? err.problem.title)
          : t('errors.generic'),
      );
    } finally {
      setPending(false);
    }
  }, [pendingKind, reauth, reauthPassword, runMutation, t]);

  if (!me) return null;

  return (
    <>
      <Dialog open={active === 'emailChangeDlg'} onOpenChange={dismissIf('emailChangeDlg')}>
        <DialogContent id="emailChangeDlg">
          <DialogShell>
            <DialogHeader title={t('dialogs.email.title')} description={t('dialogs.email.description')} />
            <Field
              label={t('dialogs.email.label')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              wrapperClassName="mt-5 mb-0"
            />
            <DialogFooter className="mt-6">
              <Button variant="tertiary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button disabled={!email.trim() || pending} onClick={() => runOrReauth('account.email_change', 'email')}>
                {t('dialogs.email.submit')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>

      <Dialog open={active === 'passwordChangeDlg'} onOpenChange={dismissIf('passwordChangeDlg')}>
        <DialogContent id="passwordChangeDlg">
          <DialogShell>
            <DialogHeader title={t('dialogs.password.title')} description={t('dialogs.password.description')} />
            <Field
              label={t('dialogs.password.new')}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={t('account.passwordHint')}
              wrapperClassName="mb-4 mt-5"
            />
            <Field
              label={t('dialogs.password.confirm')}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && (
              <AuthStatus tone="error" className="mt-4">
                {error}
              </AuthStatus>
            )}
            <DialogFooter className="mt-6">
              <Button
                variant="tertiary"
                onClick={() => {
                  clearSensitiveFields();
                  close();
                }}
                disabled={pending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                disabled={pending}
                onClick={() => {
                  if (password.length < 12) {
                    setError(t('account.passwordTooShort'));
                    return;
                  }
                  if (password !== confirm) {
                    setError(t('account.passwordMismatch'));
                    return;
                  }
                  runOrReauth('account.password_change', 'password');
                }}
              >
                {t('dialogs.password.submit')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>

      <Dialog open={active === 'linkProviderDlg'} onOpenChange={dismissIf('linkProviderDlg')}>
        <DialogContent id="linkProviderDlg">
          <DialogShell>
            <DialogHeader
              title={t('dialogs.link.title', { provider: context.provider === 'google' ? 'Google' : 'GitHub' })}
              description={t('dialogs.link.description')}
            />
            {error && (
              <AuthStatus tone="error" className="mt-4">
                {error}
              </AuthStatus>
            )}
            <DialogFooter className="mt-6">
              <Button variant="tertiary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button disabled={pending} onClick={() => runOrReauth('account.identity_link', 'link')}>
                {t('common.continue')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>

      <Dialog open={active === 'unlinkProviderDlg'} onOpenChange={dismissIf('unlinkProviderDlg')}>
        <DialogContent id="unlinkProviderDlg">
          <DialogShell>
            <DialogHeader
              title={t('dialogs.unlink.title', { provider: context.provider === 'github' ? 'GitHub' : 'Google' })}
              description={t('dialogs.unlink.description')}
            />
            <DialogFooter className="mt-6">
              <Button variant="tertiary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => runOrReauth('account.identity_unlink', 'unlink')}>
                {t('dialogs.unlink.submit')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>

      <Dialog open={active === 'revokeSessionsDlg'} onOpenChange={dismissIf('revokeSessionsDlg')}>
        <DialogContent id="revokeSessionsDlg">
          <DialogShell>
            <DialogHeader title={t('dialogs.revoke.title')} description={t('dialogs.revoke.description')} />
            <DialogFooter className="mt-6">
              <Button variant="tertiary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" disabled={pending} onClick={() => runOrReauth('session.revoke_others', 'revoke')}>
                {t('dialogs.revoke.submit')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>

      <Dialog open={active === 'reauthDlg'} onOpenChange={dismissIf('reauthDlg')}>
        <DialogContent id="reauthDlg">
          <DialogShell>
            <DialogHeader title={t('dialogs.reauth.title')} description={t('dialogs.reauth.description')} />
            {reauth.capabilities.hasPassword && (
              <Field
                label={t('dialogs.reauth.password')}
                type="password"
                autoComplete="current-password"
                value={reauthPassword}
                onChange={(e) => setReauthPassword(e.target.value)}
                disabled={pending}
                wrapperClassName="mb-4 mt-5"
              />
            )}
            {reauth.capabilities.oauthReauthProviders.includes('google') && (
              <Button
                variant="secondary"
                className="mb-4 w-full !justify-center"
                onClick={() => void reauth.startOauthReauth('google', '/app/settings')}
                disabled={pending}
              >
                {t('dialogs.reauth.google')}
              </Button>
            )}
            {(error || reauth.error) && <AuthStatus tone="error">{error ?? reauth.error}</AuthStatus>}
            <DialogFooter className="mt-4">
              <Button
                variant="tertiary"
                onClick={() => {
                  reauth.cancel();
                  clearSensitiveFields();
                  close();
                }}
                disabled={pending}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void handleReauthSubmit()} disabled={pending} aria-busy={pending}>
                {pending ? t('dialogs.reauth.submitting') : t('dialogs.reauth.submit')}
              </Button>
            </DialogFooter>
          </DialogShell>
        </DialogContent>
      </Dialog>
    </>
  );
}
