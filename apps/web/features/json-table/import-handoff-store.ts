/**
 * In-memory handoff store for the Omnibox "JSON detected — Save as table" action
 * (`advisor-dec-209`, `user-dec-016`, `mockups/index.html` `#omnibox-json-banner`, `mockups/item.html` U14).
 *
 * SECURITY & PRIVACY INVARIANTS:
 * - Held ONLY in tab memory (never in a URL query string, route state, `history.state`,
 *   `localStorage`, `sessionStorage`, IndexedDB, `QueryCache`, or a log).
 * - Plaintext `body` is stored in a resettable mutable holder (`bodyHolder.text`) so wiping on
 *   lock, logout, user switch, or dialog close overwrites the holder in place even if a stale
 *   reference exists.
 * - Captures `lockEpoch` and `userId` at handoff time so if the vault locks or the user changes
 *   between clicking "Save as table" and the Import JSON dialog mounting, the handoff is
 *   immediately rejected and wiped.
 */

export interface JsonImportHandoffInput {
  readonly name: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly userId: string | null;
  readonly lockEpoch?: number;
  readonly itemId?: string;
  readonly isCurrentItem?: boolean;
  readonly entryCount?: number;
  readonly onSavedEntry?: (params: {
    readonly itemId: string;
    readonly itemName: string;
    readonly entryId: string;
  }) => void;
  readonly onRestoreFocus?: () => void;
}

export interface JsonImportHandoffRecord {
  readonly id: number;
  readonly name: string;
  readonly tags: readonly string[];
  readonly bodyHolder: { text: string };
  readonly userId: string | null;
  readonly lockEpoch: number;
  readonly itemId?: string;
  readonly isCurrentItem: boolean;
  readonly entryCount?: number;
  readonly onSavedEntry?: (params: {
    readonly itemId: string;
    readonly itemName: string;
    readonly entryId: string;
  }) => void;
  readonly onRestoreFocus?: () => void;
}

type Listener = () => void;

let currentHandoff: JsonImportHandoffRecord | null = null;
let currentLockEpoch = 0;
let nextHandoffId = 0;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getJsonImportHandoffLockEpoch(): number {
  return currentLockEpoch;
}

export function openJsonImportFromHandoff(input: JsonImportHandoffInput): number {
  if (currentHandoff) {
    currentHandoff.bodyHolder.text = '';
  }
  nextHandoffId += 1;
  const id = nextHandoffId;
  const bodyHolder = { text: input.body };
  currentHandoff = {
    id,
    name: input.name,
    tags: [...input.tags],
    bodyHolder,
    userId: input.userId,
    lockEpoch: input.lockEpoch ?? currentLockEpoch,
    ...(input.itemId !== undefined ? { itemId: input.itemId } : {}),
    isCurrentItem: input.isCurrentItem ?? false,
    ...(input.entryCount !== undefined ? { entryCount: input.entryCount } : {}),
    ...(input.onSavedEntry ? { onSavedEntry: input.onSavedEntry } : {}),
    ...(input.onRestoreFocus ? { onRestoreFocus: input.onRestoreFocus } : {}),
  };
  emitChange();
  return id;
}

export function wipeJsonImportHandoff(options?: { readonly bumpLockEpoch?: boolean }): void {
  if (options?.bumpLockEpoch) {
    currentLockEpoch += 1;
  }
  if (!currentHandoff) {
    return;
  }
  currentHandoff.bodyHolder.text = '';
  currentHandoff = null;
  emitChange();
}

export function reconcileJsonImportHandoffUser(
  activeUserId: string | null | undefined,
): void {
  if (!currentHandoff) {
    return;
  }
  if (
    currentHandoff.userId !== null &&
    activeUserId !== undefined &&
    activeUserId !== currentHandoff.userId
  ) {
    wipeJsonImportHandoff({ bumpLockEpoch: true });
  }
}

export function getJsonImportHandoffSnapshot(): JsonImportHandoffRecord | null {
  if (!currentHandoff) {
    return null;
  }
  if (currentHandoff.lockEpoch !== currentLockEpoch) {
    currentHandoff.bodyHolder.text = '';
    currentHandoff = null;
    return null;
  }
  return currentHandoff;
}

export function subscribeJsonImportHandoff(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
