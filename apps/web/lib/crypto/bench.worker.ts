/// <reference lib="webworker" />

import { encodeBase64Url } from './b64url';
import {
  deriveKek,
  KDF_ALG,
  KDF_MEM_MIN,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KdfError,
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
  errorCauseName?: string;
  errorCauseMessage?: string;
  errorCauseConstructorName?: string;
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
  errorCauseName?: string;
  errorCauseMessage?: string;
  errorCauseConstructorName?: string;
}

export interface BenchRunnerDeps {
  getSodium?: () => Promise<Sodium>;
  deriveKek?: (
    sodium: Sodium,
    passphrase: Uint8Array,
    kdfParams: VaultKdfParams,
  ) => Uint8Array | Promise<Uint8Array>;
}

export interface BenchWorkerScopeLike {
  onmessage: ((event: MessageEvent<BenchStartMessage>) => void) | null;
  postMessage: (message: BenchWorkerOutboundMessage) => void;
}

export type BenchWorkerOutboundMessage = BenchResultMessage | BenchErrorMessage;

export interface BenchStartMessage {
  type: 'startBench';
  runId?: number;
  runs?: number;
}
const utf8Encoder = new TextEncoder();

function readRawErrorSignature(err: unknown): {
  name: string;
  message: string;
  constructorName: string;
} {
  const errObj = err instanceof Error ? err : new Error(String(err));
  let constructorName = errObj.name;
  if (typeof err === 'object' && err !== null) {
    const ctor: unknown = Reflect.get(err, 'constructor');
    if (typeof ctor === 'function' && ctor.name) {
      constructorName = ctor.name;
    }
  }
  return {
    name: errObj.name,
    message: errObj.message,
    constructorName,
  };
}

export function extractErrorSignature(err: unknown): {
  errorName: string;
  errorMessage: string;
  errorConstructorName: string;
  errorCode: string;
  errorCauseName?: string;
  errorCauseMessage?: string;
  errorCauseConstructorName?: string;
} {
  let code = 'UNKNOWN_ERROR';
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    code = err.code;
  }
  if (err instanceof KdfError && err.cause !== undefined && err.cause !== null) {
    const causeSig = readRawErrorSignature(err.cause);
    return {
      errorName: causeSig.name,
      errorMessage: causeSig.message,
      errorConstructorName: causeSig.constructorName,
      errorCode: code,
      errorCauseName: causeSig.name,
      errorCauseMessage: causeSig.message,
      errorCauseConstructorName: causeSig.constructorName,
    };
  }
  const rawSig = readRawErrorSignature(err);
  return {
    errorName: rawSig.name,
    errorMessage: rawSig.message,
    errorConstructorName: rawSig.constructorName,
    errorCode: code,
  };
}

export async function runArgon2idBenchmark(
  runsCount = 3,
  runId?: number,
  deps: BenchRunnerDeps = {},
): Promise<BenchResultMessage> {
  const loadSodium = deps.getSodium ?? getSodium;
  const runDeriveKek = deps.deriveKek ?? deriveKek;
  const safeRunsCount =
    Number.isInteger(runsCount) && runsCount >= 1 && runsCount <= 20 ? runsCount : 3;
  const entries: BenchRunEntry[] = [];
  const durations: number[] = [];

  let preloadedSodium: Sodium | null = null;
  try {
    preloadedSodium = await loadSodium();
  } catch {
    // Handled inside per-run try/catch so the failure signature is recorded per run
  }

  for (let i = 1; i <= safeRunsCount; i++) {
    const t0 = performance.now();
    try {
      const sodium = preloadedSodium ?? (await loadSodium());
      const saltBytes = sodium.randombytes_buf(KDF_SALT_BYTES);
      const kdfParams: VaultKdfParams = {
        alg: KDF_ALG,
        ops: KDF_OPS_MIN,
        mem: KDF_MEM_MIN,
        parallelism: KDF_PARALLELISM,
        salt: encodeBase64Url(saltBytes),
      };
      const passphraseBytes = toLocalBytes(utf8Encoder.encode(`engram-p03-t5-bench-run-${i}`));
      const kek = await runDeriveKek(sodium, passphraseBytes, kdfParams);
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
        ...(sig.errorCauseName !== undefined ? { errorCauseName: sig.errorCauseName } : {}),
        ...(sig.errorCauseMessage !== undefined
          ? { errorCauseMessage: sig.errorCauseMessage }
          : {}),
        ...(sig.errorCauseConstructorName !== undefined
          ? { errorCauseConstructorName: sig.errorCauseConstructorName }
          : {}),
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

export function attachBenchWorkerScope(
  scope: BenchWorkerScopeLike,
  runner: (runsCount?: number, runId?: number) => Promise<BenchResultMessage> = runArgon2idBenchmark,
): void {
  scope.onmessage = (event: MessageEvent<BenchStartMessage>) => {
    if (event.data?.type !== 'startBench') return;
    const count = event.data.runs ?? 3;
    const runId = event.data.runId;
    void runner(count, runId)
      .then((result) => {
        scope.postMessage(result);
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
          ...(sig.errorCauseName !== undefined ? { errorCauseName: sig.errorCauseName } : {}),
          ...(sig.errorCauseMessage !== undefined
            ? { errorCauseMessage: sig.errorCauseMessage }
            : {}),
          ...(sig.errorCauseConstructorName !== undefined
            ? { errorCauseConstructorName: sig.errorCauseConstructorName }
            : {}),
        };
        scope.postMessage(errorMsg);
      });
  };
}

if (isDedicatedWorkerScope) {
  attachBenchWorkerScope(self);
}
