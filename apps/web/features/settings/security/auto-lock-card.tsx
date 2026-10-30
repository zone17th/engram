'use client';

import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { AuthStatus } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useSession } from '@/features/auth/session-provider';
import { DEFAULT_AUTO_LOCK_MINUTES, normalizeAutoLockMinutes } from '@/features/vault/auto-lock';
import { useRememberDevice } from '@/features/vault/device/use-remember-device';
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
   * Optional override slot for the "Remember this device" section (`mockups/settings.html` lines 216-227).
   * Defaults to the built-in T18/T20B `RememberDeviceSection`.
   */
  rememberDeviceSlot?: ReactNode;
}

export function RememberDeviceSection() {
  const tDevice = useTranslations('vault.device');
  const tRemember = useTranslations('vault.b.settings.rememberDevice');
  const vault = useOptionalVault();
  const rememberDevice = useRememberDevice();

  if (!vault) return null;

  const isVaultUnlocked = vault.workerState === 'unlocked';
  const isUnavailable = rememberDevice.status === 'unavailable';
  const canToggle =
    !rememberDevice.busy &&
    !isUnavailable &&
    (rememberDevice.remembered || isVaultUnlocked);

  const handleToggle = async () => {
    if (!canToggle) return;
    if (rememberDevice.remembered) {
      await rememberDevice.forget();
    } else if (isVaultUnlocked) {
      await rememberDevice.remember();
    }
  };

  return (
    <div data-testid="settings-remember-device-section">
      <hr className="rule my-5" />
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="mb-1 text-[15px] font-semibold text-body">
            {tDevice('remember.label')}
          </div>
          <p className="m-0 text-[13px] text-muted">
            {tDevice('remember.description')}
          </p>
          <p
            className="m-0 mt-1 text-[12px] text-muted"
            data-testid="settings-remember-device-state"
          >
            {rememberDevice.remembered
              ? tDevice('remember.on')
              : tDevice('remember.off')}
          </p>
          {rememberDevice.remembered ? (
            <p
              className="m-0 mt-1 text-[12px] text-muted"
              data-testid="settings-remember-device-forget-description"
            >
              {tDevice('remember.forgetDescription')}
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {rememberDevice.remembered ? (
            <button
              type="button"
              className="btn btn-tertiary btn-sm"
              disabled={rememberDevice.busy || isUnavailable}
              onClick={() => void rememberDevice.forget()}
              data-testid="settings-forget-device-button"
            >
              {tDevice('remember.forget')}
            </button>
          ) : null}
          <button
            type="button"
            className={`switch${!canToggle ? ' cursor-not-allowed opacity-40' : ''}`}
            role="switch"
            aria-checked={rememberDevice.remembered}
            aria-busy={rememberDevice.busy || undefined}
            aria-label={tDevice('remember.label')}
            disabled={!canToggle}
            onClick={() => void handleToggle()}
            data-testid="settings-remember-device-switch"
          />
        </div>
      </div>
      {rememberDevice.notice === 'device_state_changed' ? (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted"
          data-testid="settings-remember-device-notice"
        >
          <span>{tDevice('notice.stateChanged')}</span>
          <button
            type="button"
            className="btn btn-tertiary btn-sm ml-auto"
            onClick={() => rememberDevice.dismissNotice()}
            data-testid="settings-remember-device-notice-dismiss"
          >
            {tRemember('dismiss')}
          </button>
        </div>
      ) : null}
      {isUnavailable ? (
        <p
          role="status"
          className="m-0 mt-3 text-[12px] text-muted"
          data-testid="settings-remember-device-unavailable"
        >
          {tDevice('unavailable')}
        </p>
      ) : null}
    </div>
  );
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
      <div aria-busy={saving || undefined}>
        <Segmented
          className="max-w-full flex-wrap"
          ariaLabel={t('selectorAria')}
          value={String(displayedValue)}
          onChange={(v) => void handleSelect(v)}
          options={[
            { value: '5', label: t('opt5') },
            { value: '15', label: t('opt15') },
            { value: '60', label: t('opt60') },
            { value: '0', label: t('optNever') },
          ]}
        />
      </div>
      {saving && (
        <p role="status" className="m-0 mt-3 text-[12px] text-muted" data-testid="settings-auto-lock-saving">
          {t('saving')}
        </p>
      )}
      {errorMessage && (
        <div className="mt-3" data-testid="settings-auto-lock-error">
          <AuthStatus tone="error">{errorMessage}</AuthStatus>
        </div>
      )}
      <div data-testid="settings-remember-device-slot">
        {rememberDeviceSlot ?? <RememberDeviceSection />}
      </div>
    </div>
  );
}
