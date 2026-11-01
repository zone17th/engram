export const MAX_CONCURRENT_ENTRY_BODY_LOADS = 4;

export interface ConcurrencyLimiter {
  readonly limit: number;
  readonly activeCount: () => number;
  readonly pendingCount: () => number;
  run: <T>(task: () => Promise<T>, options?: { readonly signal?: AbortSignal }) => Promise<T>;
  reset: () => void;
}

interface QueuedWaiter {
  readonly grant: () => void;
  readonly cancel: (err: Error) => void;
  readonly abortCleanup: () => void;
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Entry body load aborted', 'AbortError');
  }
  const err = new Error('Entry body load aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Local `new Promise` deferred replacement for `Promise.withResolvers`
 * to maintain compatibility with browsers lacking ES2024 `Promise.withResolvers`
 * (Chrome/Edge/Firefox 111, Safari 16.4 — IP14-BE1-4, IP14-FE1-3).
 */
function createDeferredVoid(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Bounded FIFO semaphore limiting concurrent `GET /entries/{id}` + `openEntry` tasks
 * (plan Task 14 item 3 & 4: max 4 concurrent fetch + decrypt).
 */
export function createConcurrencyLimiter(
  limit: number = MAX_CONCURRENT_ENTRY_BODY_LOADS,
): ConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Concurrency limit must be a positive integer.');
  }

  let active = 0;
  let resetGeneration = 0;
  const queue: QueuedWaiter[] = [];

  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      next.abortCleanup();
      active += 1;
      next.grant();
    }
  };

  const release = (slotGeneration: number): void => {
    if (slotGeneration !== resetGeneration) {
      return;
    }
    if (active > 0) {
      active -= 1;
    }
    pump();
  };

  const acquire = (signal?: AbortSignal): Promise<number> => {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    if (active < limit) {
      active += 1;
      return Promise.resolve(resetGeneration);
    }
    const { promise, resolve, reject } = createDeferredVoid();
    let settled = false;
    const abortCleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const waiter: QueuedWaiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        resolve();
      },
      cancel: (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
      abortCleanup,
    };
    function onAbort(): void {
      const idx = queue.indexOf(waiter);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
      waiter.cancel(createAbortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
    return promise.then(() => resetGeneration);
  };

  return {
    limit,
    activeCount: () => active,
    pendingCount: () => queue.length,
    async run<T>(
      task: () => Promise<T>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<T> {
      const slotGeneration = await acquire(options?.signal);
      try {
        if (options?.signal?.aborted || slotGeneration !== resetGeneration) {
          throw createAbortError(options?.signal);
        }
        return await task();
      } finally {
        release(slotGeneration);
      }
    },
    reset(): void {
      resetGeneration += 1;
      active = 0;
      const abortErr = createAbortError();
      while (queue.length > 0) {
        const w = queue.shift();
        if (w) {
          w.abortCleanup();
          w.cancel(abortErr);
        }
      }
    },
  };
}

/**
 * Shared 4-slot concurrency limiter for all real entry body loads in the tab.
 */
export const entryBodyLoadLimiter: ConcurrencyLimiter = createConcurrencyLimiter(
  MAX_CONCURRENT_ENTRY_BODY_LOADS,
);

/**
 * Resets the shared entry body load limiter (used by tests between runs).
 */
export function resetEntryBodyLoadLimiterForTests(): void {
  entryBodyLoadLimiter.reset();
}
