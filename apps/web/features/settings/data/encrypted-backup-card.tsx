'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  cancelExport,
  classifyExportError,
  createExport,
  downloadUrl,
  EXPORT_STATUS,
  getExport,
  getLatestExport,
  type ExportJob,
} from '@/lib/api/export';

export type EncryptedBackupViewState =
  | 'exp-idle'
  | 'exp-preparing'
  | 'exp-ready'
  | 'exp-failed'
  | 'exp-expired'
  | 'exp-limit'
  | 'exp-offline';

export const POLL_INTERVAL_MS = 1_500;
export const LIVE_REGION_THROTTLE_MS = 1_000;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Formats an expiry timestamp (`expires_at`) relative to `now` in `vi` or `en`
 * per plan Task 12 (`FE-R1-17`):
 * - same local day: "Tải được tới 14:12 hôm nay" / "Available until 14:12 today"
 * - next local day: "Tải được tới 09:05 ngày mai" / "Available until 09:05 tomorrow"
 * - further: includes date.
 */
export function formatExpiryClock(
  expiresAtIso: string,
  nowInput: number | Date = Date.now(),
  locale: string = 'vi',
): string {
  const exp = new Date(expiresAtIso);
  if (Number.isNaN(exp.getTime())) {
    return expiresAtIso;
  }
  const now = typeof nowInput === 'number' ? new Date(nowInput) : new Date(nowInput.getTime());
  const clock = `${pad2(exp.getHours())}:${pad2(exp.getMinutes())}`;

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const isVi = locale === 'vi' || locale.startsWith('vi-');

  if (isSameLocalDay(exp, now)) {
    return isVi ? `Tải được tới ${clock} hôm nay` : `Available until ${clock} today`;
  }
  if (isSameLocalDay(exp, tomorrow)) {
    return isVi ? `Tải được tới ${clock} ngày mai` : `Available until ${clock} tomorrow`;
  }

  const day = pad2(exp.getDate());
  const month = pad2(exp.getMonth() + 1);
  const year = exp.getFullYear();
  if (isVi) {
    return `Tải được tới ${clock} ngày ${day}/${month}/${year}`;
  }
  return `Available until ${clock} on ${year}-${month}-${day}`;
}

export function formatBackupFileSize(sizeBytes: number | null | undefined, locale: string = 'vi'): string | null {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }
  const isVi = locale === 'vi' || locale.startsWith('vi-');
  const nf = new Intl.NumberFormat(isVi ? 'vi-VN' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${nf.format(sizeBytes / 1024)} KB`;
  }
  return `${nf.format(sizeBytes / (1024 * 1024))} MB`;
}

export function mapExportJobToViewState(
  job: ExportJob | null | undefined,
  nowMs: number = Date.now(),
): EncryptedBackupViewState {
  if (!job) return 'exp-idle';
  switch (job.status) {
    case EXPORT_STATUS.queued:
    case EXPORT_STATUS.running:
      return 'exp-preparing';
    case EXPORT_STATUS.ready: {
      if (job.expires_at) {
        const expMs = Date.parse(job.expires_at);
        if (Number.isFinite(expMs) && expMs <= nowMs) {
          return 'exp-expired';
        }
      }
      return 'exp-ready';
    }
    case EXPORT_STATUS.expired:
      return 'exp-expired';
    case EXPORT_STATUS.failed:
      return 'exp-failed';
    case EXPORT_STATUS.cancelled:
    default:
      return 'exp-idle';
  }
}

export interface EncryptedBackupCardProps {
  onOpenReadableExport?: (opener: HTMLButtonElement | null) => void;
  pollIntervalMs?: number;
  now?: () => number;
}

export function EncryptedBackupCard({
  onOpenReadableExport,
  pollIntervalMs = POLL_INTERVAL_MS,
  now = () => Date.now(),
}: EncryptedBackupCardProps) {
  const t = useTranslations('settings.data');
  const locale = useLocale();
  const limitAlertId = useId();
  const offlineStatusId = useId();
  const readableTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [viewState, setViewState] = useState<EncryptedBackupViewState>('exp-idle');
  const [currentJob, setCurrentJob] = useState<ExportJob | null>(null);
  const [limitClock, setLimitClock] = useState<string>('14:12');
  const [isPausedLimit, setIsPausedLimit] = useState(false);
  const [busy, setBusy] = useState(false);

  // Live region throttle (<= 1 update / second) for items_processed / items_total text
  const [announcedProcessed, setAnnouncedProcessed] = useState<number>(0);
  const [announcedTotal, setAnnouncedTotal] = useState<number>(0);
  const lastLiveUpdateAtRef = useRef<number>(0);
  const pendingLiveTimerRef = useRef<number | null>(null);

  const mountedRef = useRef(true);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const expiryTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const clearLiveTimer = useCallback(() => {
    if (pendingLiveTimerRef.current !== null) {
      clearTimeout(pendingLiveTimerRef.current);
      pendingLiveTimerRef.current = null;
    }
  }, []);

  const updateLiveProgress = useCallback(
    (processed: number, total: number, force = false) => {
      const currentNow = now();
      const elapsed = currentNow - lastLiveUpdateAtRef.current;
      if (force || lastLiveUpdateAtRef.current === 0 || elapsed >= LIVE_REGION_THROTTLE_MS) {
        clearLiveTimer();
        lastLiveUpdateAtRef.current = currentNow;
        setAnnouncedProcessed(processed);
        setAnnouncedTotal(total);
        return;
      }
      clearLiveTimer();
      const remaining = Math.max(10, LIVE_REGION_THROTTLE_MS - elapsed);
      pendingLiveTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return;
        lastLiveUpdateAtRef.current = now();
        setAnnouncedProcessed(processed);
        setAnnouncedTotal(total);
      }, remaining);
    },
    [clearLiveTimer, now],
  );

  const applyJobState = useCallback(
    (job: ExportJob | null, forceLive = false) => {
      const currentNow = now();
      const nextState = mapExportJobToViewState(job, currentNow);
      setCurrentJob(job);
      setViewState(nextState);
      if (nextState === 'exp-preparing' && job) {
        updateLiveProgress(job.items_processed ?? 0, job.items_total ?? 0, forceLive);
      } else {
        clearLiveTimer();
        lastLiveUpdateAtRef.current = 0;
      }
    },
    [clearLiveTimer, now, updateLiveProgress],
  );

  // Schedule poll when in exp-preparing
  useEffect(() => {
    if (viewState !== 'exp-preparing' || !currentJob?.id) {
      stopPolling();
      return;
    }

    let cancelled = false;
    const jobId = currentJob.id;

    const scheduleNextPoll = () => {
      if (cancelled || !mountedRef.current) return;
      pollTimerRef.current = window.setTimeout(async () => {
        if (cancelled || !mountedRef.current) return;
        const controller = new AbortController();
        pollAbortRef.current = controller;
        try {
          const updated = await getExport(jobId, { signal: controller.signal });
          if (cancelled || !mountedRef.current) return;
          applyJobState(updated);
          const mapped = mapExportJobToViewState(updated, now());
          if (mapped === 'exp-preparing') {
            scheduleNextPoll();
          }
        } catch (err) {
          if (cancelled || !mountedRef.current || controller.signal.aborted) return;
          const classified = classifyExportError(err, now());
          if (classified.kind === 'offline') {
            setViewState('exp-offline');
            return;
          }
          if (classified.kind === 'not_found') {
            setViewState('exp-idle');
            setCurrentJob(null);
            return;
          }
          scheduleNextPoll();
        }
      }, pollIntervalMs);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [applyJobState, currentJob?.id, now, pollIntervalMs, stopPolling, viewState]);

  // Client timer transitioning exp-ready -> exp-expired right at expires_at
  useEffect(() => {
    clearExpiryTimer();
    if (viewState !== 'exp-ready' || !currentJob?.expires_at) {
      return;
    }
    const expMs = Date.parse(currentJob.expires_at);
    if (!Number.isFinite(expMs)) return;
    const delayMs = expMs - now();
    if (delayMs <= 0) {
      setViewState('exp-expired');
      return;
    }
    expiryTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setViewState('exp-expired');
    }, delayMs);

    return () => {
      clearExpiryTimer();
    };
  }, [clearExpiryTimer, currentJob?.expires_at, now, viewState]);

  const refreshLatest = useCallback(
    async (signal?: AbortSignal) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setViewState('exp-offline');
        return null;
      }
      try {
        const res = await getLatestExport({ signal });
        if (!mountedRef.current || signal?.aborted) return null;
        applyJobState(res.job, true);
        return res.job;
      } catch (err) {
        if (!mountedRef.current || signal?.aborted) return null;
        const classified = classifyExportError(err, now());
        if (classified.kind === 'offline') {
          setViewState('exp-offline');
        }
        return null;
      }
    },
    [applyJobState, now],
  );

  // Mount: call getLatestExport() and listen to online/offline events
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refreshLatest(controller.signal);

    const handleOffline = () => {
      if (!mountedRef.current) return;
      stopPolling();
      setViewState('exp-offline');
    };
    const handleOnline = () => {
      if (!mountedRef.current) return;
      void refreshLatest();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', handleOffline);
      window.addEventListener('online', handleOnline);
    }

    return () => {
      mountedRef.current = false;
      controller.abort();
      stopPolling();
      clearExpiryTimer();
      clearLiveTimer();
      if (typeof window !== 'undefined') {
        window.removeEventListener('offline', handleOffline);
        window.removeEventListener('online', handleOnline);
      }
    };
  }, [clearExpiryTimer, clearLiveTimer, refreshLatest, stopPolling]);

  const handleStartBackup = useCallback(async () => {
    if (busy) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setViewState('exp-offline');
      return;
    }
    setBusy(true);
    setIsPausedLimit(false);
    try {
      const job = await createExport();
      if (!mountedRef.current) return;
      applyJobState(job, true);
    } catch (err) {
      if (!mountedRef.current) return;
      const classified = classifyExportError(err, now());
      if (classified.kind === 'rate_limited') {
        setIsPausedLimit(false);
        setLimitClock(classified.retryClock ?? '14:12');
        setViewState('exp-limit');
      } else if (classified.kind === 'paused') {
        setIsPausedLimit(true);
        setLimitClock(classified.retryClock ?? '14:12');
        setViewState('exp-limit');
      } else if (classified.kind === 'offline') {
        setViewState('exp-offline');
      } else {
        setViewState('exp-failed');
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }, [applyJobState, busy, now]);

  const handleCancelBackup = useCallback(async () => {
    if (busy || !currentJob?.id) return;
    setBusy(true);
    stopPolling();
    try {
      const cancelled = await cancelExport(currentJob.id);
      if (!mountedRef.current) return;
      applyJobState(cancelled, true);
    } catch (err) {
      if (!mountedRef.current) return;
      const classified = classifyExportError(err, now());
      if (classified.kind === 'export_expired') {
        setViewState('exp-expired');
      } else if (classified.kind === 'offline') {
        setViewState('exp-offline');
      } else {
        void refreshLatest();
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }, [applyJobState, busy, currentJob?.id, now, refreshLatest, stopPolling]);

  const handleDownloadClick = useCallback(
    async (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!currentJob?.id) return;
      e.preventDefault();
      if (busy) return;

      const expMs = currentJob.expires_at ? Date.parse(currentJob.expires_at) : NaN;
      if (Number.isFinite(expMs) && expMs <= now()) {
        setViewState('exp-expired');
        void refreshLatest();
        return;
      }

      setBusy(true);
      try {
        const href = downloadUrl(currentJob.id);
        const res = await fetch(href, {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (!mountedRef.current) return;

        if (res.status === 410 || res.status === 404 || res.status === 409) {
          setViewState('exp-expired');
          await refreshLatest();
          return;
        }
        if (!res.ok) {
          setViewState('exp-failed');
          return;
        }

        const blob = await res.blob();
        if (!mountedRef.current) return;

        let filename = `engram-backup-${(currentJob.completed_at ?? currentJob.created_at).slice(0, 10)}.sabk.json`;
        const disposition = res.headers.get('Content-Disposition') ?? res.headers.get('content-disposition');
        if (disposition) {
          const match = /filename="([^"]+)"/.exec(disposition);
          if (match?.[1]) {
            filename = match[1];
          }
        }

        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const objUrl = URL.createObjectURL(blob);
          try {
            const tempLink = document.createElement('a');
            tempLink.href = objUrl;
            tempLink.download = filename;
            tempLink.style.display = 'none';
            document.body.appendChild(tempLink);
            tempLink.click();
            document.body.removeChild(tempLink);
          } finally {
            URL.revokeObjectURL(objUrl);
          }
        }
      } catch {
        if (!mountedRef.current) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setViewState('exp-offline');
        } else {
          setViewState('exp-failed');
        }
      } finally {
        if (mountedRef.current) {
          setBusy(false);
        }
      }
    },
    [busy, currentJob, now, refreshLatest],
  );

  const docsHref = locale === 'vi' ? '/vi/docs#du-lieu' : '/docs#du-lieu';
  const rawProcessed = currentJob?.items_processed ?? 0;
  const rawTotal = currentJob?.items_total ?? 0;
  const formattedSize = formatBackupFileSize(currentJob?.size_bytes, locale);
  const expiryText = currentJob?.expires_at
    ? formatExpiryClock(currentJob.expires_at, now(), locale)
    : '';
  const defaultDownloadFilename = currentJob
    ? `engram-backup-${(currentJob.completed_at ?? currentJob.created_at).slice(0, 10)}.sabk.json`
    : 'engram-backup.sabk.json';

  return (
    <div className="card mb-3 p-5" data-testid="encrypted-backup-card">
      <div className="mb-1 text-[15px] font-semibold text-body">{t('backup.title')}</div>
      <p className="m-0 mb-4 text-[13px] text-body">{t('backup.body')}</p>

      {viewState === 'exp-idle' && (
        <section data-view="exp-idle">
          <Button
            type="button"
            variant="primary"
            data-testid="export-encrypted-start-btn"
            disabled={busy}
            onClick={() => void handleStartBackup()}
          >
            {t('backup.startButton')}
          </Button>
        </section>
      )}

      {viewState === 'exp-preparing' && (
        <section data-view="exp-preparing">
          <div role="status" aria-live="polite" className="auth-status mb-3">
            <span>
              {announcedTotal > 0
                ? t('backup.preparingStatus', {
                    processed: announcedProcessed,
                    total: announcedTotal,
                  })
                : t('backup.preparingIndeterminate')}
            </span>
            <progress
              className="mt-2 block w-full"
              max={rawTotal > 0 ? rawTotal : 1}
              value={rawTotal > 0 ? Math.min(rawProcessed, rawTotal) : 0}
              aria-label={t('backup.progressLabel')}
            />
          </div>
          <p className="m-0 mb-3 text-[12px] text-muted">{t('backup.preparingHint')}</p>
          <Button
            type="button"
            variant="tertiary"
            data-testid="export-encrypted-cancel-btn"
            disabled={busy}
            onClick={() => void handleCancelBackup()}
          >
            {t('backup.cancelButton')}
          </Button>
        </section>
      )}

      {viewState === 'exp-ready' && currentJob && (
        <section data-view="exp-ready">
          <div role="status" className="auth-status mb-3">
            {t('backup.readyStatus', { expiry: expiryText })}
          </div>
          <a
            href={downloadUrl(currentJob.id)}
            download={defaultDownloadFilename}
            className="btn btn-primary touch-target no-underline"
            data-testid="export-encrypted-download-link"
            onClick={(e) => void handleDownloadClick(e)}
          >
            {formattedSize
              ? t('backup.downloadFileButton', { size: formattedSize })
              : t('backup.downloadFileButtonNoSize')}
          </a>
        </section>
      )}

      {viewState === 'exp-failed' && (
        <section data-view="exp-failed">
          <div role="alert" className="auth-alert mb-3">
            {t('backup.failedAlert')}
          </div>
          <Button
            type="button"
            variant="primary"
            data-testid="export-encrypted-start-btn"
            disabled={busy}
            onClick={() => void handleStartBackup()}
          >
            {t('backup.retryButton')}
          </Button>
        </section>
      )}

      {viewState === 'exp-expired' && (
        <section data-view="exp-expired">
          <div role="status" className="auth-status mb-3">
            {t('backup.expiredStatus')}
          </div>
          <Button
            type="button"
            variant="primary"
            data-testid="export-encrypted-start-btn"
            disabled={busy}
            onClick={() => void handleStartBackup()}
          >
            {t('backup.newBackupButton')}
          </Button>
        </section>
      )}

      {viewState === 'exp-limit' && (
        <section data-view="exp-limit">
          <div id={limitAlertId} role="alert" className="auth-warning mb-3">
            {isPausedLimit
              ? t('backup.pausedWarning', { clock: limitClock })
              : t('backup.limitWarning', { clock: limitClock })}
          </div>
          <Button
            type="button"
            variant="primary"
            data-testid="export-encrypted-start-btn"
            disabled
            aria-describedby={limitAlertId}
          >
            {t('backup.startButton')}
          </Button>
        </section>
      )}

      {viewState === 'exp-offline' && (
        <section data-view="exp-offline">
          <div id={offlineStatusId} role="status" className="auth-status mb-3">
            {t('backup.offlineStatus')}
          </div>
          <Button
            type="button"
            variant="primary"
            data-testid="export-encrypted-start-btn"
            disabled
            aria-describedby={offlineStatusId}
          >
            {t('backup.startButton')}
          </Button>
        </section>
      )}

      <details className="mt-4 text-[13px]">
        <summary className="min-h-[24px] cursor-pointer py-1 text-body">
          {t('backup.detailsSummary')}
        </summary>
        <ul className="mt-2 mb-0 list-disc pl-5 text-muted">
          <li>{t('backup.detailsItem1')}</li>
          <li>{t('backup.detailsItem2')}</li>
          <li>{t('backup.detailsItem3')}</li>
          <li>{t('backup.detailsItem4')}</li>
        </ul>
        <p className="m-0 mt-2">
          <Link href={docsHref} className="text-link text-[13px]">
            {t('docsLink')}
          </Link>
        </p>
      </details>

      <hr className="rule my-4" />
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 flex-1 basis-[240px] text-[13px] text-muted">
          {t('backup.readablePrompt')}
        </p>
        <Button
          type="button"
          variant="tertiary"
          size="sm"
          className="!whitespace-normal text-left"
          data-testid="export-readable-open-btn"
          onClick={(e) => {
            readableTriggerRef.current = e.currentTarget;
            onOpenReadableExport?.(e.currentTarget);
          }}
        >
          {t('backup.readableOpenButton')}
        </Button>
      </div>
    </div>
  );
}
