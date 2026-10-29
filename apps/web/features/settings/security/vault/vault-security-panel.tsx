'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus } from '@/components/ui/field';
import { Toast } from '@/components/ui/toast';
import { useSession } from '@/features/auth/session-provider';
import { useOptionalVault, useVault } from '@/features/vault/vault-provider';
import { fetchRecoveryKeysStatus } from '@/lib/api/vault';
import { ChangePassphraseDialog } from './change-passphrase-dialog';
import { RecoveryKeysDialog, type RecoveryKeysDialogMode } from './recovery-keys-dialogs';
import { ResetVaultDialog } from './reset-vault-dialog';
import { formatSlotRange } from './vault-security-errors';

const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export interface VaultSecurityPanelProps {
  onOpenRevokeSessionsDialog?: () => void;
}

export function VaultSecurityPanel({ onOpenRevokeSessionsDialog }: VaultSecurityPanelProps) {
  const vaultCtx = useOptionalVault();
  if (!vaultCtx) {
    return null;
  }
  return <VaultSecurityPanelInner onOpenRevokeSessionsDialog={onOpenRevokeSessionsDialog} />;
}

function VaultSecurityPanelInner({ onOpenRevokeSessionsDialog }: VaultSecurityPanelProps) {
  const t = useTranslations('settings.vaultSecurity');
  const queryClient = useQueryClient();
  const { me, sessionEpoch, refetchMe } = useSession();
  const vault = useVault();

  const [passDialogOpen, setPassDialogOpen] = useState(false);
  const [rkDialogMode, setRkDialogMode] = useState<RecoveryKeysDialogMode | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const isVaultPresent = me?.vault.status === 'present';
  const isVaultUnlocked = vault.workerState === 'unlocked';
  const requiresUnlockedDisabled = !isVaultPresent || !isVaultUnlocked || vault.inFlight;
  const resetDisabled = !isVaultPresent || vault.inFlight;

  // Ensure `GET /vault` metadata is loaded whenever the vault is present so If-Match is ready.
  // If `GET /vault` returns 404 (`vault_absent`, e.g. another tab reset the vault and broadcast `vault_changed { version: null }`),
  // `reloadVaultMeta()` resolves to `null`: refresh `Me` so `me.vault.status` transitions from stale `'present'` to `'absent'` (R1-11).
  useEffect(() => {
    if (!isVaultPresent || vault.vaultMeta !== null) return;
    void vault
      .reloadVaultMeta()
      .then((loaded) => {
        if (loaded === null) {
          void refetchMe().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [isVaultPresent, refetchMe, vault]);

  // Fetch detailed RK slot status only while the vault is unlocked AND `vaultMeta` carries a numeric
  // `recovery_keys_remaining` from the real OpenAPI `GET /vault` schema (F2: regenerating/rotating RK
  // requires an unlocked vault, and avoids hitting unmocked `/api/v1/vault/recovery-keys` while locked
  // or in Worker-only CSP harness tests whose mock `GET /vault` uses a legacy nested object).
  const hasOpenApiVaultMeta = typeof vault.vaultMeta?.recovery_keys_remaining === 'number';
  const rkStatusQuery = useQuery({
    queryKey: ['vault', 'recovery-keys-status', sessionEpoch, vault.vaultMeta?.version ?? 0],
    queryFn: () => fetchRecoveryKeysStatus(),
    enabled: Boolean(me && isVaultPresent && isVaultUnlocked && hasOpenApiVaultMeta),
    retry: false,
  });
  const remainingKeys =
    rkStatusQuery.data?.remaining ??
    vault.vaultMeta?.recovery_keys_remaining ??
    null;
  const totalSlots = rkStatusQuery.data?.slots ?? 10;
  const emptySlots = rkStatusQuery.data?.empty_slots ?? [];
  const emptySlotSet = new Set(emptySlots);
  const hasEmptySlots = Boolean(rkStatusQuery.data && emptySlots.length > 0);
  const passkeysCount = vault.vaultMeta?.passkeys.length ?? 0;

  const handleStatusChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['vault', 'recovery-keys-status'] });
  }, [queryClient]);

  const emptyRangeLabel = formatSlotRange(emptySlots);

  return (
    <div data-testid="vault-security-section">
      {/* Status explanation banner when vault is absent, locked, or inFlight */}
      {!isVaultPresent && (
        <div
          className="card mb-3 p-4"
          role="region"
          aria-label={t('stateBanner.absentTitle')}
          data-testid="vault-security-absent-banner"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-[220px]">
              <div className="mb-1 text-[14px] font-semibold text-body">
                {t('stateBanner.absentTitle')}
              </div>
              <p className="m-0 text-[13px] text-muted">{t('stateBanner.absentBody')}</p>
            </div>
            <Link href="/app/onboarding" className="btn btn-primary btn-sm ml-auto no-underline">
              {t('stateBanner.absentCta')}
            </Link>
          </div>
        </div>
      )}

      {isVaultPresent && !isVaultUnlocked && (
        <div
          className="card mb-3 p-4"
          role="region"
          aria-label={t('stateBanner.lockedTitle')}
          data-testid="vault-security-locked-banner"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-[220px]">
              <div className="mb-1 text-[14px] font-semibold text-body">
                {t('stateBanner.lockedTitle')}
              </div>
              <p className="m-0 text-[13px] text-muted">{t('stateBanner.lockedBody')}</p>
            </div>
            <Link
              href="/app/unlock?returnTo=%2Fapp%2Fsettings"
              className="btn btn-secondary btn-sm ml-auto no-underline"
            >
              {t('stateBanner.lockedCta')}
            </Link>
          </div>
        </div>
      )}

      {vault.inFlight && (
        <AuthStatus tone="loading" className="mb-3">
          {t('stateBanner.inFlightBody')}
        </AuthStatus>
      )}

      {/* 1. Change Passphrase Card */}
      <div className="card mb-3 p-5" data-testid="vault-passphrase-card">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 basis-[240px]">
            <div className="mb-1 text-[15px] font-semibold text-body">
              {t('passphrase.cardTitle')}
            </div>
            <p className="m-0 text-[13px] text-muted">{t('passphrase.cardBody')}</p>
          </div>
          <Button
            type="button"
            variant="tertiary"
            className="ml-auto"
            disabled={requiresUnlockedDisabled}
            data-open-dialog="passDlg"
            onClick={() => setPassDialogOpen(true)}
          >
            {t('passphrase.openButton')}
          </Button>
        </div>
      </div>

      {/* 2. Recovery Keys Card */}
      <div className="card mb-3 p-5" data-testid="vault-recovery-keys-card">
        <div className="mb-4 flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 basis-[240px]">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-body">
                {t('recoveryKeys.cardTitle')}
              </span>
              {remainingKeys !== null ? (
                <span
                  className="chip !font-mono text-[12px]"
                  data-testid="recovery-keys-remaining-badge"
                >
                  {t('recoveryKeys.remainingBadge', {
                    remaining: remainingKeys,
                    slots: totalSlots,
                  })}
                </span>
              ) : (
                <span
                  className="chip !font-mono text-[12px] text-muted"
                  data-testid="recovery-keys-remaining-badge"
                >
                  {rkStatusQuery.isError
                    ? t('recoveryKeys.statusUnavailable')
                    : t('recoveryKeys.statusLoading')}
                </span>
              )}
            </div>
            <p className="m-0 text-[13px] text-muted">{t('recoveryKeys.cardBody')}</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              type="button"
              variant="tertiary"
              disabled={requiresUnlockedDisabled || !hasEmptySlots}
              data-open-dialog="rkDlg"
              onClick={() => setRkDialogMode('regenerate')}
            >
              {t('recoveryKeys.regenerateButton')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={requiresUnlockedDisabled}
              data-open-dialog="rotateDlg"
              onClick={() => setRkDialogMode('rotate')}
            >
              {t('recoveryKeys.rotateButton')}
            </Button>
          </div>
        </div>

        {/* 10 slot status chips (metadata only — never renders stored RK secrets) */}
        {rkStatusQuery.isError ? (
          <div
            className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-surface p-3 text-[13px] text-muted"
            role="status"
            data-testid="recovery-keys-status-error"
          >
            <span>{t('recoveryKeys.statusErrorBody')}</span>
            <Button
              type="button"
              variant="tertiary"
              size="sm"
              className="ml-auto"
              onClick={() => void rkStatusQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : rkStatusQuery.data ? (
          <>
            <div
              className="mb-3 flex flex-wrap gap-1.5"
              role="list"
              aria-label={t('recoveryKeys.cardTitle')}
              data-testid="recovery-keys-slot-chips"
            >
              {ALL_SLOTS.map((slot) => {
                const isEmpty = emptySlotSet.has(slot);
                return (
                  <span
                    key={slot}
                    role="listitem"
                    data-slot={slot}
                    data-slot-empty={isEmpty ? 'true' : 'false'}
                    className="chip !font-mono"
                    style={
                      isEmpty
                        ? { borderStyle: 'dashed', color: 'var(--muted)' }
                        : undefined
                    }
                  >
                    {isEmpty
                      ? t('recoveryKeys.slotChipEmpty', { slot })
                      : t('recoveryKeys.slotChipActive', { slot })}
                  </span>
                );
              })}
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-muted">
              <span>
                {hasEmptySlots
                  ? t('recoveryKeys.summaryWithEmpty', {
                      remaining: remainingKeys ?? 0,
                      slots: totalSlots,
                      emptyCount: emptySlots.length,
                      slotRange: emptyRangeLabel,
                    })
                  : t('recoveryKeys.summaryFull')}
              </span>
            </div>
          </>
        ) : (
          <div
            className="mb-3 text-[13px] text-muted"
            data-testid="recovery-keys-status-pending"
          >
            {isVaultUnlocked
              ? t('recoveryKeys.statusLoading')
              : remainingKeys !== null
                ? t('recoveryKeys.remainingBadge', {
                    remaining: remainingKeys,
                    slots: totalSlots,
                  })
                : t('recoveryKeys.statusLockedHint')}
          </div>
        )}

        <div className="rounded-md bg-surface p-3 text-[12px] text-muted">
          {t('recoveryKeys.noViewNotice')}
        </div>
      </div>

      {/* 3. Reset Vault Card (danger card) */}
      <div
        className="card mb-3 border-error p-5"
        style={{ borderColor: 'var(--error)' }}
        data-testid="vault-reset-card"
      >
        <div className="mb-1 text-[15px] font-semibold text-body">
          {t('reset.cardTitle')}
        </div>
        <p className="mb-4 text-[13px] text-muted">
          {t('reset.cardBody', { remaining: remainingKeys ?? 0 })}
        </p>
        <Button
          type="button"
          variant="danger"
          disabled={resetDisabled}
          data-open-dialog="resetDlg"
          onClick={() => setResetDialogOpen(true)}
        >
          {t('reset.openButton')}
        </Button>
      </div>

      {toastMessage && (
        <Toast
          message={toastMessage}
          action={{
            label: t('common.close'),
            onAction: () => setToastMessage(null),
          }}
        />
      )}

      <ChangePassphraseDialog
        open={passDialogOpen}
        onOpenChange={setPassDialogOpen}
        vaultMeta={vault.vaultMeta}
        remainingRecoveryKeys={remainingKeys ?? 0}
        passkeysCount={passkeysCount}
        onSuccessToast={setToastMessage}
        onOpenSignOutOthers={onOpenRevokeSessionsDialog}
      />

      <RecoveryKeysDialog
        mode={rkDialogMode}
        onClose={() => setRkDialogMode(null)}
        vaultMeta={vault.vaultMeta}
        emptySlots={emptySlots}
        remainingRecoveryKeys={remainingKeys ?? 0}
        onSuccessToast={setToastMessage}
        onStatusChanged={handleStatusChanged}
      />

      <ResetVaultDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        vaultMeta={vault.vaultMeta}
        remainingRecoveryKeys={remainingKeys ?? 0}
        passkeysCount={passkeysCount}
        canChangePassphraseNow={!requiresUnlockedDisabled}
        onSwitchToChangePassphrase={() => setPassDialogOpen(true)}
        onSuccessToast={setToastMessage}
      />
    </div>
  );
}
