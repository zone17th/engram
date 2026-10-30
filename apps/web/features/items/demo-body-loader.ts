import { DEMO_ITEMS } from '@/lib/demo-fixtures';
import type { EntryBodyLoader } from '@/features/items/entry-body';

/**
 * Body loader of the P03 preview pages: the public, made-up demo text (`lib/demo-fixtures.ts`, P01-A5), delivered the
 * way a real body will be: asynchronously, into the vault-gated query cache, only while the vault is unlocked.
 * P04 replaces this with the real entry fetch + `client.openEntry`; the pages then change one import.
 */
export const loadDemoEntryBody: EntryBodyLoader = async (entryId) => {
  const item = DEMO_ITEMS.find((candidate) => candidate.id === entryId);
  if (!item) throw new Error('entry_not_found');
  return item.preview;
};
