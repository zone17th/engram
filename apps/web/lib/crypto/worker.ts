/// <reference lib="webworker" />

import { attachWorkerCore, type MessagePortLike } from './worker-core';

declare const self: DedicatedWorkerGlobalScope;

const isDedicatedWorkerScope =
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  (typeof WorkerGlobalScope !== 'undefined'
    ? self instanceof WorkerGlobalScope
    : !('window' in globalThis));

if (isDedicatedWorkerScope) {
  attachWorkerCore(self as unknown as MessagePortLike);
}
