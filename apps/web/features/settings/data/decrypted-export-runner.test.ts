import { ProblemError } from '@engram/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_STATUS, type DecryptedExportPage, type ExportJob } from '@/lib/api/export';
import {
  DecryptedExportError,
  FALLBACK_MAX_ESCAPED_BYTES,
  runDecryptedExport,
  type ShowSaveFilePickerFn,
  type WritableFileStreamLike,
} from './decrypted-export-runner';

const TEST_VAULT_KEY_ID = 'vk:AAECAwQFBgcICQoLDA0ODw';
const TEST_JOB_ID = '11111111-2222-4333-8444-555555555555';

function makeReadyJob(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: TEST_JOB_ID,
    kind: 'encrypted',
    status: EXPORT_STATUS.ready,
    created_at: '2026-11-08T10:00:00Z',
    completed_at: '2026-11-08T10:01:00Z',
    expires_at: '2026-11-09T10:01:00Z',
    size_bytes: 1024,
    items_total: 2,
    items_processed: 2,
    ...overrides,
  };
}

function makeReauthError(code: 'reauth_required' | 'reauth_invalid' = 'reauth_required') {
  return new ProblemError({
    type: `https://engram.zone17.click/problems/${code}`,
    title: code,
    status: 401,
    code,
  });
}

describe('features/settings/data/decrypted-export-runner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses a ready source job <= 10 minutes old without calling createExport, preserves raw JSON string (9007199254740993, dup keys, -0), and calls postDecryptedAudit only at end', async () => {
    const nowMs = Date.parse('2026-11-08T10:05:00Z'); // 4 minutes after completed_at
    const readyJob = makeReadyJob();
    const createExportMock = vi.fn();
    const getLatestExportMock = vi.fn().mockResolvedValue({ job: readyJob });
    const postDecryptedAuditMock = vi.fn().mockResolvedValue(undefined);

    const rawJsonBody = '{"big":9007199254740993,"dup":1,"dup":2,"negZero":-0}';
    const rawTextBody = 'wifi-office: WPA2-Enterprise secret_key_2026!';

    const pages: DecryptedExportPage[] = [
      {
        source_export_id: TEST_JOB_ID,
        vault_key_id: TEST_VAULT_KEY_ID,
        total_entries: 2,
        section: 'tags',
        items: [
          {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            display: 'wifi-khách',
            item_count: 1,
            last_used_at: '2026-11-01T00:00:00Z',
            created_at: '2026-10-01T00:00:00Z',
          },
        ],
        next_cursor: 'cur-items',
      },
      {
        source_export_id: TEST_JOB_ID,
        vault_key_id: TEST_VAULT_KEY_ID,
        total_entries: 2,
        section: 'items',
        items: [
          {
            id: '22222222-3333-4444-8555-666666666666',
            name: 'wifi',
            hint: 'Tầng 2',
            entry_count: 2,
            version: 1,
            last_used_at: '2026-11-05T12:00:00Z',
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-11-05T12:00:00Z',
          },
        ],
        next_cursor: 'cur-item-tags',
      },
      {
        source_export_id: TEST_JOB_ID,
        vault_key_id: TEST_VAULT_KEY_ID,
        total_entries: 2,
        section: 'item_tags',
        items: [
          {
            item_id: '22222222-3333-4444-8555-666666666666',
            tag_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            created_at: '2026-10-01T00:00:00Z',
          },
        ],
        next_cursor: 'cur-entries',
      },
      {
        source_export_id: TEST_JOB_ID,
        vault_key_id: TEST_VAULT_KEY_ID,
        total_entries: 2,
        section: 'entries',
        items: [
          {
            id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
            item_id: '22222222-3333-4444-8555-666666666666',
            type: 'text',
            position: 0,
            version: 1,
            plaintext_len_bucket: 256,
            envelope: {
              v: 1,
              alg: 'xchacha20poly1305-ietf',
              key_id: TEST_VAULT_KEY_ID,
              nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
              ct_enc: 'utf8',
            },
            ciphertext: 'ct-text',
            created_at: '2026-10-01T00:05:00Z',
            updated_at: '2026-10-01T00:05:00Z',
          },
          {
            id: '8b4e2a10-9c3d-4e5f-a1b2-c3d4e5f60718',
            item_id: '22222222-3333-4444-8555-666666666666',
            type: 'json',
            position: 1,
            version: 1,
            plaintext_len_bucket: 256,
            envelope: {
              v: 1,
              alg: 'xchacha20poly1305-ietf',
              key_id: TEST_VAULT_KEY_ID,
              nonce: 'ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4',
              ct_enc: 'utf8',
            },
            ciphertext: 'ct-json',
            created_at: '2026-10-01T00:06:00Z',
            updated_at: '2026-10-01T00:06:00Z',
          },
        ],
        next_cursor: null,
      },
    ];

    let pageIdx = 0;
    const getDecryptedPageMock = vi.fn().mockImplementation(async () => pages[pageIdx++]!);

    let downloadedBlob: Blob | null = null;
    let downloadedFilename = '';

    const res = await runDecryptedExport({
      getVaultState: () => 'unlocked',
      getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
      openEntry: async ({ entryId }) => ({
        entryId,
        envelope: {
          v: 1,
          alg: 'xchacha20poly1305-ietf',
          key_id: TEST_VAULT_KEY_ID,
          nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
          ct_enc: 'utf8',
        },
        plaintext:
          entryId === '8b4e2a10-9c3d-4e5f-a1b2-c3d4e5f60718' ? rawJsonBody : rawTextBody,
      }),
      opGeneration: 1,
      reauthToken: 'grant-ok',
      deps: {
        now: () => nowMs,
        getLatestExport: getLatestExportMock,
        createExport: createExportMock,
        getDecryptedPage: getDecryptedPageMock,
        postDecryptedAudit: postDecryptedAuditMock,
        showSaveFilePicker: null,
        onTriggerBlobDownload: (blob, filename) => {
          downloadedBlob = blob;
          downloadedFilename = filename;
        },
      },
    });

    expect(createExportMock).not.toHaveBeenCalled();
    expect(postDecryptedAuditMock).toHaveBeenCalledTimes(1);
    expect(res.filename).toBe('engram-readable-2026-11-08.json');
    expect(downloadedFilename).toBe('engram-readable-2026-11-08.json');
    expect(downloadedBlob).not.toBeNull();

    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloadedBlob!);
    });
    const parsed = JSON.parse(text) as {
      format: string;
      version: number;
      vault_key_id: string;
      snapshot: {
        source_export_id: string;
        includes_active: boolean;
        includes_soft_deleted_unpurged: boolean;
        excludes_purged: boolean;
        counts: { tags: number; items: number; entries: number };
      };
      items: Array<{ id: string; tag_ids: string[] }>;
      entries: Array<{ id: string; type: string; body: string }>;
    };

    expect(parsed.format).toBe('engram.readable');
    expect(parsed.version).toBe(1);
    expect(parsed.vault_key_id).toBe(TEST_VAULT_KEY_ID);
    expect(parsed.snapshot).toEqual({
      source_export_id: TEST_JOB_ID,
      includes_active: true,
      includes_soft_deleted_unpurged: false,
      excludes_purged: true,
      counts: { tags: 1, items: 1, entries: 2 },
    });
    expect(parsed.items[0]?.tag_ids).toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    expect(parsed.entries[1]?.body).toBe(rawJsonBody);
    expect(parsed.entries[1]?.body).toContain('9007199254740993');
    expect(parsed.entries[1]?.body).toContain('"dup":1,"dup":2');
    expect(parsed.entries[1]?.body).toContain('"negZero":-0');
  });

  it('creates a new source job when latest ready job is older than 10 minutes, polls until ready, and uses FileSystemWritableFileStream when available', async () => {
    const nowMs = Date.parse('2026-11-08T10:20:00Z');
    const staleJob = makeReadyJob({
      id: 'stale-job-id',
      completed_at: '2026-11-08T10:05:00Z', // 15 minutes ago
    });
    const newQueuedJob: ExportJob = {
      id: 'new-job-id',
      kind: 'encrypted',
      status: EXPORT_STATUS.queued,
      created_at: '2026-11-08T10:20:00Z',
    };
    const newReadyJob = makeReadyJob({
      id: 'new-job-id',
      created_at: '2026-11-08T10:20:00Z',
      completed_at: '2026-11-08T10:20:01Z',
    });

    const writtenChunks: string[] = [];
    let closed = false;
    let aborted = false;
    const writable: WritableFileStreamLike = {
      write: async (chunk) => {
        writtenChunks.push(chunk);
      },
      close: async () => {
        closed = true;
      },
      abort: async () => {
        aborted = true;
      },
    };
    const showSaveFilePicker: ShowSaveFilePickerFn = vi.fn().mockResolvedValue({
      createWritable: async () => writable,
    });

    const createExportMock = vi.fn().mockResolvedValue(newQueuedJob);
    const getExportMock = vi.fn().mockResolvedValue(newReadyJob);
    const getDecryptedPageMock = vi.fn().mockResolvedValue({
      source_export_id: 'new-job-id',
      vault_key_id: TEST_VAULT_KEY_ID,
      total_entries: 0,
      section: 'entries',
      items: [],
      next_cursor: null,
    } satisfies DecryptedExportPage);

    const res = await runDecryptedExport({
      getVaultState: () => 'unlocked',
      getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
      openEntry: async () => {
        throw new Error('should not be called');
      },
      opGeneration: 1,
      reauthToken: 'grant-ok',
      deps: {
        now: () => nowMs,
        pollIntervalMs: 5,
        getLatestExport: async () => ({ job: staleJob }),
        createExport: createExportMock,
        getExport: getExportMock,
        getDecryptedPage: getDecryptedPageMock,
        postDecryptedAudit: async () => undefined,
        showSaveFilePicker,
      },
    });

    expect(createExportMock).toHaveBeenCalledTimes(1);
    expect(getExportMock).toHaveBeenCalledWith('new-job-id', expect.any(Object));
    expect(closed).toBe(true);
    expect(aborted).toBe(false);
    expect(res.sourceExportId).toBe('new-job-id');
    expect(JSON.parse(writtenChunks.join('')).snapshot.source_export_id).toBe('new-job-id');
  });

  it('enforces the escaped UTF-8 byte budget on fallback BlobPart[] when control characters expand ×6 (pl-too-large, no object URL created)', async () => {
    const createObjectUrlMock = vi.fn(() => 'blob:test-url');
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectUrlMock,
      configurable: true,
      writable: true,
    });
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();

    // 200 control characters (\u0001) are 200 UTF-8 bytes raw, but escape to 1200 bytes (`\u0001` = 6 bytes each) in JSON.
    const controlCharBody = '\u0001'.repeat(200);

    const page: DecryptedExportPage = {
      source_export_id: TEST_JOB_ID,
      vault_key_id: TEST_VAULT_KEY_ID,
      total_entries: 1,
      section: 'entries',
      items: [
        {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          item_id: '22222222-3333-4444-8555-666666666666',
          type: 'text',
          position: 0,
          version: 1,
          plaintext_len_bucket: 256,
          envelope: {
            v: 1,
            alg: 'xchacha20poly1305-ietf',
            key_id: TEST_VAULT_KEY_ID,
            nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
            ct_enc: 'utf8',
          },
          ciphertext: 'ct',
          created_at: '2026-10-01T00:05:00Z',
          updated_at: '2026-10-01T00:05:00Z',
        },
      ],
      next_cursor: null,
    };

    const postAuditMock = vi.fn();

    await expect(
      runDecryptedExport({
        getVaultState: () => 'unlocked',
        getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
        openEntry: async ({ entryId }) => ({
          entryId,
          envelope: {
            v: 1,
            alg: 'xchacha20poly1305-ietf',
            key_id: TEST_VAULT_KEY_ID,
            nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
            ct_enc: 'utf8',
          },
          plaintext: controlCharBody,
        }),
        opGeneration: 1,
        reauthToken: 'grant-ok',
        deps: {
          now: () => nowMs,
          // Cap at 1000 bytes: raw 200 B + header ~450 B would fit if unescaped (~650 B),
          // but escaped `\u0001` x 200 = 1200 B exceeds 1000 B!
          maxFallbackBytes: 1_000,
          showSaveFilePicker: null,
          getLatestExport: async () => ({ job: readyJob }),
          getDecryptedPage: async () => page,
          postDecryptedAudit: postAuditMock,
        },
      }),
    ).rejects.toMatchObject({
      name: 'DecryptedExportError',
      kind: 'too_large',
    });

    expect(FALLBACK_MAX_ESCAPED_BYTES).toBe(64 * 1024 * 1024);
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(postAuditMock).not.toHaveBeenCalled();
  });

  it('aborts sink without saving partial file when 401 reauth_required occurs on page N or on POST /audit/export-decrypted, and retains sourceJob for 0-quota retry', async () => {
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();
    let writableAborted = false;
    let writableClosed = false;

    const showSaveFilePicker: ShowSaveFilePickerFn = async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => {
          writableClosed = true;
        },
        abort: async () => {
          writableAborted = true;
        },
      }),
    });

    let callCount = 0;
    const getDecryptedPageMock = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          source_export_id: TEST_JOB_ID,
          vault_key_id: TEST_VAULT_KEY_ID,
          total_entries: 2,
          section: 'tags',
          items: [],
          next_cursor: 'page-2-cursor',
        } satisfies DecryptedExportPage;
      }
      throw makeReauthError('reauth_required');
    });

    let caughtErr: DecryptedExportError | null = null;
    try {
      await runDecryptedExport({
        getVaultState: () => 'unlocked',
        getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
        openEntry: async () => {
          throw new Error('not reached');
        },
        opGeneration: 1,
        reauthToken: 'expiring-token',
        deps: {
          now: () => nowMs,
          showSaveFilePicker,
          getLatestExport: async () => ({ job: readyJob }),
          getDecryptedPage: getDecryptedPageMock,
          postDecryptedAudit: async () => undefined,
        },
      });
    } catch (err) {
      caughtErr = err as DecryptedExportError;
    }

    expect(caughtErr).toBeInstanceOf(DecryptedExportError);
    expect(caughtErr?.kind).toBe('reauth_expired');
    expect(caughtErr?.sourceJob?.id).toBe(TEST_JOB_ID);
    expect(writableAborted).toBe(true);
    expect(writableClosed).toBe(false);

    // Sub-case B: 401 reauth_required on POST /audit/export-decrypted -> sink aborted, no finalize, reauth_expired
    let auditWritableAborted = false;
    let auditWritableClosed = false;
    const auditSaveFilePicker: ShowSaveFilePickerFn = async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => {
          auditWritableClosed = true;
        },
        abort: async () => {
          auditWritableAborted = true;
        },
      }),
    });

    let auditCaughtErr: DecryptedExportError | null = null;
    try {
      await runDecryptedExport({
        getVaultState: () => 'unlocked',
        getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
        openEntry: async () => {
          throw new Error('not reached');
        },
        opGeneration: 1,
        reauthToken: 'expiring-at-audit',
        deps: {
          now: () => nowMs,
          showSaveFilePicker: auditSaveFilePicker,
          getLatestExport: async () => ({ job: readyJob }),
          getDecryptedPage: async () => ({
            source_export_id: TEST_JOB_ID,
            vault_key_id: TEST_VAULT_KEY_ID,
            total_entries: 0,
            section: 'entries',
            items: [],
            next_cursor: null,
          }),
          postDecryptedAudit: async () => {
            throw makeReauthError('reauth_required');
          },
        },
      });
    } catch (err) {
      auditCaughtErr = err as DecryptedExportError;
    }

    expect(auditCaughtErr).toBeInstanceOf(DecryptedExportError);
    expect(auditCaughtErr?.kind).toBe('reauth_expired');
    expect(auditCaughtErr?.sourceJob?.id).toBe(TEST_JOB_ID);
    expect(auditWritableAborted).toBe(true);
    expect(auditWritableClosed).toBe(false);
  });
  it('aborts sink immediately on vault lock (registerSecretFormReset) or key_id mismatch', async () => {
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();
    let resetRegisteredFn: (() => void) | null = null;
    let aborted = false;

    const showSaveFilePicker: ShowSaveFilePickerFn = async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => {
          aborted = true;
        },
      }),
    });

    await expect(
      runDecryptedExport({
        getVaultState: () => 'unlocked',
        getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
        openEntry: async () => {
          throw new Error('not reached');
        },
        opGeneration: 1,
        reauthToken: 'grant-ok',
        registerSecretFormReset: (fn) => {
          resetRegisteredFn = fn;
          return () => {
            resetRegisteredFn = null;
          };
        },
        deps: {
          now: () => nowMs,
          showSaveFilePicker,
          getLatestExport: async () => ({ job: readyJob }),
          getDecryptedPage: async () => {
            // Trigger vault lock mid-page
            resetRegisteredFn?.();
            return {
              source_export_id: TEST_JOB_ID,
              vault_key_id: TEST_VAULT_KEY_ID,
              total_entries: 1,
              section: 'tags',
              items: [],
              next_cursor: null,
            };
          },
          postDecryptedAudit: async () => undefined,
        },
      }),
    ).rejects.toMatchObject({
      kind: 'vault_locked',
    });

    expect(aborted).toBe(true);

    // Sub-case B: entry.envelope.key_id mismatch -> sink aborted, key_mismatch
    let mismatchAborted = false;
    let mismatchClosed = false;
    const mismatchPicker: ShowSaveFilePickerFn = async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => {
          mismatchClosed = true;
        },
        abort: async () => {
          mismatchAborted = true;
        },
      }),
    });

    await expect(
      runDecryptedExport({
        getVaultState: () => 'unlocked',
        getCurrentVaultKeyId: () => TEST_VAULT_KEY_ID,
        openEntry: async () => {
          throw new Error('must not be called when envelope.key_id mismatches');
        },
        opGeneration: 1,
        reauthToken: 'grant-ok',
        deps: {
          now: () => nowMs,
          showSaveFilePicker: mismatchPicker,
          getLatestExport: async () => ({ job: readyJob }),
          getDecryptedPage: async () => ({
            source_export_id: TEST_JOB_ID,
            vault_key_id: TEST_VAULT_KEY_ID,
            total_entries: 1,
            section: 'entries',
            items: [
              {
                id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                item_id: '22222222-3333-4444-8555-666666666666',
                type: 'text',
                position: 0,
                version: 1,
                plaintext_len_bucket: 256,
                envelope: {
                  v: 1,
                  alg: 'xchacha20poly1305-ietf',
                  key_id: 'vk:mismatchedEntryKeyId00',
                  nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
                  ct_enc: 'utf8',
                },
                ciphertext: 'ct-text',
                created_at: '2026-10-01T00:05:00Z',
                updated_at: '2026-10-01T00:05:00Z',
              },
            ],
            next_cursor: null,
          }),
          postDecryptedAudit: async () => undefined,
        },
      }),
    ).rejects.toMatchObject({
      kind: 'key_mismatch',
    });

    expect(mismatchAborted).toBe(true);
    expect(mismatchClosed).toBe(false);
  });
});
