/**
 * Generates `apps/web/e2e/fixtures/locked-item-entries.json` for the P03-T21 / P04-T15
 * locked item-page Playwright E2E specs (`vault-locked-item.spec.ts`, `vault-locked-visual-item.spec.ts`).
 *
 * Regeneration command (from repository root):
 *   pnpm -C apps/web exec tsx e2e/fixtures/gen-locked-item-entries.mts
 *
 * Uses `sealEntryPayload` from `lib/crypto/envelope.ts` (read-only import) and the
 * public P03 test-vector vault key (`packages/crypto-vectors/vectors/js-v1.json`,
 * `vault_key_id: "vk:7f3a9b2c4d5e6f7a8b9c0d"`). Prints nothing secret.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entry, EntryMeta, ItemSummary } from '../../lib/api/content';
import { decodeBase64UrlStrict } from '../../lib/crypto/b64url';
import { sealEntryPayload } from '../../lib/crypto/envelope';
import { getSodium } from '../../lib/crypto/sodium';
import { TEST_VECTOR_VAULT_KEY_ID } from '../vault-locked-support';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_PATH = resolve(__dirname, 'locked-item-entries.json');

// Public test-vector VK from `packages/crypto-vectors/vectors/js-v1.json` (`inputs.vk_b64u`).
const TEST_VECTOR_VK_B64U = 'EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-11-01T00:00:00Z';

interface FixtureEntrySeed {
  readonly id: string;
  readonly type: 'text' | 'json';
  readonly position: number;
  readonly version: number;
  readonly plaintext: string;
}

const ENTRY_SEEDS: readonly FixtureEntrySeed[] = [
  {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    type: 'text',
    position: 0,
    version: 1,
    plaintext: 'wifi-office: WPA2-Enterprise secret_key_2026!',
  },
  {
    id: '8b4e2a10-9c3d-4e5f-a1b2-c3d4e5f60718',
    type: 'json',
    position: 1,
    version: 1,
    plaintext: '{"service":"postgres-prod","port":5432,"big_id":9007199254740993,"tags":["db","primary"]}',
  },
];

export interface LockedItemEntriesFixture {
  readonly item: ItemSummary;
  readonly entries: ReadonlyArray<{
    readonly meta: EntryMeta;
    readonly entry: Entry;
    readonly plaintext: string;
  }>;
}

async function main(): Promise<void> {
  const sodium = await getSodium();
  const vk = decodeBase64UrlStrict(TEST_VECTOR_VK_B64U, 32);
  const encoder = new TextEncoder();

  const entries = ENTRY_SEEDS.map((seed) => {
    const byteLen = encoder.encode(seed.plaintext).byteLength;
    const bucket = Math.max(256, Math.ceil(byteLen / 256) * 256);
    const sealed = sealEntryPayload(sodium, {
      entryId: seed.id,
      keyId: TEST_VECTOR_VAULT_KEY_ID,
      plaintext: seed.plaintext,
      vk,
    });

    const meta: EntryMeta = {
      id: seed.id,
      item_id: ITEM_ID,
      type: seed.type,
      position: seed.position,
      version: seed.version,
      plaintext_len_bucket: bucket,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    };

    const entry: Entry = {
      ...meta,
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    };

    return {
      meta,
      entry,
      plaintext: seed.plaintext,
    };
  });

  const item: ItemSummary = {
    id: ITEM_ID,
    name: 'Cà phê sữa đá tỉ lệ 1:2',
    hint: 'mẫu công khai cho trang mục đã khoá',
    tags: [
      { id: 'aaaa1111-1111-4111-8111-111111111111', display: 'công-thức' },
      { id: 'bbbb2222-2222-4222-8222-222222222222', display: 'ghi-chú' },
    ],
    entry_count: entries.length,
    version: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    last_used_at: CREATED_AT,
  };

  const fixture: LockedItemEntriesFixture = {
    item,
    entries,
  };

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

await main();
