'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PasskeyAddEntry } from '@/features/vault/passkey';
import { useOptionalVault } from '@/features/vault/vault-provider';

const SETTINGS_PATH = '/app/settings';

/**
 * Settings passkey card (mockups/settings.html "passkey"): the Add-passkey entry only, shown while the vault is
 * unlocked (registration needs the PWK from the open vault). T20B grows this card into the list / rename / revoke UI.
 */
export function PasskeySecurityCard() {
  const vault = useOptionalVault();
  if (!vault || vault.workerState !== 'unlocked') return null;
  return <PasskeySecurityCardInner reloadVaultMeta={vault.reloadVaultMeta} />;
}

function PasskeySecurityCardInner({ reloadVaultMeta }: { reloadVaultMeta: () => Promise<unknown> }) {
  const t = useTranslations('vault.passkey');
  const [added, setAdded] = useState(false);

  return (
    <div className="card mb-3 p-5" data-testid="settings-passkey-card">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="mb-1 text-[15px] font-semibold text-body">{t('settings.title')}</div>
          <p className="m-0 text-[13px] text-muted">{t('settings.body')}</p>
        </div>
        <PasskeyAddEntry
          className="ml-auto"
          returnPath={SETTINGS_PATH}
          onRegistered={() => {
            setAdded(true);
            // The unlock screen lists passkeys from the cached vault metadata: refresh it so the new one shows.
            void reloadVaultMeta().catch(() => undefined);
          }}
        />
      </div>
      {added && (
        <p role="status" className="m-0 mt-4 text-[13px] text-muted" data-testid="settings-passkey-added">
          {t('settings.added')}
        </p>
      )}
    </div>
  );
}
