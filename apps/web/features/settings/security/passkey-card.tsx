'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import {
  GRANT_MIN_REMAINING_MS,
  PASSKEY_NAME_MAX_RUNES,
  PasskeyAddEntry,
  createRevokeTracker,
  grantHasMargin,
  revokePasskeyIdempotent,
  validatePasskeyName,
  type PasskeyNameRejection,
} from '@/features/vault/passkey';
import { useOptionalVault } from '@/features/vault/vault-provider';
import type { ReauthAction, ReauthGrant } from '@/lib/api/auth';
import { fetchPasskeysList, renamePasskey, type VaultPasskeyItem } from '@/lib/api/vault';

const SETTINGS_PATH = '/app/settings';
const REVOKE_ACTION: ReauthAction = 'vault.passkey_revoke';

function formatPasskeyDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function nameErrorKey(reason: PasskeyNameRejection): string {
  switch (reason) {
    case 'empty':
      return 'register.name.empty';
    case 'too_long':
      return 'register.name.too_long';
    default:
      return 'register.name.forbidden_chars';
  }
}

function hasUsableRevokeGrant(
  reauth: {
    grant?: ReauthGrant | null;
    hasUsableGrant?: (action: ReauthAction) => boolean;
  } | null | undefined,
): string | null {
  if (!reauth) return null;
  if (reauth.grant && reauth.grant.action === REVOKE_ACTION && grantHasMargin(reauth.grant, Date.now())) {
    return reauth.grant.grant;
  }
  if (
    typeof reauth.hasUsableGrant === 'function' &&
    reauth.hasUsableGrant(REVOKE_ACTION) &&
    reauth.grant?.grant
  ) {
    if (!reauth.grant.expires_at) return reauth.grant.grant;
    const exp = Date.parse(reauth.grant.expires_at);
    if (Number.isFinite(exp) && exp - Date.now() >= GRANT_MIN_REMAINING_MS) {
      return reauth.grant.grant;
    }
  }
  return null;
}

export interface PasskeySecurityCardProps {
  /** Optional custom sleep injected by unit tests to avoid waiting on the 1s revoke retry delay. */
  revokeSleep?: (ms: number) => Promise<void>;
}

/**
 * Settings passkey card (`mockups/settings.html` "passkey", SPEC §7 U7, plan Task 20 20B):
 * lists registered passkeys via `fetchPasskeysList`, adds via `PasskeyAddEntry`, renames via
 * `renamePasskey` + `validatePasskeyName`, and revokes via `revokePasskeyIdempotent` + `createRevokeTracker`
 * with a `vault.passkey_revoke` grant. Shown while the vault is unlocked.
 */
export function PasskeySecurityCard({ revokeSleep }: PasskeySecurityCardProps = {}) {
  const vault = useOptionalVault();
  if (!vault || vault.workerState !== 'unlocked') return null;
  return (
    <PasskeySecurityCardInner
      reloadVaultMeta={vault.reloadVaultMeta}
      registerSecretFormReset={vault.registerSecretFormReset}
      initialPasskeys={vault.vaultMeta?.passkeys}
      revokeSleep={revokeSleep}
    />
  );
}

interface PasskeySecurityCardInnerProps {
  reloadVaultMeta: () => Promise<unknown>;
  registerSecretFormReset?: (resetFn: () => void) => () => void;
  initialPasskeys?: VaultPasskeyItem[];
  revokeSleep?: (ms: number) => Promise<void>;
}

function PasskeySecurityCardInner({
  reloadVaultMeta,
  registerSecretFormReset,
  initialPasskeys,
  revokeSleep,
}: PasskeySecurityCardInnerProps) {
  const t = useTranslations('vault.passkey');
  const tb = useTranslations('vault.b.settings.passkeys');
  const tAuth = useTranslations('auth');
  const locale = useLocale();
  const session = useSession();
  const reauth = session?.reauth;

  const [items, setItems] = useState<VaultPasskeyItem[]>(() => initialPasskeys ?? []);
  const itemsRef = useRef<VaultPasskeyItem[]>(items);
  itemsRef.current = items;
  const [loading, setLoading] = useState<boolean>(() => initialPasskeys === undefined);
  const [loadError, setLoadError] = useState(false);
  const loadSeqRef = useRef(0);
  const cardHeadingRef = useRef<HTMLDivElement>(null);
  const [added, setAdded] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePendingId, setRenamePendingId] = useState<string | null>(null);

  // Revoke state
  const revokeTrackerRef = useRef<Set<string> | null>(null);
  if (!revokeTrackerRef.current) {
    revokeTrackerRef.current = createRevokeTracker();
  }
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeDialogTarget, setRevokeDialogTarget] = useState<VaultPasskeyItem | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!registerSecretFormReset) return;
    return registerSecretFormReset(() => {
      setReauthPassword('');
    });
  }, [registerSecretFormReset]);

  const loadPasskeys = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoadError(false);
    setLoading(true);
    try {
      const response = await fetchPasskeysList();
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (response && Array.isArray(response.items)) {
        setItems(response.items);
      }
    } catch {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      if (itemsRef.current.length === 0) {
        setLoadError(true);
      } else {
        setStatusMessage(tb('loadError'));
      }
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [tb]);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  const refreshListAndVaultMeta = useCallback(async () => {
    await Promise.all([
      loadPasskeys(),
      Promise.resolve(reloadVaultMeta()).catch(() => undefined),
    ]);
  }, [loadPasskeys, reloadVaultMeta]);

  const startRename = (item: VaultPasskeyItem) => {
    setActionError(null);
    setStatusMessage(null);
    setRenameError(null);
    setEditingId(item.id);
    setEditingValue(item.name);
  };

  const focusRenameButton = useCallback((id: string) => {
    queueMicrotask(() => {
      const btn = document.querySelector<HTMLElement>(`[data-testid="settings-passkey-rename-${id}"]`);
      btn?.focus();
    });
  }, []);

  const cancelRename = () => {
    if (renamePendingId) return;
    const prevId = editingId;
    setEditingId(null);
    setEditingValue('');
    setRenameError(null);
    if (prevId) focusRenameButton(prevId);
  };

  const submitRename = async (item: VaultPasskeyItem) => {
    if (renamePendingId) return;
    setRenameError(null);
    setActionError(null);
    setStatusMessage(null);

    const validated = validatePasskeyName(editingValue);
    if (!validated.ok) {
      setRenameError(t(nameErrorKey(validated.reason)));
      return;
    }

    setRenamePendingId(item.id);
    try {
      const updated = await renamePasskey(item.id, { name: validated.name });
      if (!mountedRef.current) return;
      setItems((prev) =>
        prev.map((entry) => (entry.id === item.id ? { ...entry, ...updated, name: validated.name } : entry)),
      );
      setEditingId(null);
      setEditingValue('');
      setStatusMessage(tb('renamed'));
      focusRenameButton(item.id);
      await refreshListAndVaultMeta();
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ProblemError && err.problem.code === 'passkey_name_invalid') {
        setRenameError(t('register.name.forbidden_chars'));
      } else if (err instanceof ProblemError && err.problem.code === 'passkey_not_found') {
        setRenameError(tb('revokeNotFoundError'));
        void refreshListAndVaultMeta();
      } else {
        setRenameError(tb('renameFailed'));
      }
    } finally {
      if (mountedRef.current) {
        setRenamePendingId(null);
      }
    }
  };

  const executeRevokeWithToken = useCallback(
    async (item: VaultPasskeyItem, reauthToken: string) => {
      setActionError(null);
      setStatusMessage(null);
      setRevokingId(item.id);
      try {
        const outcome = await revokePasskeyIdempotent(
          {
            reloadList: async () => {
              await refreshListAndVaultMeta();
            },
            ...(revokeSleep ? { sleep: revokeSleep } : {}),
          },
          revokeTrackerRef.current!,
          item.id,
          reauthToken,
        );
        if (!mountedRef.current) return;
        if (outcome.status === 'not_found') {
          setActionError(tb('revokeNotFoundError'));
          return;
        }
        setItems((prev) => prev.filter((entry) => entry.id !== item.id));
        setStatusMessage(t('revoked'));
        queueMicrotask(() => {
          cardHeadingRef.current?.focus();
        });
      } catch (err) {
        if (!mountedRef.current) return;
        if (
          err instanceof ProblemError &&
          (err.problem.code === 'reauth_required' || err.problem.code === 'reauth_invalid')
        ) {
          reauth?.clearGrant?.();
          setRevokeDialogTarget(item);
          setReauthPassword('');
          setOauthError(null);
          void reauth?.begin?.(REVOKE_ACTION, SETTINGS_PATH).catch(() => undefined);
          return;
        }
        setActionError(tb('revokeFailed'));
      } finally {
        if (mountedRef.current) {
          setRevokingId(null);
        }
      }
    },
    [reauth, refreshListAndVaultMeta, revokeSleep, t, tb],
  );

  const handleRevokeClick = (item: VaultPasskeyItem) => {
    if (revokingId) return;
    setActionError(null);
    setStatusMessage(null);
    const usableToken = hasUsableRevokeGrant(reauth);
    if (usableToken) {
      void executeRevokeWithToken(item, usableToken);
      return;
    }
    setRevokeDialogTarget(item);
    setReauthPassword('');
    setOauthError(null);
    void reauth?.begin?.(REVOKE_ACTION, SETTINGS_PATH).catch(() => undefined);
  };

  const closeRevokeDialog = (nextOpen: boolean) => {
    if (!nextOpen) {
      if (revokingId) return;
      if (reauth?.pendingAction === REVOKE_ACTION) {
        reauth.cancel?.();
      }
      setReauthPassword('');
      setOauthPending(false);
      setOauthError(null);
      setRevokeDialogTarget(null);
    }
  };

  const handleConfirmRevokeDialog = async () => {
    if (!revokeDialogTarget || revokingId) return;
    const target = revokeDialogTarget;
    const existingToken = hasUsableRevokeGrant(reauth);
    if (existingToken) {
      setRevokeDialogTarget(null);
      await executeRevokeWithToken(target, existingToken);
      return;
    }

    const typed = reauthPassword;
    setReauthPassword('');
    setOauthError(null);
    if (!reauth?.submitPassword) return;
    try {
      const grantResult = await reauth.submitPassword(typed);
      const token = grantResult?.grant ?? reauth.grant?.grant;
      if (!token) return;
      setRevokeDialogTarget(null);
      await executeRevokeWithToken(target, token);
    } catch {
      /* reauth.error surfaces inside the dialog */
    }
  };

  const handleStartGoogleRevokeReauth = async () => {
    if (!reauth?.startOauthReauth || oauthPending || reauth.submitting) return;
    setOauthPending(true);
    setOauthError(null);
    try {
      await reauth.startOauthReauth('google', SETTINGS_PATH);
    } catch (err) {
      const detail = err instanceof ProblemError ? err.problem.detail ?? err.problem.title : null;
      setOauthError(detail || t('add.oauthStartFailed'));
    } finally {
      setOauthPending(false);
    }
  };

  const hasPassword = reauth?.capabilities?.hasPassword ?? true;
  const canUseGoogle = Boolean(reauth?.capabilities?.oauthReauthProviders?.includes('google'));
  const canEnrollPassword = Boolean(reauth?.capabilities?.passwordEnrollmentAvailable);
  const reauthBusy = Boolean(reauth?.submitting || oauthPending || revokingId);
  const dialogGrantReady = Boolean(hasUsableRevokeGrant(reauth));
  const dialogStatusError = reauth?.error ?? oauthError;

  return (
    <div className="card mb-3 p-5" data-testid="settings-passkey-card">
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div
            ref={cardHeadingRef}
            tabIndex={-1}
            className="mb-1 text-[15px] font-semibold text-body outline-none"
            data-testid="settings-passkey-heading"
          >
            {t('settings.title')}
          </div>
          <p className="m-0 text-[13px] text-muted">{t('settings.body')}</p>
        </div>
        <PasskeyAddEntry
          className="ml-auto"
          returnPath={SETTINGS_PATH}
          onRegistered={() => {
            setAdded(true);
            setStatusMessage(null);
            setActionError(null);
            void refreshListAndVaultMeta();
          }}
        />
      </div>

      {added && (
        <p role="status" className="m-0 mb-3 text-[13px] text-muted" data-testid="settings-passkey-added">
          {t('settings.added')}
        </p>
      )}

      {statusMessage && (
        <p role="status" className="m-0 mb-3 text-[13px] text-muted" data-testid="settings-passkey-status">
          {statusMessage}
        </p>
      )}

      {actionError && (
        <div className="mb-3" data-testid="settings-passkey-error">
          <AuthStatus tone="error">{actionError}</AuthStatus>
        </div>
      )}

      {loadError && items.length === 0 ? (
        <div
          className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-surface p-3 text-[13px] text-muted"
          role="alert"
          data-testid="settings-passkey-load-error"
        >
          <span>{tb('loadError')}</span>
          <Button
            type="button"
            variant="tertiary"
            size="sm"
            className="ml-auto"
            onClick={() => void loadPasskeys()}
          >
            {tb('retry')}
          </Button>
        </div>
      ) : loading && items.length === 0 ? (
        <p role="status" className="m-0 mb-3 text-[13px] text-muted" data-testid="settings-passkey-loading">
          {tb('loading')}
        </p>
      ) : items.length === 0 ? (
        <p className="m-0 mb-3 text-[13px] text-muted" data-testid="settings-passkey-empty">
          {t('none_registered')}
        </p>
      ) : (
        <ul
          className="m-0 mb-3 flex list-none flex-col gap-2 p-0"
          aria-label={tb('listAria')}
          data-testid="settings-passkey-list"
        >
          {items.map((item) => {
            const isEditing = editingId === item.id;
            const isRenaming = renamePendingId === item.id;
            const isRevoking = revokingId === item.id;

            return (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-3 rounded-md bg-surface p-3"
                data-testid={`settings-passkey-row-${item.id}`}
              >
                <span aria-hidden="true">🔑</span>
                {isEditing ? (
                  <div className="flex min-w-0 flex-1 basis-[220px] flex-col gap-2">
                    <Field
                      label={tb('renameInputLabel', { name: item.name })}
                      value={editingValue}
                      maxLength={PASSKEY_NAME_MAX_RUNES * 2}
                      autoComplete="off"
                      disabled={isRenaming}
                      onChange={(e) => {
                        setEditingValue(e.target.value);
                        if (renameError) setRenameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void submitRename(item);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      wrapperClassName="mb-0"
                      data-testid={`settings-passkey-rename-input-${item.id}`}
                    />
                    {renameError && (
                      <div role="alert" className="text-[12px] text-error" data-testid="settings-passkey-rename-error">
                        {renameError}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={isRenaming}
                        onClick={() => void submitRename(item)}
                        data-testid={`settings-passkey-rename-save-${item.id}`}
                      >
                        {isRenaming ? tb('renameSaving') : tb('renameSave')}
                      </Button>
                      <Button
                        type="button"
                        variant="tertiary"
                        size="sm"
                        disabled={isRenaming}
                        onClick={cancelRename}
                        data-testid={`settings-passkey-rename-cancel-${item.id}`}
                      >
                        {tb('renameCancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="min-w-0 flex-1 basis-[180px]">
                      <div
                        className="break-words text-[14px] font-semibold text-body"
                        data-testid={`settings-passkey-name-${item.id}`}
                      >
                        {item.name}
                      </div>
                      <div className="mono text-[12px] text-muted">
                        {tb('addedOn', { date: formatPasskeyDate(item.created_at, locale) })}
                      </div>
                    </div>
                    <span className="badge-type badge-text ml-auto">{tb('prfBadge')}</span>
                    <Button
                      type="button"
                      variant="tertiary"
                      size="sm"
                      disabled={Boolean(revokingId || renamePendingId)}
                      aria-label={tb('renameAria', { name: item.name })}
                      onClick={() => startRename(item)}
                      data-testid={`settings-passkey-rename-${item.id}`}
                    >
                      {tb('rename')}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      size="sm"
                      disabled={Boolean(revokingId || renamePendingId)}
                      aria-label={tb('revokeAria', { name: item.name })}
                      onClick={() => handleRevokeClick(item)}
                      data-testid={`settings-passkey-revoke-${item.id}`}
                    >
                      {isRevoking ? tb('revoking') : tb('revoke')}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-md bg-surface p-3 text-[12px] text-muted">
        <strong>{tb('revokeNoteStrong')}</strong> {tb('revokeNoteBody')}
      </div>

      {revokeDialogTarget && (
        <Dialog open={Boolean(revokeDialogTarget)} onOpenChange={closeRevokeDialog}>
          <DialogContent id="passkeyRevokeDlg">
            <div className="panel p-7" style={{ width: 'min(520px, 94vw)', maxHeight: '90vh', overflow: 'auto' }}>
              <DialogHeader
                title={tb('revokeDialogTitle')}
                description={tb('revokeDialogDescription', { name: revokeDialogTarget.name })}
              />

              {!dialogGrantReady && (
                <div className="my-5">
                  {hasPassword && (
                    <Field
                      label={tAuth('fields.password')}
                      type="password"
                      autoComplete="current-password"
                      value={reauthPassword}
                      onChange={(e) => setReauthPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleConfirmRevokeDialog();
                        }
                      }}
                      disabled={reauthBusy}
                      passwordToggleLabels={{ show: t('add.showPassword'), hide: t('add.hidePassword') }}
                      wrapperClassName="mb-3"
                      data-vault-secret="true"
                    />
                  )}
                  {!hasPassword && canEnrollPassword && (
                    <div className="mb-3">
                      <p className="mb-3 text-[13px] text-body">{tAuth('reauth.oauthOnlyHint')}</p>
                      <Link
                        href="/app/auth/password-enroll"
                        className="btn btn-secondary btn-sm no-underline"
                        onClick={() => closeRevokeDialog(false)}
                      >
                        {tAuth('reauth.enrollCta')}
                      </Link>
                    </div>
                  )}
                  {canUseGoogle && (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        className="mb-2 w-full !justify-center"
                        onClick={() => void handleStartGoogleRevokeReauth()}
                        disabled={reauthBusy}
                        aria-busy={oauthPending}
                      >
                        {oauthPending ? tAuth('reauth.submitting') : tAuth('reauth.google')}
                      </Button>
                      <p className="m-0 text-[12px] text-muted">{t('add.googleNote')}</p>
                    </>
                  )}
                  {!hasPassword && !canUseGoogle && !canEnrollPassword && (
                    <p role="status" className="m-0 text-[13px] text-muted">
                      {t('add.noReauthMethod')}
                    </p>
                  )}
                  {dialogStatusError && (
                    <AuthStatus tone="error" className="mt-3">
                      {dialogStatusError}
                    </AuthStatus>
                  )}
                </div>
              )}

              <DialogFooter className="mt-6">
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => closeRevokeDialog(false)}
                  disabled={Boolean(revokingId)}
                >
                  {tb('revokeCancel')}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => void handleConfirmRevokeDialog()}
                  disabled={reauthBusy || (!dialogGrantReady && (!hasPassword || reauthPassword.length === 0))}
                  aria-busy={reauthBusy}
                  data-testid="settings-passkey-revoke-confirm"
                >
                  {revokingId ? tb('revoking') : tb('revokeConfirm')}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
