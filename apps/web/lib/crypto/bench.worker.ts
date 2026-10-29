/// <reference lib="webworker" />

import { encodeBase64Url } from './b64url';
import {
  deriveKek,
  KDF_ALG,
  KDF_MEM_MIN,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  type VaultKdfParams,
} from './kdf';
import { getSodium, type Sodium, toLocalBytes } from './sodium';

export interface BenchRunEntry {
  run: number;
  ms: number;
  ok: boolean;
  errorCode?: string;
  errorName?: string;
  errorMessage?: string;
  errorConstructorName?: string;
}

export interface BenchResultMessage {
  type: 'benchResult';
  runId?: number;
  params: {
    alg: typeof KDF_ALG;
    ops: number;
    mem: number;
    parallelism: number;
    runs: number;
  };
  runs: BenchRunEntry[];
  medianMs: number | null;
  p95Ms: number | null;
  allSucceeded: boolean;
}

export interface BenchErrorMessage {
  type: 'benchError';
  runId?: number;
  errorName: string;
  errorMessage: string;
  errorConstructorName: string;
  errorCode?: string;
}

export type BenchWorkerOutboundMessage = BenchResultMessage | BenchErrorMessage;

export interface BenchStartMessage {
  type: 'startBench';
  runId?: number;
  runs?: number;
}
const utf8Encoder = new TextEncoder();

function extractErrorSignature(err: unknown): {
  errorName: string;
  errorMessage: string;
  errorConstructorName: string;
  errorCode: string;
} {
  const errObj = err instanceof Error ? err : new Error(String(err));
  let constructorName = errObj.name;
  if (typeof err === 'object' && err !== null) {
    const ctor: unknown = Reflect.get(err, 'constructor');
    if (typeof ctor === 'function' && ctor.name) {
      constructorName = ctor.name;
    }
  }
  let code = 'UNKNOWN_ERROR';
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    code = err.code;
  }
  return {
    errorName: errObj.name,
    errorMessage: errObj.message,
    errorConstructorName: constructorName,
    errorCode: code,
  };
}

export async function runArgon2idBenchmark(runsCount = 3, runId?: number): Promise<BenchResultMessage> {
  const safeRunsCount =
    Number.isInteger(runsCount) && runsCount >= 1 && runsCount <= 20 ? runsCount : 3;
  const entries: BenchRunEntry[] = [];
  const durations: number[] = [];

  let preloadedSodium: Sodium | null = null;
  try {
    preloadedSodium = await getSodium();
  } catch {
    // Handled inside per-run try/catch so the failure signature is recorded per run
  }

  for (let i = 1; i <= safeRunsCount; i++) {
    const t0 = performance.now();
    try {
      const sodium = preloadedSodium ?? (await getSodium());
      const saltBytes = sodium.randombytes_buf(KDF_SALT_BYTES);
      const kdfParams: VaultKdfParams = {
        alg: KDF_ALG,
        ops: KDF_OPS_MIN,
        mem: KDF_MEM_MIN,
        parallelism: KDF_PARALLELISM,
        salt: encodeBase64Url(saltBytes),
      };
      const passphraseBytes = toLocalBytes(utf8Encoder.encode(`engram-p03-t5-bench-run-${i}`));
      const kek = await deriveKek(sodium, passphraseBytes, kdfParams);
      const ms = Math.round((performance.now() - t0) * 100) / 100;
      sodium.memzero(passphraseBytes);
      sodium.memzero(toLocalBytes(kek));
      durations.push(ms);
      entries.push({
        run: i,
        ms,
        ok: true,
      });
    } catch (err) {
      const ms = Math.round((performance.now() - t0) * 100) / 100;
      const sig = extractErrorSignature(err);
      entries.push({
        run: i,
        ms,
        ok: false,
        errorCode: sig.errorCode,
        errorName: sig.errorName,
        errorMessage: sig.errorMessage,
        errorConstructorName: sig.errorConstructorName,
      });
    }
  }

  let medianMs: number | null = null;
  let p95Ms: number | null = null;
  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianMs =
      sorted.length % 2 === 1
        ? sorted[mid]!
        : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100;
    const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    p95Ms = sorted[p95Idx]!;
  }

  return {
    type: 'benchResult',
    ...(runId !== undefined ? { runId } : {}),
    params: {
      alg: KDF_ALG,
      ops: KDF_OPS_MIN,
      mem: KDF_MEM_MIN,
      parallelism: KDF_PARALLELISM,
      runs: safeRunsCount,
    },
    runs: entries,
    medianMs,
    p95Ms,
    allSucceeded: safeRunsCount > 0 && entries.length === safeRunsCount && entries.every((r) => r.ok),
  };
}

declare const self: DedicatedWorkerGlobalScope;

const isDedicatedWorkerScope =
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  (typeof WorkerGlobalScope !== 'undefined'
    ? self instanceof WorkerGlobalScope
    : !('window' in globalThis));

if (isDedicatedWorkerScope) {
  self.onmessage = (event: MessageEvent<BenchStartMessage>) => {
    if (event.data?.type !== 'startBench') return;
    const count = event.data.runs ?? 3;
    const runId = event.data.runId;
    void runArgon2idBenchmark(count, runId)
      .then((result) => {
        self.postMessage(result);
      })
      .catch((err: unknown) => {
        const sig = extractErrorSignature(err);
        const errorMsg: BenchErrorMessage = {
          type: 'benchError',
          ...(runId !== undefined ? { runId } : {}),
          errorName: sig.errorName,
          errorMessage: sig.errorMessage,
          errorConstructorName: sig.errorConstructorName,
          errorCode: sig.errorCode,
        };
        self.postMessage(errorMsg);
      });
  };
}
