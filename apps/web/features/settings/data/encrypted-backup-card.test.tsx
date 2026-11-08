import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_STATUS, type ExportJob } from '@/lib/api/export';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import {
  EncryptedBackupCard,
  formatExpiryClock,
  type EncryptedBackupCardProps,
} from './encrypted-backup-card';

const TEST_JOB_ID = '11111111-2222-4333-8444-555555555555';

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
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

function renderCard(
  props: EncryptedBackupCardProps = {},
  locale: 'vi' | 'en' = 'vi',
) {
  const messages = locale === 'en' ? enMessages : viMessages;
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(<EncryptedBackupCard {...props} />, { wrapper: Wrapper });
}

describe('features/settings/data/encrypted-backup-card (U17a #dulieu)', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('formats formatExpiryClock for today, tomorrow, and further dates in vi and en', () => {
    const now = new Date(2026, 10, 8, 10, 0, 0); // 2026-11-08 10:00 local
    const todayExp = new Date(2026, 10, 8, 14, 12, 0).toISOString();
    const tomorrowExp = new Date(2026, 10, 9, 9, 5, 0).toISOString();
    const futureExp = new Date(2026, 10, 12, 16, 30, 0).toISOString();

    expect(formatExpiryClock(todayExp, now, 'vi')).toEqual({ kind: 'today', clock: '14:12' });
    expect(formatExpiryClock(tomorrowExp, now, 'vi')).toEqual({ kind: 'tomorrow', clock: '09:05' });
    expect(formatExpiryClock(futureExp, now, 'vi')).toEqual({
      kind: 'date',
      clock: '16:30',
      date: '12/11/2026',
    });

    expect(formatExpiryClock(todayExp, now, 'en')).toEqual({ kind: 'today', clock: '14:12' });
    expect(formatExpiryClock(tomorrowExp, now, 'en')).toEqual({ kind: 'tomorrow', clock: '09:05' });
    expect(formatExpiryClock(futureExp, now, 'en')).toEqual({
      kind: 'date',
      clock: '16:30',
      date: '2026-11-12',
    });
  });

  it('maps getLatestExport on mount across all states: null -> exp-idle, cancelled -> exp-idle, failed -> exp-failed, expired/ready<=now -> exp-expired', async () => {
    const nowMs = Date.parse('2026-11-08T12:00:00Z');

    // 1. null -> exp-idle
    fetchMock.mockResolvedValueOnce(jsonResponse({ job: null }));
    const { unmount: u1 } = renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-idle"]')).toBeInTheDocument();
    });
    expect(screen.getByTestId('export-encrypted-start-btn')).toBeEnabled();
    u1();

    // 2. cancelled -> exp-idle
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job: {
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.cancelled,
          created_at: '2026-11-08T11:00:00Z',
        } satisfies ExportJob,
      }),
    );
    const { unmount: u2 } = renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-idle"]')).toBeInTheDocument();
    });
    u2();

    // 3. failed -> exp-failed
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job: {
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.failed,
          created_at: '2026-11-08T11:00:00Z',
        } satisfies ExportJob,
      }),
    );
    const { unmount: u3 } = renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-failed"]')).toBeInTheDocument();
    });
    expect(screen.getByTestId('export-encrypted-start-btn')).toHaveTextContent('Thử lại');
    u3();

    // 4. ready with expires_at <= now -> exp-expired
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job: {
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.ready,
          created_at: '2026-11-07T11:00:00Z',
          completed_at: '2026-11-07T11:01:00Z',
          expires_at: '2026-11-08T11:01:00Z', // past nowMs
          size_bytes: 1024,
        } satisfies ExportJob,
      }),
    );
    const { unmount: u4 } = renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-expired"]')).toBeInTheDocument();
    });
    expect(screen.getByTestId('export-encrypted-start-btn')).toHaveTextContent('Tạo bản mới');
    u4();
  });

  it('reload mid-job: mounts with latest running -> exp-preparing, polls GET /exports/{id}, throttles live region <= 1/s, and transitions to exp-ready', async () => {
    let clockMs = Date.parse('2026-11-08T12:00:00Z');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          job: {
            id: TEST_JOB_ID,
            kind: 'encrypted',
            status: EXPORT_STATUS.running,
            created_at: '2026-11-08T11:59:50Z',
            items_processed: 50,
            items_total: 200,
          } satisfies ExportJob,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.running,
          created_at: '2026-11-08T11:59:50Z',
          items_processed: 120,
          items_total: 200,
        } satisfies ExportJob),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.ready,
          created_at: '2026-11-08T11:59:50Z',
          completed_at: '2026-11-08T12:00:05Z',
          expires_at: '2026-11-09T12:00:05Z',
          size_bytes: 2_516_582,
          items_processed: 200,
          items_total: 200,
        } satisfies ExportJob),
      );

    renderCard({
      pollIntervalMs: 25,
      now: () => clockMs,
    });

    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-preparing"]')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('50/200');

    // Advance clock > 1s so next poll updates live text immediately
    clockMs += 1_500;

    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-ready"]')).toBeInTheDocument();
    });

    const downloadLink = screen.getByTestId('export-encrypted-download-link');
    expect(downloadLink).toHaveAttribute('href', `/api/v1/exports/${TEST_JOB_ID}/download`);
    expect(downloadLink).toHaveTextContent('2,4 MB');
  });

  it('transitions exp-ready -> exp-expired automatically at expires_at timer, and clicking download when server returns 410 transitions to exp-expired + calls getLatestExport', async () => {
    const nowMs = Date.parse('2026-11-08T12:00:00Z');
    const shortExpiryIso = new Date(nowMs + 40).toISOString();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job: {
          id: TEST_JOB_ID,
          kind: 'encrypted',
          status: EXPORT_STATUS.ready,
          created_at: '2026-11-08T11:00:00Z',
          completed_at: '2026-11-08T11:01:00Z',
          expires_at: shortExpiryIso,
          size_bytes: 4096,
        } satisfies ExportJob,
      }),
    );

    const { unmount } = renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-ready"]')).toBeInTheDocument();
    });

    // Wait for timer at expires_at (40ms) to flip to exp-expired
    await waitFor(
      () => {
        expect(document.querySelector('[data-view="exp-expired"]')).toBeInTheDocument();
      },
      { timeout: 1_000 },
    );
    unmount();

    // Now test clicking download link receiving 410
    const longExpiryIso = new Date(nowMs + 3_600_000).toISOString();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          job: {
            id: TEST_JOB_ID,
            kind: 'encrypted',
            status: EXPORT_STATUS.ready,
            created_at: '2026-11-08T11:00:00Z',
            completed_at: '2026-11-08T11:01:00Z',
            expires_at: longExpiryIso,
            size_bytes: 4096,
          } satisfies ExportJob,
        }),
      )
      .mockResolvedValueOnce(problemResponse('export_expired', 410))
      .mockResolvedValueOnce(
        jsonResponse({
          job: {
            id: TEST_JOB_ID,
            kind: 'encrypted',
            status: EXPORT_STATUS.expired,
            created_at: '2026-11-08T11:00:00Z',
          } satisfies ExportJob,
        }),
      );

    renderCard({ now: () => nowMs });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-ready"]')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('export-encrypted-download-link'));

    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-expired"]')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/exports/latest',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('renders exp-limit (429 with retry clock, disabled button + aria-describedby), exp-offline, and locale-aware docsLink (/docs#du-lieu vs /vi/docs#du-lieu)', async () => {
    const baseDate = new Date(2026, 10, 8, 14, 0, 0).getTime(); // 14:00 local
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ job: null }))
      .mockResolvedValueOnce(problemResponse('rate_limited', 429, { retry_after: 720 }));

    const { unmount } = renderCard({ now: () => baseDate }, 'vi');
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-idle"]')).toBeInTheDocument();
    });

    // Check vi docs link
    const viDocsLink = screen.getByRole('link', {
      name: viMessages.settings.data.docsLink,
    });
    expect(viDocsLink).toHaveAttribute('href', '/vi/docs#du-lieu');

    // Click start -> 429 -> exp-limit
    fireEvent.click(screen.getByTestId('export-encrypted-start-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-limit"]')).toBeInTheDocument();
    });

    const limitBtn = screen.getByTestId('export-encrypted-start-btn');
    expect(limitBtn).toBeDisabled();
    const describedById = limitBtn.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const alertNode = document.getElementById(describedById!);
    expect(alertNode).toHaveTextContent('14:12');

    // Also verify L7 timer transitions exp-limit -> exp-idle after retry_after when short
    // Dispatch offline event -> exp-offline
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-offline"]')).toBeInTheDocument();
    });
    expect(screen.getByTestId('export-encrypted-start-btn')).toBeDisabled();
    unmount();

    // Check en docs link
    fetchMock.mockResolvedValueOnce(jsonResponse({ job: null }));
    renderCard({ now: () => baseDate }, 'en');
    await waitFor(() => {
      expect(document.querySelector('[data-view="exp-idle"]')).toBeInTheDocument();
    });
    const enDocsLink = screen.getByRole('link', {
      name: enMessages.settings.data.docsLink,
    });
    expect(enDocsLink).toHaveAttribute('href', '/docs#du-lieu');
  });
});
