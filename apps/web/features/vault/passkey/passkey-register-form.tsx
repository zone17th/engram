'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { PASSKEY_NAME_MAX_RUNES } from './credential-name';
import type { PasskeyRegisterErrorCode } from './register-flow';
import { usePasskeyRegister, type UsePasskeyRegisterOptions } from './use-passkey-register';

export type PasskeyRegisterFormProps = UsePasskeyRegisterOptions;

function errorKey(error: PasskeyRegisterErrorCode, nameReason?: string): string | null {
  switch (error) {
    case 'name_invalid':
      return `register.name.${nameReason ?? 'forbidden_chars'}`;
    case 'reauth_cancelled':
      return 'register.reauthCancelled';
    case 'reauth_restart_required':
      return 'register.reauthRestart';
    case 'network_unknown':
      return 'register.networkUnknown';
    case 'stale':
      return null;
    default:
      return error;
  }
}

/**
 * Naming + "Add passkey" with the in-place password re-auth prompt. Not mounted anywhere yet (Settings is T20B,
 * onboarding step 3 is T16B).
 */
export function PasskeyRegisterForm(props: PasskeyRegisterFormProps) {
  const t = useTranslations('vault.passkey');
  const tAuth = useTranslations('auth');
  const { reauth } = useSession();
  const { pending, failure, register } = usePasskeyRegister(props);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const reauthOpen = reauth.pendingAction === 'vault.passkey_register';
  const key = failure ? errorKey(failure.error, failure.nameReason) : null;

  const confirmPassword = async () => {
    try {
      await reauth.submitPassword(password);
    } catch {
      /* the failure is shown through reauth.error and the prompt stays open */
    } finally {
      setPassword('');
    }
  };

  return (
    <div>
      <Field
        label={t('register.nameLabel')}
        hint={t('register.nameHint', { max: PASSKEY_NAME_MAX_RUNES })}
        value={name}
        maxLength={PASSKEY_NAME_MAX_RUNES * 2}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
        disabled={pending}
      />
      <Button
        onClick={() => void register(name)}
        disabled={pending || reauthOpen}
        aria-busy={pending}
      >
        {pending ? t('register.pending') : t('register.button')}
      </Button>

      {reauthOpen && (
        <div className="mt-4">
          {reauth.capabilities.hasPassword && (
            <>
              <Field
                label={tAuth('fields.password')}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={reauth.submitting}
              />
              {reauth.error && <AuthStatus tone="error">{reauth.error}</AuthStatus>}
              <Button onClick={() => void confirmPassword()} disabled={reauth.submitting}>
                {reauth.submitting ? tAuth('reauth.submitting') : tAuth('reauth.confirm')}
              </Button>
            </>
          )}
          {reauth.capabilities.oauthReauthProviders.includes('google') && (
            <Button
              variant="secondary"
              onClick={() => void reauth.startOauthReauth('google', props.returnPath)}
              disabled={reauth.submitting}
            >
              {tAuth('reauth.google')}
            </Button>
          )}
          <Button variant="tertiary" onClick={() => reauth.cancel()}>
            {tAuth('common.cancel')}
          </Button>
        </div>
      )}

      {key && (
        <p role="alert" className="mt-3 text-[13px] text-body">
          {t(key)}
        </p>
      )}
      {failure?.orphan && (
        <p role="status" className="mt-2 text-[13px] text-muted">
          {t('register.orphanNotice')}
        </p>
      )}
    </div>
  );
}
