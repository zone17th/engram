import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasWebLocks, withSessionLock } from '@/lib/auth/session-lock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('session lock ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes independent callbacks through the browser lock', async () => {
    const gate = deferred<void>();
    const callbacks: string[] = [];
    let active = false;
    const waiters: Array<() => void> = [];
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
      await new Promise<void>((resolve) => {
        if (!active) {
          active = true;
          resolve();
        } else {
          waiters.push(() => {
            active = true;
            resolve();
          });
        }
      });
      try {
        return await callback();
      } finally {
        active = false;
        waiters.shift()?.();
      }
    });
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });

    const first = withSessionLock(async () => {
      callbacks.push('first-start');
      await gate.promise;
      callbacks.push('first-end');
      return 'first';
    });
    const second = withSessionLock(async () => {
      callbacks.push('second-start');
      callbacks.push('second-end');
      return 'second';
    });
    await Promise.resolve();

    expect(callbacks).toEqual(['first-start']);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(callbacks).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('runs directly in degraded browsers without exposing lock state globally', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    expect(hasWebLocks()).toBe(false);
    await expect(withSessionLock(async () => 'ok')).resolves.toBe('ok');
  });
});
