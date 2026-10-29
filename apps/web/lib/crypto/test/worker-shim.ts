import { MessageChannel, type TransferListItem } from 'node:worker_threads';
import type { CryptoWorkerPort } from '../client';
import {
  createWorkerCore,
  type CryptoWorkerCore,
  type WorkerCoreHooks,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../worker-core';

export interface ShimmedWorkerInstance {
  port: CryptoWorkerPort;
  core: CryptoWorkerCore;
  workerPostMessageCalls: WorkerResponseMessage[];
  clientPostMessageCalls: WorkerRequestMessage[];
  simulateCrash: () => void;
  close: () => void;
}

/**
 * Hosts `worker-core` behind a real Node `MessageChannel` (`node:worker_threads`)
 * so `postMessage(msg, [arrayBuffer])` performs genuine structured cloning AND
 * detaches transferred `ArrayBuffer`s (`byteLength === 0`) on the sender side.
 */
export function createWorkerShim(hooks: WorkerCoreHooks = {}): ShimmedWorkerInstance {
  const { port1: mainPort, port2: workerPort } = new MessageChannel();
  const core = createWorkerCore(hooks);

  const workerPostMessageCalls: WorkerResponseMessage[] = [];
  const clientPostMessageCalls: WorkerRequestMessage[] = [];

  workerPort.on('message', (data: WorkerRequestMessage) => {
    void core.handleMessage(data).then((response) => {
      workerPostMessageCalls.push(response);
      workerPort.postMessage(response);
    });
  });

  let onmessageHandler: ((event: MessageEvent<WorkerResponseMessage>) => void) | null = null;
  let onerrorHandler: ((event: ErrorEvent | Event) => void) | null = null;
  let onmessageerrorHandler: ((event: MessageEvent) => void) | null = null;

  mainPort.on('message', (data: WorkerResponseMessage) => {
    if (onmessageHandler) {
      onmessageHandler({ data } as MessageEvent<WorkerResponseMessage>);
    }
  });

  mainPort.on('messageerror', (err: Error) => {
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
      mainPort.close();
      workerPort.close();
    },
  };

  return {
    port,
    core,
    workerPostMessageCalls,
    clientPostMessageCalls,
    simulateCrash() {
      if (onerrorHandler) {
        onerrorHandler(new Event('error'));
      }
    },
    close() {
      mainPort.close();
      workerPort.close();
    },
  };
}
