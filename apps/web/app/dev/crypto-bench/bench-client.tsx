'use client';

import { useEffect, useState } from 'react';
import type { BenchResultMessage, BenchStartMessage } from '@/lib/crypto/bench.worker';

export function CryptoBenchClient() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [userAgent, setUserAgent] = useState<string>('');
  const [result, setResult] = useState<BenchResultMessage | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const runBench = () => {
    setStatus('running');
    setResult(null);
    setWorkerError(null);
    setCopied(false);

    const worker = new Worker(new URL('../../../lib/crypto/bench.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<BenchResultMessage>) => {
      if (event.data?.type === 'benchResult') {
        setResult(event.data);
        setStatus('done');
        worker.terminate();
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      setWorkerError(`${event.error?.name ?? 'WorkerError'}: ${event.message || 'Worker failed'}`);
      setStatus('error');
      worker.terminate();
    };

    const startMsg: BenchStartMessage = { type: 'startBench', runs: 3 };
    worker.postMessage(startMsg);
  };

  useEffect(() => {
    setUserAgent(navigator.userAgent);
    runBench();
  }, []);

  const reportPayload = result
    ? JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          userAgent,
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
            userAgent,
            allSucceeded: false,
            workerError,
          },
          null,
          2,
        )
      : '';

  const handleCopy = async () => {
    if (!reportPayload) return;
    try {
      await navigator.clipboard.writeText(reportPayload);
      setCopied(true);
    } catch {
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
        <strong>User-Agent:</strong> {userAgent || 'loading...'}
      </p>
      <p data-testid="bench-status">
        <strong>Status:</strong> {status}
      </p>

      <div style={{ marginBottom: '12px' }}>
        <button type="button" onClick={runBench} disabled={status === 'running'}>
          Re-run benchmark
        </button>{' '}
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!reportPayload}
          data-testid="copy-result-btn"
        >
          {copied ? 'Copied!' : 'Copy result'}
        </button>
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
                  : `FAILED (${r.errorCode ?? 'ERROR'} / ${r.errorName}: ${r.errorMessage})`}
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
