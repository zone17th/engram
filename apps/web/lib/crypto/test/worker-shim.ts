import { MessageChannel, type TransferListItem } from 'node:worker_threads';
import type { CryptoWorkerPort } from '../client';
import {
  attachWorkerCore,
  createWorkerCore,
  type CryptoWorkerCore,
  type MessagePortLike,
  type WorkerCoreHooks,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../worker-core';

export interface ShimmedWorkerInstance {
  port: CryptoWorkerPort;
  core: CryptoWorkerCore;
  workerPostMessageCalls: WorkerResponseMessage[];
  clientPostMessageCalls: WorkerRequestMessage[];
  workerReceivedRequests: WorkerRequestMessage[];
  simulateCrash: () => void;
  simulateMessageError: () => void;
  close: () => void;
}

/**
 * Hosts `worker-core` behind a real Node `MessageChannel` (`node:worker_threads`)
 * wired through the real receive-side `attachWorkerCore(workerScope, core)` entrypoint
 * so `postMessage(msg, [arrayBuffer])` performs genuine structured cloning,
 * detaches transferred `ArrayBuffer`s (`byteLength === 0`) on the sender side,
 * and exercises `attachWorkerCore`'s `onmessage` -> `postMessage` boundary (BE1-22, FE1-10).
 */
export function createWorkerShim(hooks: WorkerCoreHooks = {}): ShimmedWorkerInstance {
  const { port1: mainPort, port2: workerPort } = new MessageChannel();
  const core = createWorkerCore(hooks);

  const workerPostMessageCalls: WorkerResponseMessage[] = [];
  const clientPostMessageCalls: WorkerRequestMessage[] = [];
  const workerReceivedRequests: WorkerRequestMessage[] = [];

  let workerOnMessage: ((event: MessageEvent<WorkerRequestMessage>) => void) | null = null;
  let isTerminated = false;

  const workerScope: MessagePortLike = {
    postMessage(message: unknown, transfer: Transferable[] = []) {
      if (isTerminated) return;
      workerPostMessageCalls.push(message as WorkerResponseMessage);
      workerPort.postMessage(message, transfer as unknown as readonly TransferListItem[]);
    },
    get onmessage() {
      return workerOnMessage;
    },
    set onmessage(handler) {
      workerOnMessage = handler;
    },
  };

  attachWorkerCore(workerScope, core);

  workerPort.on('message', (data: WorkerRequestMessage) => {
    if (isTerminated) return;
    workerReceivedRequests.push(data);
    workerScope.onmessage?.({ data } as MessageEvent<WorkerRequestMessage>);
  });

  let onmessageHandler: ((event: MessageEvent<WorkerResponseMessage>) => void) | null = null;
  let onerrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  let onmessageerrorHandler: ((event: MessageEvent) => void) | null = null;

  mainPort.on('message', (data: WorkerResponseMessage) => {
    if (isTerminated) return;
    if (onmessageHandler) {
      onmessageHandler({ data } as MessageEvent<WorkerResponseMessage>);
    }
  });

  mainPort.on('messageerror', (err: Error) => {
    if (isTerminated) return;
    if (onmessageerrorHandler) {
      onmessageerrorHandler({ data: err } as unknown as MessageEvent);
    }
  });

  const port: CryptoWorkerPort = {
    postMessage(message: WorkerRequestMessage, transfer: Transferable[] = []) {
      clientPostMessageCalls.push(message);
      mainPort.postMessage(message, transfer as unknown as readonly TransferListItem[]);
    },
    get onmessage() {
      return onmessageHandler;
    },
    set onmessage(handler) {
      onmessageHandler = handler;
    },
    get onerror() {
      return onerrorHandler;
    },
    set onerror(handler) {
      onerrorHandler = handler;
    },
    get onmessageerror() {
      return onmessageerrorHandler;
    },
    set onmessageerror(handler) {
      onmessageerrorHandler = handler;
    },
    terminate() {
      isTerminated = true;
      mainPort.close();
      workerPort.close();
    },
  };

  return {
    port,
    core,
    workerPostMessageCalls,
    clientPostMessageCalls,
    workerReceivedRequests,
    simulateCrash() {
      if (onerrorHandler) {
        onerrorHandler(new Event('error'));
      }
    },
    simulateMessageError() {
      if (onmessageerrorHandler) {
        onmessageerrorHandler(new MessageEvent('messageerror'));
      }
    },
    close() {
      isTerminated = true;
      mainPort.close();
      workerPort.close();
    },
  };
}
