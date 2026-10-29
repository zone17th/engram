/// <reference lib="webworker" />

import { attachWorkerCore, type MessagePortLike } from './worker-core';

declare const self: DedicatedWorkerGlobalScope;

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  attachWorkerCore(self as unknown as MessagePortLike);
}
