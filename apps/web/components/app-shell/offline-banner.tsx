'use client';

import { QueryClientContext } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useContext, useEffect, useRef, useState } from 'react';

const RECONNECTED_VISIBLE_MS = 5000;
const OFFLINE_RECHECK_MS = 10_000;

function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

/**
 * U18 `#off` / `#off-reconnected` (F-08): one global banner for every app screen.
 *
 * - Offline: neutral-orange `role="status"` banner ("You're offline… changes are not saved"). It is a live region, not an
 *   alert: losing the connection is a state, not an error.
 * - Automatic retry: the `online` event, and a cheap re-check of `navigator.onLine` every 10 s while offline (events can
 *   be missed after sleep), both end in a refetch of every active query. TanStack's `onlineManager` is not used because
 *   it ignores `navigator.onLine`.
 * - Back online: a short "Back online. Your list has been refreshed." note, then it disappears.
 */
export function OfflineBanner() {
  const t = useTranslations('offline');
  const queryClient = useContext(QueryClientContext);
  const [online, setOnline] = useState(true);
  const [showReconnected, setShowReconnected] = useState(false);
  const wasOffline = useRef(false);

  useEffect(() => {
    const sync = () => setOnline(readOnline());
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  useEffect(() => {
    if (online) return;
    const timer = window.setInterval(() => setOnline(readOnline()), OFFLINE_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [online]);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setShowReconnected(false);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setShowReconnected(true);
    void queryClient?.invalidateQueries();
    const timer = window.setTimeout(() => setShowReconnected(false), RECONNECTED_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [online, queryClient]);

  // M-3: the live region is always mounted (empty when idle) and only its content changes, because screen readers
  // announce changes inside an existing live region far more reliably than the insertion of a populated one.
  const showBanner = !online || showReconnected;
  return (
    <div role="status" aria-live="polite" data-testid="offline-live">
      {showBanner ? (
        <div
          data-testid={online ? 'offline-reconnected' : 'offline-banner'}
          className={`px-5 py-3 text-[13px] text-body ${online ? 'bg-surface' : 'bg-paleOrange'}`}
        >
          <p className="mx-auto m-0 max-w-container">
            <strong>{online ? t('reconnectedTitle') : t('bannerTitle')}</strong>{' '}
            {online ? t('reconnectedBody') : t('bannerBody')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
