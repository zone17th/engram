'use client';

import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
    },
  ) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

function getTurnstile(): TurnstileApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onExpire,
  resetSignal = 0,
}: {
  siteKey: string | null | undefined;
  onToken: (token: string) => void;
  onExpire?: () => void;
  resetSignal?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const key = siteKey?.trim() || null;

  useEffect(() => {
    let cancelled = false;
    let script: HTMLScriptElement | null = null;
    let onLoad: (() => void) | null = null;

    if (!key) {
      return () => {
        cancelled = true;
      };
    }

    const renderWidget = () => {
      const api = getTurnstile();
      const host = hostRef.current;
      if (cancelled || !api || !host) return;
      if (widgetId.current) {
        api.remove(widgetId.current);
        widgetId.current = null;
      }
      widgetId.current = api.render(host, {
        sitekey: key,
        callback: onToken,
        'expired-callback': () => onExpire?.(),
        'error-callback': () => onExpire?.(),
        theme: 'auto',
      });
    };

    const api = getTurnstile();
    if (api) {
      renderWidget();
    } else if (typeof document !== 'undefined') {
      const existing = document.querySelector<HTMLScriptElement>('script[data-engram-turnstile]');
      onLoad = () => renderWidget();
      if (existing) {
        script = existing;
        existing.addEventListener('load', onLoad);
      } else {
        script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.dataset.engramTurnstile = '1';
        script.addEventListener('load', onLoad);
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (script && onLoad) script.removeEventListener('load', onLoad);
      const current = widgetId.current;
      const turnstile = getTurnstile();
      if (current && turnstile) {
        turnstile.remove(current);
        widgetId.current = null;
      }
    };
  }, [key, onExpire, onToken]);

  const lastResetSignal = useRef(resetSignal);
  useEffect(() => {
    if (lastResetSignal.current === resetSignal) return;
    lastResetSignal.current = resetSignal;
    const current = widgetId.current;
    const turnstile = getTurnstile();
    if (current && turnstile) turnstile.reset(current);
  }, [resetSignal]);

  return (
    <div
      className="rounded-md border border-dashed border-lineStrong p-4 text-[13px] text-muted"
      data-testid="turnstile-widget"
      data-configured={key ? 'true' : 'false'}
    >
      <div ref={hostRef} />
    </div>
  );
}
