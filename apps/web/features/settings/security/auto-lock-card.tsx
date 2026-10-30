'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { AuthStatus } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useSession } from '@/features/auth/session-provider';
import { DEFAULT_AUTO_LOCK_MINUTES, normalizeAutoLockMinutes } from '@/features/vault/auto-lock';
import { useOptionalVault } from '@/features/vault/vault-provider';
import { patchSettings } from '@/lib/api/auth';

export type AutoLockOptionValue = 5 | 15 | 60 | 0;

function isAutoLockOption(value: number): value is AutoLockOptionValue {
  return value === 5 || value === 15 || value === 60 || value === 0;
}

function resolveCurrentAutoLockMinutes(
  vaultAutoLockMinutes: number | undefined,
  meAutoLockMinutes: number | undefined,
): AutoLockOptionValue {
  if (typeof vaultAutoLockMinutes === 'number' && isAutoLockOption(vaultAutoLockMinutes)) {
    return vaultAutoLockMinutes;
  }
  const normalized = normalizeAutoLockMinutes(meAutoLockMinutes);
  return isAutoLockOption(normalized) ? normalized : DEFAULT_AUTO_LOCK_MINUTES;
}

export interface AutoLockCardProps {
  /**
   * Part D placeholder slot for the "Remember this device" section (`mockups/settings.html` lines 216-227).
   * Hidden (not rendered) in Part P until T18 is wired.
   */
  rememberDeviceSlot?: ReactNode;
}

export function AutoLockCard({ rememberDeviceSlot }: AutoLockCardProps = {}) {
  const t = useTranslations('vault.b.settings.autoLock');
  const { me, refetchMe } = useSession();
  const vault = useOptionalVault();

  const [pendingValue, setPendingValue] = useState<AutoLockOptionValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!vault || me?.vault.status !== 'present') return null;

  const effectiveMinutes = resolveCurrentAutoLockMinutes(
    vault.autoLockMinutes,
    me?.settings.auto_lock_minutes,
  );
  const displayedValue = pendingValue ?? effectiveMinutes;

  const handleSelect = async (rawNext: string) => {
    if (saving) return;
    const parsed = Number(rawNext);
    if (!isAutoLockOption(parsed) || parsed === effectiveMinutes) return;

    setErrorMessage(null);
    setPendingValue(parsed);
    setSaving(true);
    try {
      const updated = await patchSettings({ auto_lock_minutes: parsed });
      const committed = isAutoLockOption(updated.settings.auto_lock_minutes)
        ? updated.settings.auto_lock_minutes
        : parsed;
      vault.notifySettingsChanged({ auto_lock_minutes: committed });
      await refetchMe().catch(() => undefined);
    } catch {
      setErrorMessage(t('saveError'));
    } finally {
      setPendingValue(null);
      setSaving(false);
    }
  };

  return (
    <div className="card mb-3 p-5" data-testid="settings-auto-lock-card">
      <div className="mb-1 text-[15px] font-semibold text-body">{t('title')}</div>
      <p className="mb-4 text-[13px] text-muted">{t('body')}</p>
      <Segmented
        className="max-w-full flex-wrap"
        ariaLabel={t('selectorAria')}
        value={String(displayedValue)}
        disabled={saving}
        onChange={(v) => void handleSelect(v)}
        options={[
          { value: '5', label: t('opt5') },
          { value: '15', label: t('opt15') },
          { value: '60', label: t('opt60') },
          { value: '0', label: t('optNever') },
        ]}
      />
      {saving && (
        <p role="status" className="m-0 mt-3 text-[12px] text-muted" data-testid="settings-auto-lock-saving">
          {t('saving')}
        </p>
      )}
      {errorMessage && (
        <AuthStatus tone="error" className="mt-3" data-testid="settings-auto-lock-error">
          {errorMessage}
        </AuthStatus>
      )}
      {/* Part D placeholder slot for "Remember this device" — hidden (not rendered) until T18 is wired */}
      {rememberDeviceSlot ? (
        <div data-testid="settings-remember-device-slot">{rememberDeviceSlot}</div>
      ) : (
        <div hidden aria-hidden="true" data-testid="settings-remember-device-placeholder" />
      )}
    </div>
  );
}
