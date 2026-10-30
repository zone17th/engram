'use client';

/**
 * Browser-test-only React consumer of the vault (VS-R7-1 / BE3-4).
 *
 * Mounted by `VaultProvider` through `window.__engramMountVaultTestConsumer` under the SAME gate as
 * `window.__engramVaultTestBridge` (non-production build or loopback host) and rendered into the provider's own
 * React tree, so it consumes the vault exactly like a production page does:
 * - gates every decrypted surface on `useVault().state === 'unlocked'` (never on a ref/bridge getter),
 * - reads decrypted entry bodies from the TanStack Query cache namespace `vaultBodyQueryKey(entryId)`,
 * - holds display recovery keys in local React state wiped through `registerSecretFormReset`, and renders them
 *   through the real untagged `RecoveryKeysSheet` (no `data-vault-*` attribute for the DOM sweep to find).
 * It deliberately has NO manual DOM wiping, so a hidden surface proves the provider's synchronous
 * subscription/flush contract. A large subscriber tree makes the render "heavy".
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RecoveryKeysSheet } from '@/features/vault/onboarding/recovery-keys-sheet';
import { useVault, vaultBodyQueryKey } from '@/features/vault/vault-provider';

export interface VaultTestConsumerApi {
  setRecoveryKeys: (keys: ReadonlyArray<{ slot: number; display: string }>) => void;
}

export interface VaultTestConsumerProps {
  entryId: string;
  rowCount: number;
  onReady: (api: VaultTestConsumerApi) => void;
}

const SHEET_LABELS = {
  gridLabel: 'Recovery keys',
  slotLabel: (slot: number) => `Key ${slot}`,
  downloadTxt: 'Download',
  print: 'Print',
  copyAll: 'Copy',
  downloadedStatus: 'Downloaded',
  printedStatus: 'Printed',
  copiedStatus: 'Copied',
  confirmSavedLabel: 'I saved these keys',
};

function useCachedBody(entryId: string): string | undefined {
  const queryClient = useQueryClient();
  const [, bump] = useState(0);
  useEffect(
    () => queryClient.getQueryCache().subscribe(() => bump((n) => n + 1)),
    [queryClient],
  );
  return queryClient.getQueryData<string>(vaultBodyQueryKey(entryId));
}

function HeavyRow({ index, body }: { index: number; body: string | undefined }) {
  const vault = useVault();
  return (
    <li data-testid="vs-r7-1-row">
      row-{index}
      {vault.state === 'unlocked' && body !== undefined ? ` ${body}` : ''}
    </li>
  );
}

export default function VaultTestConsumer({ entryId, rowCount, onReady }: VaultTestConsumerProps) {
  const vault = useVault();
  const body = useCachedBody(entryId);
  const [recoveryKeys, setRecoveryKeys] = useState<ReadonlyArray<{ slot: number; display: string }>>([]);
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const { registerSecretFormReset } = vault;

  useEffect(() => registerSecretFormReset(() => setRecoveryKeys([])), [registerSecretFormReset]);
  useEffect(() => {
    onReady({ setRecoveryKeys });
    // `onReady` is a one-shot notification from the mount call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlocked = vault.state === 'unlocked';
  return (
    <section data-testid="vs-r7-1-consumer" data-vault-state={vault.state}>
      {unlocked && body !== undefined ? <p data-testid="vs-r7-1-body">{body}</p> : <p data-testid="vs-r7-1-locked">Locked</p>}
      {unlocked && recoveryKeys.length > 0 ? (
        <RecoveryKeysSheet
          keys={recoveryKeys}
          confirmedSaved={confirmedSaved}
          onConfirmedSavedChange={setConfirmedSaved}
          labels={SHEET_LABELS}
        />
      ) : null}
      <ul>
        {Array.from({ length: rowCount }, (_, i) => (
          <HeavyRow key={i} index={i} body={body} />
        ))}
      </ul>
    </section>
  );
}
