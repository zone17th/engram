import {
  classifyExportError,
  createExport,
  EXPORT_STATUS,
  getDecryptedPage,
  getExport,
  getLatestExport,
  isReauthProblem,
  postDecryptedAudit,
  type DecryptedExportItemRow,
  type DecryptedExportItemTagRow,
  type DecryptedExportPage,
  type Entry,
  type ExportJob,
  type Tag,
} from '@/lib/api/export';
import type { OpenEntryClientParams, OpenEntryResult } from '@/lib/crypto/client';

export const READABLE_EXPORT_FORMAT = 'engram.readable' as const;
export const READABLE_EXPORT_VERSION = 1 as const;
export const READABLE_EXPORT_WARNING =
  'SENSITIVE PLAINTEXT EXPORT — Anyone with this file can read all entries.' as const;

/** 10 minutes window for reusing a `ready` `.sabk.json` source job without consuming quota (plan §2.6). */
export const SOURCE_REUSE_WINDOW_MS = 10 * 60 * 1000;

/** 64 MiB UTF-8 byte budget for fallback `BlobPart[]` sink (plan §2.7.3). */
export const FALLBACK_MAX_ESCAPED_BYTES = 64 * 1024 * 1024;

export const SOURCE_POLL_INTERVAL_MS = 1_500;
export const OBJECT_URL_REVOKE_DELAY_MS = 30_000;
export type DecryptedExportErrorKind =
  | 'vault_locked'
  | 'key_mismatch'
  | 'decrypt_failed'
  | 'source_failed'
  | 'source_expired'
  | 'reauth_expired'
  | 'rate_limited'
  | 'paused'
  | 'offline'
  | 'too_large'
  | 'aborted';

export class DecryptedExportError extends Error {
  readonly kind: DecryptedExportErrorKind;
  readonly retryClock?: string;
  readonly retryAfterSeconds?: number;
  readonly sourceJob?: ExportJob | null;

  constructor(
    kind: DecryptedExportErrorKind,
    message: string,
    opts?: {
      retryClock?: string;
      retryAfterSeconds?: number;
      sourceJob?: ExportJob | null;
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = 'DecryptedExportError';
    this.kind = kind;
    this.retryClock = opts?.retryClock;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    this.sourceJob = opts?.sourceJob;
  }
}

export interface WritableFileStreamLike {
  write: (chunk: string) => Promise<void>;
  close: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
}

export interface FileSystemFileHandleLike {
  createWritable: () => Promise<WritableFileStreamLike>;
}

export type ShowSaveFilePickerFn = (options?: {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<FileSystemFileHandleLike>;

export interface DecryptedExportSink {
  readonly kind: 'filesystem' | 'blob';
  readonly maxBytes?: number;
  getBytesWritten: () => number;
  write: (chunk: string) => Promise<void>;
  finalize: (filename: string) => Promise<{ filename: string; bytesWritten: number }>;
  abort: () => Promise<void>;
  dispose?: () => void;
}

const utf8Encoder = new TextEncoder();

export function createBlobFallbackSink(
  options: {
    maxBytes?: number;
    onTriggerDownload?: (blob: Blob, filename: string) => void;
    revokeDelayMs?: number;
  } = {},
): DecryptedExportSink {
  const maxBytes = options.maxBytes ?? FALLBACK_MAX_ESCAPED_BYTES;
  const revokeDelayMs = options.revokeDelayMs ?? OBJECT_URL_REVOKE_DELAY_MS;
  let parts: BlobPart[] | null = [];
  let bytesWritten = 0;
  let objectUrl: string | null = null;
  let revokeTimer: number | null = null;
  let aborted = false;

  const revokeUrlNow = () => {
    if (revokeTimer !== null) {
      clearTimeout(revokeTimer);
      revokeTimer = null;
    }
    if (objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
      objectUrl = null;
    }
  };

  const cleanup = () => {
    aborted = true;
    if (parts) {
      parts.length = 0;
      parts = null;
    }
    revokeUrlNow();
  };
  return {
    kind: 'blob',
    maxBytes,
    getBytesWritten: () => bytesWritten,
    async write(chunk: string) {
      if (aborted || !parts) {
        throw new DecryptedExportError('aborted', 'Export sink already aborted');
      }
      const chunkByteLen = utf8Encoder.encode(chunk).byteLength;
      if (bytesWritten + chunkByteLen > maxBytes) {
        cleanup();
        throw new DecryptedExportError(
          'too_large',
          `Escaped JSON output exceeds ${maxBytes} bytes`,
        );
      }
      bytesWritten += chunkByteLen;
      parts.push(chunk);
    },
    async finalize(filename: string) {
      if (aborted || !parts) {
        throw new DecryptedExportError('aborted', 'Export sink aborted before finalize');
      }
      const blob = new Blob(parts, { type: 'application/json;charset=utf-8' });
      parts.length = 0;
      parts = null;

      if (options.onTriggerDownload) {
        options.onTriggerDownload(blob, filename);
      } else if (
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function' &&
        typeof document !== 'undefined'
      ) {
        objectUrl = URL.createObjectURL(blob);
        const scheduledUrl = objectUrl;
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.style.display = 'none';
        try {
          document.body.appendChild(a);
          a.click();
        } finally {
          if (a.parentNode) {
            a.parentNode.removeChild(a);
          }
          revokeTimer = Number(
            setTimeout(() => {
              revokeTimer = null;
              if (objectUrl === scheduledUrl) {
                revokeUrlNow();
              }
            }, revokeDelayMs),
          );
        }
      }
      return { filename, bytesWritten };
    },
    async abort() {
      cleanup();
    },
    dispose() {
      revokeUrlNow();
    },
  };
}

export function createFileSystemSink(writable: WritableFileStreamLike): DecryptedExportSink {
  let bytesWritten = 0;
  let closed = false;
  let aborted = false;

  return {
    kind: 'filesystem',
    getBytesWritten: () => bytesWritten,
    async write(chunk: string) {
      if (aborted || closed) {
        throw new DecryptedExportError('aborted', 'FileSystem sink is closed or aborted');
      }
      bytesWritten += utf8Encoder.encode(chunk).byteLength;
      await writable.write(chunk);
    },
    async finalize(filename: string) {
      if (aborted || closed) {
        throw new DecryptedExportError('aborted', 'FileSystem sink aborted before finalize');
      }
      closed = true;
      await writable.close();
      return { filename, bytesWritten };
    },
    async abort() {
      if (aborted || closed) return;
      aborted = true;
      try {
        await writable.abort();
      } catch {
        // ignore abort errors
      }
    },
  };
}

export function formatReadableExportFilename(nowInput: number | Date = Date.now()): string {
  const d = typeof nowInput === 'number' ? new Date(nowInput) : new Date(nowInput.getTime());
  const yyyy = d.getUTCFullYear();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `engram-readable-${yyyy}-${mm}-${dd}.json`;
}

export function isReusableReadySourceJob(
  job: ExportJob | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!job || job.status !== EXPORT_STATUS.ready) return false;
  if (job.expires_at) {
    const expMs = Date.parse(job.expires_at);
    if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  }
  const completedIso = job.completed_at ?? job.created_at;
  const completedMs = Date.parse(completedIso);
  if (!Number.isFinite(completedMs)) return false;
  return completedMs >= nowMs - SOURCE_REUSE_WINDOW_MS;
}

export interface DecryptedExportProgress {
  processedEntries: number;
  totalEntries: number;
  phase: 'preparing_source' | 'decrypting';
}

export interface DecryptedExportRunnerDeps {
  getLatestExport?: typeof getLatestExport;
  createExport?: typeof createExport;
  getExport?: typeof getExport;
  getDecryptedPage?: typeof getDecryptedPage;
  postDecryptedAudit?: typeof postDecryptedAudit;
  showSaveFilePicker?: ShowSaveFilePickerFn | null;
  maxFallbackBytes?: number;
  pollIntervalMs?: number;
  now?: () => number;
  onTriggerBlobDownload?: (blob: Blob, filename: string) => void;
}

export interface RunDecryptedExportParams {
  getVaultState: () => string;
  getCurrentVaultKeyId: () => string | null;
  openEntry: (params: OpenEntryClientParams) => Promise<OpenEntryResult>;
  opGeneration: number;
  isOpCurrent?: () => boolean;
  reauthToken: string;
  auditIdempotencyKey?: string;
  createIdempotencyKey?: string;
  preferredSourceJob?: ExportJob | null;
  registerSecretFormReset?: (resetFn: () => void) => () => void;
  signal?: AbortSignal;
  onProgress?: (progress: DecryptedExportProgress) => void;
  onSourceJobReady?: (job: ExportJob) => void;
  deps?: DecryptedExportRunnerDeps;
}

export interface RunDecryptedExportResult {
  filename: string;
  sourceExportId: string;
  totalEntries: number;
  counts: {
    tags: number;
    items: number;
    entries: number;
  };
  bytesWritten: number;
  dispose?: () => void;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('name' in err)) return false;
  return err.name === 'AbortError';
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DecryptedExportError('aborted', 'Aborted'));
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    reject(new DecryptedExportError('aborted', 'Aborted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

async function resolveOrCreateReadySourceJob(
  params: RunDecryptedExportParams,
  signal: AbortSignal,
  nowFn: () => number,
): Promise<ExportJob> {
  const latestFn = params.deps?.getLatestExport ?? getLatestExport;
  const createFn = params.deps?.createExport ?? createExport;
  const getFn = params.deps?.getExport ?? getExport;
  const pollMs = params.deps?.pollIntervalMs ?? SOURCE_POLL_INTERVAL_MS;

  if (params.preferredSourceJob && isReusableReadySourceJob(params.preferredSourceJob, nowFn())) {
    return params.preferredSourceJob;
  }

  let candidate: ExportJob | null = null;
  try {
    const latestRes = await latestFn({ signal });
    candidate = latestRes.job;
  } catch (err) {
    if (signal.aborted || isAbortLikeError(err)) {
      throw new DecryptedExportError('aborted', 'Aborted while checking latest export');
    }
    const classified = classifyExportError(err, nowFn());
    if (classified.kind === 'offline') {
      throw new DecryptedExportError('offline', 'Offline while fetching latest export', {
        cause: err,
      });
    }
    throw new DecryptedExportError('source_failed', 'Could not check latest export', {
      cause: err,
    });
  }

  if (candidate && isReusableReadySourceJob(candidate, nowFn())) {
    return candidate;
  }

  let activeJob: ExportJob;
  if (
    candidate &&
    (candidate.status === EXPORT_STATUS.queued || candidate.status === EXPORT_STATUS.running)
  ) {
    activeJob = candidate;
  } else {
    try {
      activeJob = await createFn({
        idempotencyKey: params.createIdempotencyKey,
        signal,
      });
    } catch (err) {
      if (signal.aborted || isAbortLikeError(err)) {
        throw new DecryptedExportError('aborted', 'Aborted while creating source export');
      }
      const classified = classifyExportError(err, nowFn());
      if (classified.kind === 'rate_limited') {
        throw new DecryptedExportError('rate_limited', 'Export creation rate limited', {
          retryClock: classified.retryClock,
          retryAfterSeconds: classified.retryAfterSeconds,
          cause: err,
        });
      }
      if (classified.kind === 'paused') {
        throw new DecryptedExportError('paused', 'Export creation paused', {
          retryClock: classified.retryClock,
          retryAfterSeconds: classified.retryAfterSeconds,
          cause: err,
        });
      }
      if (classified.kind === 'offline') {
        throw new DecryptedExportError('offline', 'Offline while creating source export', {
          cause: err,
        });
      }
      throw new DecryptedExportError('source_failed', 'Failed to create source export', {
        cause: err,
      });
    }
  }

  while (
    activeJob.status === EXPORT_STATUS.queued ||
    activeJob.status === EXPORT_STATUS.running
  ) {
    if (signal.aborted) {
      throw new DecryptedExportError('aborted', 'Aborted while waiting for source export');
    }
    params.onProgress?.({
      processedEntries: 0,
      totalEntries: activeJob.items_total ?? 0,
      phase: 'preparing_source',
    });
    await sleepWithAbort(pollMs, signal);
    try {
      activeJob = await getFn(activeJob.id, { signal });
    } catch (err) {
      if (signal.aborted || isAbortLikeError(err)) {
        throw new DecryptedExportError('aborted', 'Aborted while polling source export');
      }
      const classified = classifyExportError(err, nowFn());
      if (classified.kind === 'offline') {
        throw new DecryptedExportError('offline', 'Offline while polling source export', {
          cause: err,
        });
      }
      throw new DecryptedExportError('source_failed', 'Polling source export failed', {
        cause: err,
      });
    }
  }

  if (activeJob.status === EXPORT_STATUS.ready) {
    return activeJob;
  }
  if (activeJob.status === EXPORT_STATUS.expired) {
    throw new DecryptedExportError('source_expired', 'Source export expired before decryption');
  }
  if (activeJob.status === EXPORT_STATUS.cancelled) {
    throw new DecryptedExportError('aborted', 'Source export was cancelled');
  }
  throw new DecryptedExportError('source_failed', 'Source export failed');
}

function extractEnvelopeKeyId(envelope: unknown): string | null {
  if (typeof envelope === 'object' && envelope !== null && 'key_id' in envelope) {
    const k = envelope.key_id;
    return typeof k === 'string' ? k : null;
  }
  if (typeof envelope === 'string') {
    try {
      const parsed: unknown = JSON.parse(envelope);
      if (typeof parsed === 'object' && parsed !== null && 'key_id' in parsed) {
        return typeof parsed.key_id === 'string' ? parsed.key_id : null;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Runs the full client-side decrypted export pipeline per plan §2.2, §2.6, §2.7.3, and Task 12:
 * 1. Verifies vault is unlocked.
 * 2. Selects a reusable `ready` source `.sabk.json` job (<= 10m) or creates & waits for one.
 * 3. Streams pages via `GET /api/v1/exports/{id}/decrypted-pages`, checking `vault.state === 'unlocked'`,
 *    `page.vault_key_id === currentVaultKeyId`, and `entry.envelope.key_id === currentVaultKeyId`.
 * 4. Decrypts each entry via Worker `openEntry` without `JSON.parse`/`JSON.stringify` on the decrypted body
 *    (preserves raw UTF-8 string verbatim, only JSON-string-escaping it as `"body": "..."`).
 * 5. Writes sequentially to `FileSystemWritableFileStream` (when available) or fallback `BlobPart[]`
 *    with strict 64 MiB escaped-UTF-8 byte budget checked BEFORE each append.
 * 6. On any error, abort, vault lock (`registerSecretFormReset`), or mid-flow 401 reauth expiry:
 *    aborts the sink immediately (no partial file saved).
 * 7. Calls `POST /api/v1/audit/export-decrypted` after all pages are decrypted, then finalizes the sink.
 */
export async function runDecryptedExport(
  params: RunDecryptedExportParams,
): Promise<RunDecryptedExportResult> {
  const nowFn = params.deps?.now ?? (() => Date.now());
  const pageFn = params.deps?.getDecryptedPage ?? getDecryptedPage;
  const auditFn = params.deps?.postDecryptedAudit ?? postDecryptedAudit;

  let sink: DecryptedExportSink | null = null;
  const internalAbort = new AbortController();
  const onExternalAbort = () => {
    internalAbort.abort();
    if (sink) {
      void sink.abort();
    }
  };
  if (params.signal) {
    if (params.signal.aborted) {
      internalAbort.abort();
    } else {
      params.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  let lockedDuringRun = false;

  const unregisterReset = params.registerSecretFormReset?.(() => {
    lockedDuringRun = true;
    internalAbort.abort();
    if (sink) {
      void sink.abort();
    }
  });

  const assertUnlockedAndCurrent = () => {
    if (lockedDuringRun) {
      throw new DecryptedExportError('vault_locked', 'Vault locked during decrypted export');
    }
    if (internalAbort.signal.aborted) {
      throw new DecryptedExportError('aborted', 'Decrypted export was cancelled');
    }
    if (params.getVaultState() !== 'unlocked') {
      throw new DecryptedExportError('vault_locked', 'Vault must be unlocked');
    }
    if (params.isOpCurrent && !params.isOpCurrent()) {
      throw new DecryptedExportError('vault_locked', 'Vault generation changed');
    }
    const keyId = params.getCurrentVaultKeyId();
    if (!keyId) {
      throw new DecryptedExportError('vault_locked', 'Missing current vault_key_id');
    }
    return keyId;
  };

  let resolvedSourceJob: ExportJob | null = null;

  try {
    const initialVaultKeyId = assertUnlockedAndCurrent();
    const filename = formatReadableExportFilename(nowFn());

    let picker: ShowSaveFilePickerFn | null = null;
    if (params.deps?.showSaveFilePicker !== undefined) {
      picker = params.deps.showSaveFilePicker;
    } else if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      const maybePicker = window.showSaveFilePicker;
      if (typeof maybePicker === 'function') {
        picker = maybePicker.bind(window) as ShowSaveFilePickerFn;
      }
    }

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: filename,
          types: [
            {
              description: 'engram readable export (.json)',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        sink = createFileSystemSink(writable);
      } catch (err) {
        if (isAbortLikeError(err)) {
          throw new DecryptedExportError('aborted', 'User cancelled file save picker', {
            cause: err,
          });
        }
        sink = createBlobFallbackSink({
          maxBytes: params.deps?.maxFallbackBytes ?? FALLBACK_MAX_ESCAPED_BYTES,
          onTriggerDownload: params.deps?.onTriggerBlobDownload,
        });
      }
    } else {
      sink = createBlobFallbackSink({
        maxBytes: params.deps?.maxFallbackBytes ?? FALLBACK_MAX_ESCAPED_BYTES,
        onTriggerDownload: params.deps?.onTriggerBlobDownload,
      });
    }

    assertUnlockedAndCurrent();

    // Step 1: Select or create source job
    const sourceJob = await resolveOrCreateReadySourceJob(params, internalAbort.signal, nowFn);
    resolvedSourceJob = sourceJob;
    params.onSourceJobReady?.(sourceJob);

    assertUnlockedAndCurrent();

    // We buffer lightweight metadata (tags, items, item_tags) until `entries` starts so that:
    // 1. `items[].tag_ids` can be populated from `item_tags`, and
    // 2. `snapshot.counts` (`{ tags, items, entries }`) is written before the arrays,
    // while entries (which carry up to 256 KiB plaintexts each) are decrypted and streamed
    // element-by-element directly to the sink without buffering in RAM.
    const bufferedTags: Array<{
      id: string;
      display: string;
      item_count: number;
      last_used_at: string;
      created_at: string;
    }> = [];
    const bufferedItems: Array<{
      id: string;
      name: string;
      hint: string | null;
      version: number;
      last_used_at: string;
      created_at: string;
      updated_at: string;
      tag_ids: string[];
    }> = [];
    const itemTagsByItemId = new Map<string, string[]>();

    let headerAndMetaFlushed = false;
    let entriesWritten = 0;
    let totalEntriesFromServer = 0;
    const exportedAtIso = new Date(nowFn()).toISOString();

    const flushHeaderAndMetadataToSink = async (
      sourceExportId: string,
      vaultKeyId: string,
      totalEntries: number,
    ) => {
      if (headerAndMetaFlushed || !sink) return;
      headerAndMetaFlushed = true;

      for (const item of bufferedItems) {
        const mappedTags = itemTagsByItemId.get(item.id);
        if (mappedTags && mappedTags.length > 0) {
          item.tag_ids = mappedTags;
        }
      }

      const headerPrefix =
        `{\n` +
        `  "format": ${JSON.stringify(READABLE_EXPORT_FORMAT)},\n` +
        `  "version": ${READABLE_EXPORT_VERSION},\n` +
        `  "exported_at": ${JSON.stringify(exportedAtIso)},\n` +
        `  "vault_key_id": ${JSON.stringify(vaultKeyId)},\n` +
        `  "warning": ${JSON.stringify(READABLE_EXPORT_WARNING)},\n` +
        `  "snapshot": {\n` +
        `    "source_export_id": ${JSON.stringify(sourceExportId)},\n` +
        `    "includes_active": true,\n` +
        `    "includes_soft_deleted_unpurged": false,\n` +
        `    "excludes_purged": true,\n` +
        `    "counts": { "tags": ${bufferedTags.length}, "items": ${bufferedItems.length}, "entries": ${totalEntries} }\n` +
        `  },\n` +
        `  "tags": [`;

      await sink.write(headerPrefix);

      for (let i = 0; i < bufferedTags.length; i++) {
        const tag = bufferedTags[i]!;
        const sep = i === 0 ? '\n    ' : ',\n    ';
        const serializedTag =
          `${sep}{ "id": ${JSON.stringify(tag.id)}, "display": ${JSON.stringify(tag.display)}, ` +
          `"item_count": ${tag.item_count}, "last_used_at": ${JSON.stringify(tag.last_used_at)}, ` +
          `"created_at": ${JSON.stringify(tag.created_at)} }`;
        await sink.write(serializedTag);
      }

      await sink.write(bufferedTags.length > 0 ? '\n  ],\n  "items": [' : '],\n  "items": [');

      for (let i = 0; i < bufferedItems.length; i++) {
        const item = bufferedItems[i]!;
        const sep = i === 0 ? '\n    ' : ',\n    ';
        const serializedItem =
          `${sep}{ "id": ${JSON.stringify(item.id)}, "name": ${JSON.stringify(item.name)}, ` +
          `"hint": ${JSON.stringify(item.hint)}, "tag_ids": ${JSON.stringify(item.tag_ids)}, ` +
          `"version": ${item.version}, "last_used_at": ${JSON.stringify(item.last_used_at)}, ` +
          `"created_at": ${JSON.stringify(item.created_at)}, "updated_at": ${JSON.stringify(item.updated_at)} }`;
        await sink.write(serializedItem);
      }

      await sink.write(
        bufferedItems.length > 0 ? '\n  ],\n  "entries": [' : '],\n  "entries": [',
      );
    };

    let cursor: string | null = null;
    let firstPage = true;

    while (firstPage || cursor !== null) {
      firstPage = false;
      const currentVaultKeyId = assertUnlockedAndCurrent();

      let page: DecryptedExportPage;
      try {
        page = await pageFn(sourceJob.id, cursor, {
          reauthToken: params.reauthToken,
          signal: internalAbort.signal,
        });
      } catch (err) {
        if (lockedDuringRun) {
          throw new DecryptedExportError('vault_locked', 'Vault locked while fetching page', {
            sourceJob,
            cause: err,
          });
        }
        if (internalAbort.signal.aborted || isAbortLikeError(err)) {
          throw new DecryptedExportError('aborted', 'Aborted while fetching decrypted page', {
            sourceJob,
            cause: err,
          });
        }
        if (isReauthProblem(err)) {
          throw new DecryptedExportError(
            'reauth_expired',
            'Re-authentication grant expired during decrypted-pages',
            { sourceJob, cause: err },
          );
        }
        const classified = classifyExportError(err, nowFn());
        if (classified.kind === 'offline') {
          throw new DecryptedExportError('offline', 'Offline during decrypted-pages', {
            sourceJob,
            cause: err,
          });
        }
        if (classified.kind === 'export_expired') {
          throw new DecryptedExportError(
            'source_expired',
            'Source export expired during decrypted-pages',
            { sourceJob, cause: err },
          );
        }
        throw new DecryptedExportError('source_failed', 'Failed to fetch decrypted page', {
          sourceJob,
          cause: err,
        });
      }

      const activeKeyAfterFetch = assertUnlockedAndCurrent();
      if (
        page.vault_key_id !== currentVaultKeyId ||
        page.vault_key_id !== activeKeyAfterFetch ||
        page.vault_key_id !== initialVaultKeyId
      ) {
        throw new DecryptedExportError(
          'key_mismatch',
          `Page vault_key_id ${page.vault_key_id} does not match current vault key ${activeKeyAfterFetch}`,
          { sourceJob },
        );
      }

      totalEntriesFromServer = page.total_entries;
      params.onProgress?.({
        processedEntries: entriesWritten,
        totalEntries: totalEntriesFromServer,
        phase: 'decrypting',
      });

      if (page.section === 'tags') {
        for (const raw of page.items as Tag[]) {
          bufferedTags.push({
            id: raw.id,
            display: raw.display,
            item_count: raw.item_count,
            last_used_at: raw.last_used_at,
            created_at: raw.created_at,
          });
        }
      } else if (page.section === 'items') {
        for (const raw of page.items as DecryptedExportItemRow[]) {
          bufferedItems.push({
            id: raw.id,
            name: raw.name,
            hint: raw.hint ?? null,
            version: raw.version,
            last_used_at: raw.last_used_at,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            tag_ids: Array.isArray(raw.tag_ids) ? [...raw.tag_ids] : [],
          });
        }
      } else if (page.section === 'item_tags') {
        for (const raw of page.items as DecryptedExportItemTagRow[]) {
          let list = itemTagsByItemId.get(raw.item_id);
          if (!list) {
            list = [];
            itemTagsByItemId.set(raw.item_id, list);
          }
          list.push(raw.tag_id);
        }
      } else if (page.section === 'entries') {
        await flushHeaderAndMetadataToSink(
          page.source_export_id || sourceJob.id,
          initialVaultKeyId,
          totalEntriesFromServer,
        );

        for (const rawEntry of page.items as Entry[]) {
          const checkKeyId = assertUnlockedAndCurrent();
          const envKeyId = extractEnvelopeKeyId(rawEntry.envelope);
          if (!envKeyId || envKeyId !== checkKeyId || envKeyId !== initialVaultKeyId) {
            throw new DecryptedExportError(
              'key_mismatch',
              `Entry ${rawEntry.id} key_id mismatch`,
              { sourceJob },
            );
          }

          let opened: OpenEntryResult;
          try {
            opened = await params.openEntry({
              entryId: rawEntry.id,
              envelope: rawEntry.envelope,
              ciphertext: rawEntry.ciphertext,
              opGeneration: params.opGeneration,
            });
          } catch (err) {
            if (lockedDuringRun || params.getVaultState() !== 'unlocked') {
              throw new DecryptedExportError(
                'vault_locked',
                'Vault locked while decrypting entry',
                { sourceJob, cause: err },
              );
            }
            if (internalAbort.signal.aborted) {
              throw new DecryptedExportError('aborted', 'Aborted while decrypting entry', {
                sourceJob,
                cause: err,
              });
            }
            throw new DecryptedExportError(
              'decrypt_failed',
              `Failed to decrypt entry ${rawEntry.id}`,
              { sourceJob, cause: err },
            );
          }

          assertUnlockedAndCurrent();

          // IMPORTANT (P06-A3 / ADR 0005): Never JSON.parse + JSON.stringify `opened.plaintext`.
          // `opened.plaintext` is already the exact UTF-8 string decoded from the AEAD payload;
          // `JSON.stringify(opened.plaintext)` only escapes it as a JSON string literal (`"..."`).
          const rawBodyStringLiteral = JSON.stringify(opened.plaintext);
          const sep = entriesWritten === 0 ? '\n    ' : ',\n    ';
          const entryChunk =
            `${sep}{ "id": ${JSON.stringify(rawEntry.id)}, "item_id": ${JSON.stringify(rawEntry.item_id)}, ` +
            `"type": ${JSON.stringify(rawEntry.type)}, "position": ${rawEntry.position}, ` +
            `"version": ${rawEntry.version}, "body": ${rawBodyStringLiteral}, ` +
            `"created_at": ${JSON.stringify(rawEntry.created_at)}, "updated_at": ${JSON.stringify(rawEntry.updated_at)} }`;

          await sink.write(entryChunk);
          entriesWritten += 1;

          params.onProgress?.({
            processedEntries: entriesWritten,
            totalEntries: totalEntriesFromServer,
            phase: 'decrypting',
          });
        }
      }

      cursor = page.next_cursor ?? null;
    }

    await flushHeaderAndMetadataToSink(
      sourceJob.id,
      initialVaultKeyId,
      totalEntriesFromServer,
    );

    const closingChunk = entriesWritten > 0 ? '\n  ]\n}\n' : ']\n}\n';
    await sink.write(closingChunk);

    assertUnlockedAndCurrent();

    // Record audit BEFORE finalizing/saving the file so if the grant expired on the audit call (NF-07),
    // the sink is still aborted and no partial/unaudited file is saved.
    try {
      await auditFn({
        idempotencyKey: params.auditIdempotencyKey,
        reauthToken: params.reauthToken,
        signal: internalAbort.signal,
      });
    } catch (err) {
      if (lockedDuringRun) {
        throw new DecryptedExportError('vault_locked', 'Vault locked during audit', {
          sourceJob,
          cause: err,
        });
      }
      if (internalAbort.signal.aborted || isAbortLikeError(err)) {
        throw new DecryptedExportError('aborted', 'Aborted during audit', {
          sourceJob,
          cause: err,
        });
      }
      if (isReauthProblem(err)) {
        throw new DecryptedExportError(
          'reauth_expired',
          'Re-authentication grant expired during POST /audit/export-decrypted',
          { sourceJob, cause: err },
        );
      }
      const classified = classifyExportError(err, nowFn());
      if (classified.kind === 'offline') {
        throw new DecryptedExportError('offline', 'Offline during audit', {
          sourceJob,
          cause: err,
        });
      }
      throw new DecryptedExportError('decrypt_failed', 'Failed to record decrypted export audit', {
        sourceJob,
        cause: err,
      });
    }

    const finalized = await sink.finalize(filename);
    const counts = {
      tags: bufferedTags.length,
      items: bufferedItems.length,
      entries: entriesWritten,
    };
    bufferedTags.length = 0;
    bufferedItems.length = 0;
    itemTagsByItemId.clear();

    const disposeSink = sink.dispose ? () => sink?.dispose?.() : undefined;
    return {
      filename: finalized.filename,
      sourceExportId: sourceJob.id,
      totalEntries: entriesWritten,
      counts,
      bytesWritten: finalized.bytesWritten,
      dispose: disposeSink,
    };
  } catch (err) {
    if (sink) {
      await sink.abort();
    }
    if (err instanceof DecryptedExportError) {
      if (!err.sourceJob && resolvedSourceJob) {
        throw new DecryptedExportError(err.kind, err.message, {
          retryClock: err.retryClock,
          retryAfterSeconds: err.retryAfterSeconds,
          sourceJob: resolvedSourceJob,
          cause: err,
        });
      }
      throw err;
    }
    throw new DecryptedExportError('decrypt_failed', 'Unexpected decrypted export error', {
      sourceJob: resolvedSourceJob,
      cause: err,
    });
  } finally {
    unregisterReset?.();
    if (params.signal) {
      params.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
