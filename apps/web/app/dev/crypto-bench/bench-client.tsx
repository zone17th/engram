'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BenchResultMessage,
  BenchStartMessage,
  BenchWorkerOutboundMessage,
} from '@/lib/crypto/bench.worker';

export interface BenchWorkerLike {
  postMessage: (message: BenchStartMessage) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<BenchWorkerOutboundMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface CryptoBenchClientProps {
  createWorker?: () => BenchWorkerLike;
}

interface HostEnvironmentSnapshot {
  userAgent: string;
  deviceMemory?: number;
  hardwareConcurrency: number | null;
  crossOriginIsolated: boolean;
}

function readHostEnvironment(): HostEnvironmentSnapshot {
  if (typeof navigator === 'undefined') {
    return {
      userAgent: '',
      hardwareConcurrency: null,
      crossOriginIsolated: false,
    };
  }
  const rawDeviceMemory: unknown =
    'deviceMemory' in navigator ? Reflect.get(navigator, 'deviceMemory') : undefined;
  const deviceMemory =
    typeof rawDeviceMemory === 'number' && Number.isFinite(rawDeviceMemory)
      ? rawDeviceMemory
      : undefined;
  const hardwareConcurrency =
    typeof navigator.hardwareConcurrency === 'number' &&
    Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : null;
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false;

  return {
    userAgent: navigator.userAgent,
    ...(deviceMemory !== undefined ? { deviceMemory } : {}),
    hardwareConcurrency,
    crossOriginIsolated,
  };
}

function defaultCreateBenchWorker(): BenchWorkerLike {
  return new Worker(new URL('../../../lib/crypto/bench.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export function CryptoBenchClient({ createWorker = defaultCreateBenchWorker }: CryptoBenchClientProps = {}) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [envInfo, setEnvInfo] = useState<HostEnvironmentSnapshot>({
    userAgent: '',
    hardwareConcurrency: null,
    crossOriginIsolated: false,
  });
  const [hasClipboardApi, setHasClipboardApi] = useState<boolean>(true);
  const [result, setResult] = useState<BenchResultMessage | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const workerRef = useRef<BenchWorkerLike | null>(null);
  const activeRunIdRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(false);

  const terminateCurrentWorker = useCallback(() => {
    const prev = workerRef.current;
    workerRef.current = null;
    if (prev) {
      prev.onmessage = null;
      prev.onerror = null;
      try {
        prev.terminate();
      } catch {
        // Ignore worker termination errors
      }
    }
  }, []);

  const runBench = useCallback(() => {
    terminateCurrentWorker();
    const runId = activeRunIdRef.current + 1;
    activeRunIdRef.current = runId;

    setStatus('running');
    setResult(null);
    setWorkerError(null);
    setCopied(false);

    const worker = createWorker();
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<BenchWorkerOutboundMessage>) => {
      if (!mountedRef.current || activeRunIdRef.current !== runId || workerRef.current !== worker) {
        return;
      }
      const data = event.data;
      if (!data) return;
      if (data.runId !== undefined && data.runId !== runId) {
        return;
      }
      if (data.type === 'benchResult') {
        setResult(data);
        setStatus('done');
        terminateCurrentWorker();
      } else if (data.type === 'benchError') {
        const codePart = data.errorCode ? `${data.errorCode} / ` : '';
        const ctorPart =
          data.errorConstructorName && data.errorConstructorName !== data.errorName
            ? ` [constructor=${data.errorConstructorName}]`
            : ` [constructor=${data.errorConstructorName || data.errorName}]`;
        setWorkerError(`${codePart}${data.errorName}${ctorPart}: ${data.errorMessage}`);
        setStatus('error');
        terminateCurrentWorker();
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      if (!mountedRef.current || activeRunIdRef.current !== runId || workerRef.current !== worker) {
        return;
      }
      const rawErr: unknown = event.error;
      const errName =
        rawErr instanceof Error
          ? rawErr.name
          : typeof rawErr === 'object' &&
              rawErr !== null &&
              'name' in rawErr &&
              typeof rawErr.name === 'string'
            ? rawErr.name
            : 'WorkerError';
      let ctorName = errName;
      if (typeof rawErr === 'object' && rawErr !== null) {
        const ctor: unknown = Reflect.get(rawErr, 'constructor');
        if (typeof ctor === 'function' && ctor.name) {
          ctorName = ctor.name;
        }
      }
      setWorkerError(
        `${errName} [constructor=${ctorName}]: ${event.message || 'Worker failed'}`,
      );
      setStatus('error');
      terminateCurrentWorker();
    };

    const startMsg: BenchStartMessage = { type: 'startBench', runId, runs: 3 };
    worker.postMessage(startMsg);
  }, [createWorker, terminateCurrentWorker]);

  useEffect(() => {
    mountedRef.current = true;
    setEnvInfo(readHostEnvironment());
    setHasClipboardApi(
      typeof navigator !== 'undefined' &&
        Boolean(navigator.clipboard) &&
        typeof navigator.clipboard.writeText === 'function',
    );
    runBench();

    return () => {
      mountedRef.current = false;
      activeRunIdRef.current += 1;
      terminateCurrentWorker();
    };
  }, [runBench, terminateCurrentWorker]);

  const reportPayload = result
    ? JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          userAgent: envInfo.userAgent,
          ...(envInfo.deviceMemory !== undefined ? { deviceMemory: envInfo.deviceMemory } : {}),
          hardwareConcurrency: envInfo.hardwareConcurrency,
          crossOriginIsolated: envInfo.crossOriginIsolated,
          params: result.params,
          allSucceeded: result.allSucceeded,
          medianMs: result.medianMs,
          p95Ms: result.p95Ms,
          runs: result.runs,
        },
        null,
        2,
      )
    : workerError
      ? JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            userAgent: envInfo.userAgent,
            ...(envInfo.deviceMemory !== undefined ? { deviceMemory: envInfo.deviceMemory } : {}),
            hardwareConcurrency: envInfo.hardwareConcurrency,
            crossOriginIsolated: envInfo.crossOriginIsolated,
            allSucceeded: false,
            workerError,
          },
          null,
          2,
        )
      : '';

  const handleCopy = async () => {
    if (!reportPayload) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setHasClipboardApi(false);
      setCopied(false);
      return;
    }
    try {
      await navigator.clipboard.writeText(reportPayload);
      setCopied(true);
    } catch {
      setHasClipboardApi(false);
      setCopied(false);
    }
  };

  return (
    <main style={{ fontFamily: 'monospace', padding: '16px', maxWidth: '720px' }}>
      <h1>engram P03-T5 Argon2id Worker Benchmark (Dev-Only)</h1>
      <p>
        Params: <code>alg=argon2id13, ops=3, mem=67108864 (64 MiB), parallelism=1, runs=3</code>
      </p>
      <p data-testid="bench-ua">
        <strong>User-Agent:</strong> {envInfo.userAgent || 'loading...'}
      </p>
      <p data-testid="bench-env">
        <strong>hardwareConcurrency:</strong> {String(envInfo.hardwareConcurrency ?? 'N/A')} |{' '}
        <strong>deviceMemory:</strong>{' '}
        {envInfo.deviceMemory !== undefined ? `${envInfo.deviceMemory} GB` : 'N/A'} |{' '}
        <strong>crossOriginIsolated:</strong> {String(envInfo.crossOriginIsolated)}
      </p>
      <p data-testid="bench-status">
        <strong>Status:</strong> {status}
      </p>

      <div style={{ marginBottom: '12px' }}>
        <button
          type="button"
          onClick={runBench}
          disabled={status === 'running'}
          data-testid="rerun-bench-btn"
        >
          Re-run benchmark
        </button>{' '}
        {hasClipboardApi && (
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={!reportPayload}
            data-testid="copy-result-btn"
          >
            {copied ? 'Copied!' : 'Copy result'}
          </button>
        )}
      </div>

      {result && (
        <section>
          <h2>Runs</h2>
          <ul>
            {result.runs.map((r) => (
              <li key={r.run} data-testid={`bench-run-${r.run}`}>
                Run #{r.run}: {r.ms} ms —{' '}
                {r.ok
                  ? 'SUCCESS'
                  : `FAILED (code=${r.errorCode ?? 'UNKNOWN_ERROR'} | name=${r.errorName ?? 'Error'} | constructor=${r.errorConstructorName ?? r.errorName ?? 'Error'}: ${r.errorMessage ?? ''})`}
              </li>
            ))}
          </ul>
          <p>
            <strong>Median:</strong> {result.medianMs ?? 'N/A'} ms | <strong>p95:</strong>{' '}
            {result.p95Ms ?? 'N/A'} ms | <strong>All Succeeded:</strong>{' '}
            {String(result.allSucceeded)}
          </p>
        </section>
      )}

      {workerError && (
        <p data-testid="bench-worker-error" style={{ color: 'red' }}>
          Worker error: {workerError}
        </p>
      )}

      <h2>Copy Result Block</h2>
      {!hasClipboardApi && (
        <div>
          <p data-testid="bench-clipboard-fallback-hint">
            Clipboard API unavailable on plain-HTTP LAN. Tap inside the box below, choose{' '}
            <strong>Select All</strong>, then <strong>Copy</strong>:
          </p>
          <textarea
            readOnly
            data-testid="bench-result-textarea"
            value={reportPayload}
            rows={16}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              width: '100%',
              fontFamily: 'monospace',
              padding: '12px',
              border: '1px solid #888',
              marginBottom: '12px',
            }}
          />
        </div>
      )}
      <pre
        data-testid="bench-result-json"
        style={{
          padding: '12px',
          border: '1px solid #888',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {reportPayload || 'Running Argon2id 64 MiB x 3 in dedicated Web Worker...'}
      </pre>
    </main>
  );
}
