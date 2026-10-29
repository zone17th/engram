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
import { getSodium, toLocalBytes } from './sodium';

export interface BenchRunEntry {
  run: number;
  ms: number;
  ok: boolean;
  errorCode?: string;
  errorName?: string;
  errorMessage?: string;
}

export interface BenchResultMessage {
  type: 'benchResult';
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

export interface BenchStartMessage {
  type: 'startBench';
  runs?: number;
}

const utf8Encoder = new TextEncoder();

export async function runArgon2idBenchmark(runsCount = 3): Promise<BenchResultMessage> {
  const entries: BenchRunEntry[] = [];
  const durations: number[] = [];

  for (let i = 1; i <= runsCount; i++) {
    const t0 = performance.now();
    try {
      const sodium = await getSodium();
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
      const errObj = err instanceof Error ? err : new Error(String(err));
      const code =
        'code' in errObj && typeof errObj.code === 'string'
          ? errObj.code
          : 'UNKNOWN_ERROR';
      entries.push({
        run: i,
        ms,
        ok: false,
        errorCode: code,
        errorName: errObj.name,
        errorMessage: errObj.message,
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
    params: {
      alg: KDF_ALG,
      ops: KDF_OPS_MIN,
      mem: KDF_MEM_MIN,
      parallelism: KDF_PARALLELISM,
      runs: runsCount,
    },
    runs: entries,
    medianMs,
    p95Ms,
    allSucceeded: entries.length === runsCount && entries.every((r) => r.ok),
  };
}

declare const self: DedicatedWorkerGlobalScope;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event: MessageEvent<BenchStartMessage>) => {
    if (event.data?.type !== 'startBench') return;
    const count = event.data.runs ?? 3;
    void runArgon2idBenchmark(count).then((result) => {
      self.postMessage(result);
    });
  };
}
