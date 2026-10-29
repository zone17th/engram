/**
 * Cross-tab BroadcastChannel('sabk.vault') + localStorage notification helper (ADR 0003 §8).
 * Separate from the auth session channel in `lib/auth/broadcast.ts`.
 * Note: BroadcastChannel and localStorage are fast wake-up notifications only;
 * the authoritative `lockEpoch` store is IndexedDB `sabk.device` under Web Lock `sabk.vault.lock`.
 */

export const VAULT_BROADCAST_CHANNEL = 'sabk.vault' as const;
export const VAULT_LOCK_EPOCH_STORAGE_KEY = 'sabk.vault.lockEpoch' as const;

export type VaultBroadcastMessage =
  | { type: 'activity'; at: number }
  | { type: 'lock'; lockEpoch: number }
  | { type: 'vault_changed'; vault_key_id: string; version: number | null }
  | { type: 'settings_changed'; auto_lock_minutes: number };

export type VaultBroadcastOrigin = 'local' | 'remote';

export type VaultBroadcastHandler = (
  message: VaultBroadcastMessage,
  origin: VaultBroadcastOrigin,
) => void;

let sharedChannel: BroadcastChannel | null = null;
const subscribers = new Set<VaultBroadcastHandler>();

function isValidVaultBroadcastMessage(data: unknown): data is VaultBroadcastMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  switch (msg.type) {
    case 'activity':
      return typeof msg.at === 'number' && Number.isFinite(msg.at);
    case 'lock':
      return typeof msg.lockEpoch === 'number' && Number.isSafeInteger(msg.lockEpoch) && msg.lockEpoch >= 0;
    case 'vault_changed':
      return (
        typeof msg.vault_key_id === 'string' &&
        (typeof msg.version === 'number' || msg.version === null)
      );
    case 'settings_changed':
      return typeof msg.auto_lock_minutes === 'number' && Number.isFinite(msg.auto_lock_minutes);
    default:
      return false;
  }
}

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!sharedChannel) {
    try {
      sharedChannel = new BroadcastChannel(VAULT_BROADCAST_CHANNEL);
    } catch {
      return null;
    }
  }
  return sharedChannel;
}

export function postVaultBroadcast(message: VaultBroadcastMessage): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber(message, 'local');
    } catch {
      // Subscriber errors must not prevent broadcast delivery
    }
  }
  try {
    getChannel()?.postMessage(message);
  } catch {
    // Ignore BroadcastChannel post errors
  }
  if (message.type === 'lock') {
    notifyLockEpochViaLocalStorage(message.lockEpoch);
  }
}

export function notifyLockEpochViaLocalStorage(lockEpoch: number): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(VAULT_LOCK_EPOCH_STORAGE_KEY, String(lockEpoch));
    }
  } catch {
    // Ignore storage quota or private mode errors (ADR 0003 §8.3)
  }
}

export function subscribeVaultBroadcast(handler: VaultBroadcastHandler): () => void {
  subscribers.add(handler);
  const ch = getChannel();

  const messageListener = (event: MessageEvent<unknown>) => {
    if (isValidVaultBroadcastMessage(event?.data)) {
      handler(event.data, 'remote');
    }
  };

  const storageListener = (event: StorageEvent) => {
    if (event.key !== VAULT_LOCK_EPOCH_STORAGE_KEY || event.newValue == null) return;
    const parsed = Number(event.newValue);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      handler({ type: 'lock', lockEpoch: parsed }, 'remote');
    }
  };

  ch?.addEventListener('message', messageListener);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', storageListener);
  }

  return () => {
    subscribers.delete(handler);
    ch?.removeEventListener('message', messageListener);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('storage', storageListener);
    }
  };
}

/** Resets the cached BroadcastChannel instance (used in unit tests when stubbing BroadcastChannel). */
export function resetVaultBroadcastForTests(): void {
  try {
    sharedChannel?.close();
  } catch {
    // Ignore
  }
  sharedChannel = null;
  subscribers.clear();
}
