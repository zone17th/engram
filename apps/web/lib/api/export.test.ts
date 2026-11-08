import { ProblemError } from '@engram/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelExport,
  classifyExportError,
  createExport,
  downloadUrl,
  EXPORT_STATUS,
  formatRetryClock,
  formatRetryWallClock,
  getDecryptedPage,
  getExport,
  getLatestExport,
  normalizeRetryAfter,
  postDecryptedAudit,
} from '@/lib/api/export';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    {
      status,
      headers: {
        'content-type': 'application/problem+json',
        ...headers,
      },
    },
  );
}

describe('lib/api/export', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls POST /exports with Idempotency-Key and kind="encrypted"', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: '11111111-2222-4333-8444-555555555555',
          kind: 'encrypted',
          status: EXPORT_STATUS.queued,
          created_at: '2026-11-08T10:00:00Z',
        },
        202,
      ),
    );

    const job = await createExport({ idempotencyKey: 'idem-export-create-1' });
    expect(job.status).toBe('queued');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('/api/v1/exports');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ kind: 'encrypted' });
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('Idempotency-Key')).toBe('idem-export-create-1');
    expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
  });

  it('calls GET /exports/latest, GET /exports/{id}, POST /exports/{id}/cancel, and builds session-only downloadUrl', async () => {
    const fetchMock = vi.mocked(fetch);
    const jobId = '22222222-3333-4444-8555-666666666666';

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          job: {
            id: jobId,
            kind: 'encrypted',
            status: EXPORT_STATUS.running,
            created_at: '2026-11-08T10:00:00Z',
            items_processed: 40,
            items_total: 100,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: jobId,
          kind: 'encrypted',
          status: EXPORT_STATUS.ready,
          created_at: '2026-11-08T10:00:00Z',
          completed_at: '2026-11-08T10:01:00Z',
          expires_at: '2026-11-09T10:01:00Z',
          size_bytes: 2048,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: jobId,
          kind: 'encrypted',
          status: EXPORT_STATUS.cancelled,
          created_at: '2026-11-08T10:00:00Z',
        }),
      );

    const latest = await getLatestExport();
    expect(latest.job?.id).toBe(jobId);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/exports/latest');

    const single = await getExport(jobId);
    expect(single.status).toBe('ready');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/exports/${jobId}`);

    const cancelled = await cancelExport(jobId, { idempotencyKey: 'idem-cancel-1' });
    expect(cancelled.status).toBe('cancelled');
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/v1/exports/${jobId}/cancel`);
    const cancelHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(cancelHeaders.get('Idempotency-Key')).toBe('idem-cancel-1');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({});

    const dlUrl = downloadUrl(jobId);
    expect(dlUrl).toBe(`/api/v1/exports/${jobId}/download`);
    expect(dlUrl).not.toContain('?');
    expect(dlUrl).not.toContain('token');
  });

  it('retries GET /exports/{id}/decrypted-pages and POST /audit/export-decrypted when 401 reauth_required is resolved via onReauthRequired', async () => {
    const fetchMock = vi.mocked(fetch);
    const jobId = '33333333-4444-4555-8666-777777777777';

    fetchMock
      .mockResolvedValueOnce(problemResponse('reauth_required', 401))
      .mockResolvedValueOnce(
        jsonResponse({
          source_export_id: jobId,
          vault_key_id: 'vk:AAECAwQFBgcICQoLDA0ODw',
          total_entries: 2,
          section: 'tags',
          items: [],
          next_cursor: 'cursor-2',
        }),
      )
      .mockResolvedValueOnce(problemResponse('reauth_invalid', 401))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const page = await getDecryptedPage(jobId, 'cursor-1', {
      reauthToken: 'expired-token',
      onReauthRequired: async () => 'fresh-token-1',
    });
    expect(page.next_cursor).toBe('cursor-2');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/exports/${jobId}/decrypted-pages?cursor=cursor-1`,
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-Reauth-Token')).toBe(
      'expired-token',
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-Reauth-Token')).toBe(
      'fresh-token-1',
    );

    await postDecryptedAudit({
      idempotencyKey: 'idem-audit-1',
      reauthToken: 'expired-token-2',
      onReauthRequired: async () => 'fresh-token-2',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/audit/export-decrypted');
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get('Idempotency-Key')).toBe(
      'idem-audit-1',
    );
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('Idempotency-Key')).toBe(
      'idem-audit-1',
    );
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('X-Reauth-Token')).toBe(
      'fresh-token-2',
    );
  });

  it('classifies 429 rate_limited, 503 dependency_unavailable (paused), 401 reauth, 410 export_expired, and 409 export_not_ready', () => {
    const baseDate = new Date(2026, 10, 8, 14, 0, 0); // 14:00 local time
    expect(normalizeRetryAfter(720)).toBe(720);
    expect(formatRetryClock(75)).toBe('1:15');
    expect(formatRetryWallClock(720, baseDate)).toBe('14:12');

    const rateErr = new ProblemError({
      type: 'https://engram.zone17.click/problems/rate_limited',
      title: 'rate_limited',
      status: 429,
      code: 'rate_limited',
      retry_after: 720,
    });
    const classifiedRate = classifyExportError(rateErr, baseDate);
    expect(classifiedRate).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 720,
      retryClock: '14:12',
      problemCode: 'rate_limited',
      status: 429,
    });

    const pausedErr = new ProblemError({
      type: 'https://engram.zone17.click/problems/dependency_unavailable',
      title: 'dependency_unavailable',
      status: 503,
      code: 'dependency_unavailable',
      retry_after: 600,
    });
    const classifiedPaused = classifyExportError(pausedErr, baseDate);
    expect(classifiedPaused).toEqual({
      kind: 'paused',
      retryAfterSeconds: 600,
      retryClock: '14:10',
      problemCode: 'dependency_unavailable',
      status: 503,
    });

    const expiredErr = new ProblemError({
      type: 'https://engram.zone17.click/problems/export_expired',
      title: 'export_expired',
      status: 410,
      code: 'export_expired',
    });
    expect(classifyExportError(expiredErr, baseDate).kind).toBe('export_expired');

    const notReadyErr = new ProblemError({
      type: 'https://engram.zone17.click/problems/export_not_ready',
      title: 'export_not_ready',
      status: 409,
      code: 'export_not_ready',
    });
    expect(classifyExportError(notReadyErr, baseDate).kind).toBe('export_not_ready');
  });
});
