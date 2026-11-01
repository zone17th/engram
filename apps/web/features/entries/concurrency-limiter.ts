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

  const release = (): void => {
    if (active > 0) {
      active -= 1;
    }
    pump();
  };

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let waiter!: QueuedWaiter;
    const onAbort = () => {
      const idx = queue.indexOf(waiter);
      if (idx !== -1) {
        queue.splice(idx, 1);
      }
      reject(createAbortError(signal));
    };
    const abortCleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    waiter = {
      grant: () => resolve(),
      abortCleanup,
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
    return promise;
  };

  return {
    limit,
    activeCount: () => active,
    pendingCount: () => queue.length,
    async run<T>(
      task: () => Promise<T>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<T> {
      await acquire(options?.signal);
      try {
        if (options?.signal?.aborted) {
          throw createAbortError(options.signal);
        }
        return await task();
      } finally {
        release();
      }
    },
    reset(): void {
      active = 0;
      while (queue.length > 0) {
        const w = queue.shift();
        w?.abortCleanup();
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
