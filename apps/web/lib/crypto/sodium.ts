import sodium from 'libsodium-wrappers-sumo';

export type Sodium = typeof sodium;

let readyPromise: Promise<Sodium> | null = null;

/**
 * Loads and initializes `libsodium-wrappers-sumo` exactly once per process/Worker.
 * Shared across `worker.ts`, `bench.worker.ts`, and crypto primitives.
 */
export function getSodium(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = sodium.ready.then(() => sodium);
  }
  return readyPromise;
}

export { sodium };

/**
 * Ensures a `Uint8Array` (or `ArrayBuffer`) is an instance of the current realm's `Uint8Array`.
 * Required when running under Vitest/jsdom or across Node `MessageChannel` boundaries, because
 * `libsodium-wrappers-sumo` validates `val instanceof Uint8Array` against the Node realm's constructor.
 */
export function toLocalBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(input);
}
