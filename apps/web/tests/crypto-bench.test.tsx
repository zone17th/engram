import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoBenchClient,
  type BenchWorkerLike,
} from '../app/dev/crypto-bench/bench-client';
import {
  attachBenchWorkerScope,
  extractErrorSignature,
  runArgon2idBenchmark,
  type BenchResultMessage,
  type BenchStartMessage,
  type BenchWorkerOutboundMessage,
  type BenchWorkerScopeLike,
} from '../lib/crypto/bench.worker';
import { deriveKek, KdfError } from '../lib/crypto/kdf';
import { getSodium, type Sodium } from '../lib/crypto/sodium';

class CountingBenchWorker implements BenchWorkerLike {
  static instances: CountingBenchWorker[] = [];

  onmessage: ((event: MessageEvent<BenchWorkerOutboundMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  postedMessages: BenchStartMessage[] = [];

  constructor() {
    CountingBenchWorker.instances.push(this);
  }

  static reset(): void {
    CountingBenchWorker.instances = [];
  }

  static activeCount(): number {
    return CountingBenchWorker.instances.filter((w) => !w.terminated).length;
  }

  postMessage(message: BenchStartMessage): void {
    this.postedMessages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: BenchWorkerOutboundMessage): void {
    this.onmessage?.({ data } as MessageEvent<BenchWorkerOutboundMessage>);
  }
}

function makeBenchResult(overrides: Partial<BenchResultMessage> = {}): BenchResultMessage {
  return {
    type: 'benchResult',
    params: {
      alg: 'argon2id13',
      ops: 3,
      mem: 67_108_864,
      parallelism: 1,
      runs: 3,
    },
    runs: [
      { run: 1, ms: 120.5, ok: true },
      { run: 2, ms: 118.2, ok: true },
      { run: 3, ms: 119.0, ok: true },
    ],
    medianMs: 119.0,
    p95Ms: 120.5,
    allSucceeded: true,
    ...overrides,
  };
}

afterEach(() => {
  CountingBenchWorker.reset();
  vi.unstubAllGlobals();
});

describe('CryptoBenchClient (dev benchmark page lifecycle & diagnostics)', () => {
  it('maintains exactly one active Worker under React StrictMode replay, zero after unmount, and discards stale updates (BE1-10, BE1-21, BE1-30, FE1-15)', () => {
    const createWorker = () => new CountingBenchWorker();

    const { unmount } = render(
      <StrictMode>
        <CryptoBenchClient createWorker={createWorker} />
      </StrictMode>,
    );

    // StrictMode mounts, unmounts, and remounts the effect:
    // Worker #1 must be terminated by cleanup, leaving only the latest Worker active.
    expect(CountingBenchWorker.instances.length).toBeGreaterThanOrEqual(2);
    expect(CountingBenchWorker.activeCount()).toBe(1);

    const firstWorker = CountingBenchWorker.instances[0]!;
    const activeWorker = CountingBenchWorker.instances[CountingBenchWorker.instances.length - 1]!;
    expect(firstWorker.terminated).toBe(true);
    expect(activeWorker.terminated).toBe(false);

    const activeRunId = activeWorker.postedMessages[0]?.runId;
    expect(typeof activeRunId).toBe('number');

    // Attempt a stale result update from the terminated first worker or an older runId
    act(() => {
      firstWorker.emitMessage(
        makeBenchResult({
          runId: firstWorker.postedMessages[0]?.runId ?? 1,
          medianMs: 9999,
        }),
      );
      activeWorker.emitMessage(
        makeBenchResult({
          runId: (activeRunId ?? 2) - 1,
          medianMs: 8888,
        }),
      );
    });

    expect(screen.getByTestId('bench-status')).toHaveTextContent('Status: running');
    expect(screen.queryByText(/9999/)).toBeNull();
    expect(screen.queryByText(/8888/)).toBeNull();

    // Trigger a manual replacement via the Re-run path before completion by completing first, then clicking Re-run
    act(() => {
      activeWorker.emitMessage(
        makeBenchResult({
          runId: activeRunId,
          medianMs: 142.3,
          p95Ms: 150.1,
        }),
      );
    });

    expect(screen.getByTestId('bench-status')).toHaveTextContent('Status: done');
    expect(activeWorker.terminated).toBe(true);
    expect(CountingBenchWorker.activeCount()).toBe(0);

    // Clicking Re-run spawns a new Worker and any late reply from the previous runId is ignored
    act(() => {
      fireEvent.click(screen.getByTestId('rerun-bench-btn'));
    });

    expect(CountingBenchWorker.activeCount()).toBe(1);
    const rerunWorker = CountingBenchWorker.instances[CountingBenchWorker.instances.length - 1]!;
    expect(rerunWorker).not.toBe(activeWorker);
    expect(rerunWorker.terminated).toBe(false);

    // Unmount while the re-run Worker is still running -> zero active Workers and no state update on late message
    unmount();
    expect(rerunWorker.terminated).toBe(true);
    expect(CountingBenchWorker.activeCount()).toBe(0);

    expect(() => {
      rerunWorker.emitMessage(
        makeBenchResult({
          runId: rerunWorker.postedMessages[0]?.runId,
          medianMs: 7777,
        }),
      );
    }).not.toThrow();
  });

  it('prints per-run error code, name, constructor.name, message, and host environment metadata in the result block (FE1-14)', () => {
    Object.defineProperty(window.navigator, 'deviceMemory', {
      configurable: true,
      value: 4,
    });
    Object.defineProperty(window.navigator, 'hardwareConcurrency', {
      configurable: true,
      value: 6,
    });
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: false,
    });

    render(<CryptoBenchClient createWorker={() => new CountingBenchWorker()} />);

    const worker = CountingBenchWorker.instances[CountingBenchWorker.instances.length - 1]!;
    const runId = worker.postedMessages[0]?.runId;

    act(() => {
      worker.emitMessage(
        makeBenchResult({
          runId,
          allSucceeded: false,
          medianMs: 165.4,
          p95Ms: 165.4,
          runs: [
            { run: 1, ms: 165.4, ok: true },
            {
              run: 2,
              ms: 12.8,
              ok: false,
              errorCode: 'KDF_ALLOCATION_FAILED',
              errorName: 'RangeError',
              errorConstructorName: 'WebAssemblyInstantiationError',
              errorMessage: 'WebAssembly.Memory(): could not allocate memory',
              errorCauseName: 'RangeError',
              errorCauseConstructorName: 'WebAssemblyInstantiationError',
              errorCauseMessage: 'WebAssembly.Memory(): could not allocate memory',
            },
          ],
        }),
      );
    });

    expect(screen.getByTestId('bench-run-2')).toHaveTextContent(
      'FAILED (code=KDF_ALLOCATION_FAILED | name=RangeError | constructor=WebAssemblyInstantiationError: WebAssembly.Memory(): could not allocate memory)',
    );
    const jsonText = screen.getByTestId('bench-result-json').textContent ?? '';
    const parsed = JSON.parse(jsonText) as {
      userAgent: string;
      deviceMemory?: number;
      hardwareConcurrency: number | null;
      crossOriginIsolated: boolean;
      allSucceeded: boolean;
      runs: Array<{
        run: number;
        ok: boolean;
        errorCode?: string;
        errorName?: string;
        errorConstructorName?: string;
        errorMessage?: string;
      }>;
    };

    expect(parsed.userAgent).toBe(window.navigator.userAgent);
    expect(parsed.deviceMemory).toBe(4);
    expect(parsed.hardwareConcurrency).toBe(6);
    expect(parsed.crossOriginIsolated).toBe(false);
    expect(parsed.allSucceeded).toBe(false);
    expect(parsed.runs[1]).toEqual({
      run: 2,
      ms: 12.8,
      ok: false,
      errorCode: 'KDF_ALLOCATION_FAILED',
      errorName: 'RangeError',
      errorConstructorName: 'WebAssemblyInstantiationError',
      errorMessage: 'WebAssembly.Memory(): could not allocate memory',
      errorCauseName: 'RangeError',
      errorCauseConstructorName: 'WebAssemblyInstantiationError',
      errorCauseMessage: 'WebAssembly.Memory(): could not allocate memory',
    });
  });

  it('renders a readonly textarea fallback with select-all hint when navigator.clipboard is missing on plain-HTTP LAN (FE1-30)', () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    render(<CryptoBenchClient createWorker={() => new CountingBenchWorker()} />);

    const worker = CountingBenchWorker.instances[CountingBenchWorker.instances.length - 1]!;
    act(() => {
      worker.emitMessage(makeBenchResult({ runId: worker.postedMessages[0]?.runId }));
    });

    expect(screen.queryByTestId('copy-result-btn')).toBeNull();
    expect(screen.getByTestId('bench-clipboard-fallback-hint')).toHaveTextContent(
      /Select All/i,
    );

    const textarea = screen.getByTestId('bench-result-textarea') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('readonly');
    expect(textarea.value).toContain('"alg": "argon2id13"');
  });
});

describe('bench.worker diagnostics & execution guards (FE2-3, FE2-11g)', () => {
  it('records underlying cause errorName, constructor.name, and message beside KDF_* code for RangeError, plain Error, and WebAssembly.RuntimeError without leaking passphrase (FE2-3)', async () => {
    const realSodium = await getSodium();

    // 1. RangeError thrown inside deriveKek -> KdfError(KDF_ALLOCATION_FAILED, { cause: RangeError })
    const rangeRes = await runArgon2idBenchmark(1, 101, {
      getSodium: async () => realSodium,
      deriveKek: (sodium, passphrase, params) =>
        deriveKek(sodium, passphrase, params, () => {
          throw new RangeError('WebAssembly.Memory(): could not allocate memory');
        }),
    });
    expect(rangeRes.allSucceeded).toBe(false);
    expect(rangeRes.runs).toHaveLength(1);
    expect(rangeRes.runs[0]).toMatchObject({
      run: 1,
      ok: false,
      errorCode: 'KDF_ALLOCATION_FAILED',
      errorName: 'RangeError',
      errorConstructorName: 'RangeError',
      errorMessage: 'WebAssembly.Memory(): could not allocate memory',
      errorCauseName: 'RangeError',
      errorCauseConstructorName: 'RangeError',
      errorCauseMessage: 'WebAssembly.Memory(): could not allocate memory',
    });
    expect(JSON.stringify(rangeRes)).not.toContain('engram-p03-t5-bench-run');

    // 2. Plain Error thrown inside deriveKek -> KdfError(KDF_DERIVE_FAILED, { cause: Error })
    const plainRes = await runArgon2idBenchmark(1, 102, {
      getSodium: async () => realSodium,
      deriveKek: (sodium, passphrase, params) =>
        deriveKek(sodium, passphrase, params, () => {
          throw new Error('invalid usage');
        }),
    });
    expect(plainRes.allSucceeded).toBe(false);
    expect(plainRes.runs[0]).toMatchObject({
      run: 1,
      ok: false,
      errorCode: 'KDF_DERIVE_FAILED',
      errorName: 'Error',
      errorConstructorName: 'Error',
      errorMessage: 'invalid usage',
      errorCauseName: 'Error',
      errorCauseConstructorName: 'Error',
      errorCauseMessage: 'invalid usage',
    });
    expect(JSON.stringify(plainRes)).not.toContain('engram-p03-t5-bench-run');

    // 3. WebAssembly.RuntimeError thrown inside deriveKek -> KdfError(KDF_ALLOCATION_FAILED, { cause: WebAssembly.RuntimeError })
    expect(typeof WebAssembly?.RuntimeError).toBe('function');
    const wasmErr = new WebAssembly.RuntimeError('memory access out of bounds');
    const wasmRes = await runArgon2idBenchmark(1, 103, {
      getSodium: async () => realSodium,
      deriveKek: (sodium, passphrase, params) =>
        deriveKek(sodium, passphrase, params, () => {
          throw wasmErr;
        }),
    });
    expect(wasmRes.allSucceeded).toBe(false);
    expect(wasmRes.runs[0]).toMatchObject({
      run: 1,
      ok: false,
      errorCode: 'KDF_ALLOCATION_FAILED',
      errorName: wasmErr.name,
      errorConstructorName: 'RuntimeError',
      errorMessage: 'memory access out of bounds',
      errorCauseName: wasmErr.name,
      errorCauseConstructorName: 'RuntimeError',
      errorCauseMessage: 'memory access out of bounds',
    });
    expect(JSON.stringify(wasmRes)).not.toContain('engram-p03-t5-bench-run');

    // Direct extractErrorSignature check for KdfError without a cause
    const bareKdfSig = extractErrorSignature(new KdfError('KDF_PARAMS_INVALID', 'bad params'));
    expect(bareKdfSig).toEqual({
      errorCode: 'KDF_PARAMS_INVALID',
      errorName: 'KdfError',
      errorConstructorName: 'KdfError',
      errorMessage: 'bad params',
    });
  });

  it('clamps out-of-range or non-integer runsCount to 3 and accepts valid bounds 1..20 (FE2-11g)', async () => {
    const realSodium = await getSodium();
    const fastStub = {
      getSodium: async () => realSodium,
      deriveKek: () => new Uint8Array(32),
    };

    for (const invalidCount of [0, -1, 21, 100, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await runArgon2idBenchmark(invalidCount, undefined, fastStub);
      expect(res.params.runs).toBe(3);
      expect(res.runs).toHaveLength(3);
      expect(res.allSucceeded).toBe(true);
    }

    const minRes = await runArgon2idBenchmark(1, undefined, fastStub);
    expect(minRes.params.runs).toBe(1);
    expect(minRes.runs).toHaveLength(1);
    expect(minRes.allSucceeded).toBe(true);

    const maxRes = await runArgon2idBenchmark(20, undefined, fastStub);
    expect(maxRes.params.runs).toBe(20);
    expect(maxRes.runs).toHaveLength(20);
    expect(maxRes.allSucceeded).toBe(true);
  });

  it('hoists getSodium() once before the timed run loop and falls back per-run only if preload rejects (FE2-11g)', async () => {
    const realSodium = await getSodium();
    const getSodiumSuccessSpy = vi.fn<() => Promise<Sodium>>().mockResolvedValue(realSodium);

    const okRes = await runArgon2idBenchmark(3, 201, {
      getSodium: getSodiumSuccessSpy,
      deriveKek: () => new Uint8Array(32),
    });
    expect(okRes.allSucceeded).toBe(true);
    expect(okRes.runs).toHaveLength(3);
    expect(getSodiumSuccessSpy).toHaveBeenCalledTimes(1);

    // When the hoisted getSodium() rejects, each run attempts loadSodium() so per-run error signatures are recorded
    const getSodiumFailSpy = vi
      .fn<() => Promise<Sodium>>()
      .mockRejectedValue(new Error('WASM instantiate failed'));

    const failRes = await runArgon2idBenchmark(2, 202, {
      getSodium: getSodiumFailSpy,
      deriveKek: () => new Uint8Array(32),
    });
    expect(failRes.allSucceeded).toBe(false);
    expect(failRes.runs).toHaveLength(2);
    expect(getSodiumFailSpy).toHaveBeenCalledTimes(3); // 1 preload + 2 per-run attempts
    expect(failRes.runs[0]).toMatchObject({
      run: 1,
      ok: false,
      errorCode: 'UNKNOWN_ERROR',
      errorName: 'Error',
      errorConstructorName: 'Error',
      errorMessage: 'WASM instantiate failed',
    });
  });

  it('posts benchError when the benchmark runner rejects in the Worker onmessage .catch handler (FE2-11g)', async () => {
    const posted: BenchWorkerOutboundMessage[] = [];
    const fakeScope: BenchWorkerScopeLike = {
      onmessage: null,
      postMessage: (msg) => {
        posted.push(msg);
      },
    };

    const rejectingRunner = vi.fn().mockRejectedValue(
      new KdfError('KDF_ALLOCATION_FAILED', 'WASM OOM', {
        cause: new RangeError('Out of memory'),
      }),
    );

    attachBenchWorkerScope(fakeScope, rejectingRunner);
    expect(typeof fakeScope.onmessage).toBe('function');

    // Non-startBench messages are ignored
    fakeScope.onmessage!({
      data: { type: 'other' } as unknown as BenchStartMessage,
    } as MessageEvent<BenchStartMessage>);
    expect(rejectingRunner).not.toHaveBeenCalled();

    // Trigger startBench -> runner rejects -> .catch posts benchError with unwrapped cause signature
    fakeScope.onmessage!({
      data: { type: 'startBench', runId: 77, runs: 3 },
    } as MessageEvent<BenchStartMessage>);

    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toEqual({
      type: 'benchError',
      runId: 77,
      errorCode: 'KDF_ALLOCATION_FAILED',
      errorName: 'RangeError',
      errorConstructorName: 'RangeError',
      errorMessage: 'Out of memory',
      errorCauseName: 'RangeError',
      errorCauseConstructorName: 'RangeError',
      errorCauseMessage: 'Out of memory',
    });
  });
});
