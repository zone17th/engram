'use client';

import { useEffect, useState } from 'react';

function secondsUntil(deadline: number | null): number {
  if (deadline === null || !Number.isFinite(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** Re-render from a deadline so a server Retry-After remains an actual countdown. */
export function useRetryCountdown(deadline: number | null): number {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (deadline === null || !Number.isFinite(deadline)) return;

    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      if (Date.now() >= deadline) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [deadline]);

  return secondsUntil(deadline);
}
