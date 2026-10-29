import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CryptoClient } from './client';
import {
  buildSharedArtifacts,
  createWorld,
  establishStartMode,
  expectOk,
  fastDeriveKek,
  makeDeterministicRecoveryAdapter,
  type SharedArtifacts,
  type World,
} from './test/fence-harness';
import { createWorkerShim } from './test/worker-shim';

// r5 fix-5a regressions: BE5-1 / FE5-1 / FE5-2 (CLIENT_BUSY wipes every supported secret form, detached input is
// coded), FE5-3 (Worker death frees the client's state slot), T-r5-1 (read-only commands in `recovering` do no
// key or plaintext work).

async function turns(n = 6): Promise<void> {
  for (let i = 0; i < n; i += 1) await nextTurn();
}

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 5000 && !cond(); i += 1) await nextTurn();
  expect(cond(), `timed out waiting for ${label}`).toBe(true);
}

/** A genuinely detached buffer (transferred through a MessageChannel, like the Worker request does). */
function detachedBytes(): Uint8Array {
  const { port1 } = new MessageChannel();
  const bytes = new Uint8Array(32).fill(5);
  port1.postMessage(bytes.buffer, [bytes.buffer]);
  port1.close();
  expect(bytes.buffer.byteLength).toBe(0);
  return bytes;
}

interface SecretForm {
  name: string;
  /** The value handed to the client call. */
  make(): { secret: unknown; check(): boolean };
}

const LEN = 32;
const SECRET_FORMS: SecretForm[] = [
  {
    name: 'Uint8Array',
    make() {
      const u = new Uint8Array(LEN).fill(7);
      return { secret: u, check: () => u.every((b) => b === 0) };
    },
  },
  {
    name: 'ArrayBuffer',
    make() {
      const u = new Uint8Array(LEN).fill(7);
      return { secret: u.buffer, check: () => u.every((b) => b === 0) };
    },
  },
  {
    name: 'sub-view of a larger buffer',
    make() {
      const big = new Uint8Array(64).fill(9);
      const sub = big.subarray(8, 8 + LEN);
      return { secret: sub, check: () => sub.every((b) => b === 0) };
    },
  },
  {
    name: 'cross-realm Uint8Array',
    make() {
      const f = vm.runInNewContext(`new Uint8Array(${LEN}).fill(7)`) as Uint8Array;
      expect(f instanceof Uint8Array).toBe(false);
      return { secret: f, check: () => f.every((b) => b === 0) };
    },
  },
  {
    name: 'cross-realm ArrayBuffer',
    make() {
      const fb = vm.runInNewContext(`new Uint8Array(${LEN}).fill(7).buffer`) as ArrayBuffer;
      expect(fb instanceof ArrayBuffer).toBe(false);
      expect(Object.prototype.toString.call(fb)).toBe('[object ArrayBuffer]');
      return { secret: fb, check: () => new Uint8Array(fb).every((b) => b === 0) };
    },
  },
];

describe('P03-T5 r5 fix-5a regressions', () => {
  let shared: SharedArtifacts;
  const worlds: World[] = [];
  const clients: CryptoClient[] = [];

  beforeAll(async () => {
    shared = await buildSharedArtifacts();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (clients.length > 0) clients.pop()?.terminate();
    while (worlds.length > 0) worlds.pop()?.close();
  });

  const world = (level: 'client' | 'worker'): World => {
    const w = createWorld(shared, level);
    worlds.push(w);
    return w;
  };

  /** A client whose first state call is parked before it posts (holds the single-flight slot). */
  function busyClient() {
    const w = world('client');
    const client = new CryptoClient({ createWorker: () => w.shim.port });
    clients.push(client);
    const g = client.captureGeneration();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = client.unlockPrf({
      pwk: new Uint8Array(shared.pwk),
      vkWrap: shared.vkWrap,
      privateKeysWrapped: shared.vault.privateKeysWrapped,
      opGeneration: g,
      beforePostMessage: () => gate,
    });
    const calls: Record<string, (secret: unknown) => Promise<unknown>> = {
      createVault: (s) => client.createVault({ passphrase: s as Uint8Array, opGeneration: g }),
      unlockPassphrase: (s) =>
        client.unlockPassphrase({
          passphrase: s as Uint8Array,
          kdf: shared.vault.kdf,
          vaultKeyWrappedByKek: shared.vault.vaultKeyWrappedByKek,
          opGeneration: g,
        }),
      rewrap: (s) =>
        client.rewrap({
          passphrase: s as Uint8Array,
          currentKdf: shared.vault.kdf,
          opGeneration: g,
        }),
      unlockRecovery: (s) =>
        client.unlockRecovery({ recoveryKey: s as Uint8Array, opGeneration: g }),
      unlockPrf: (s) =>
        client.unlockPrf({
          pwk: s as Uint8Array,
          vkWrap: shared.vkWrap,
          opGeneration: g,
        }),
    };
    return { w, client, g, first, release, calls };
  }

  describe('BE5-1 / FE5-1 / FE5-2: CLIENT_BUSY wipes every supported secret form', () => {
    it('wipes same-realm, sub-view and cross-realm secret inputs of every secret-taking call; coded CLIENT_BUSY, no Worker contact, held call unharmed', async () => {
      const { w, first, release, calls } = busyClient();
      for (const [callName, call] of Object.entries(calls)) {
        for (const form of SECRET_FORMS) {
          const { secret, check } = form.make();
          await expect(call(secret), `${callName} / ${form.name}`).rejects.toMatchObject({
            name: 'CryptoClientError',
            code: 'CLIENT_BUSY',
          });
          expect(check(), `${callName} / ${form.name}: bytes zeroed`).toBe(true);
        }
      }
      expect(w.shim.clientPostMessageCalls).toHaveLength(0);
      release();
      expectOk(
        await first.then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, code: (err as { code?: string }).code ?? 'UNCODED' }),
        ),
        'held unlockPrf',
      );
    });

    it('an already-detached secret input is CLIENT_BUSY while busy (busy wins) and SECRET_DETACHED_OR_EMPTY when idle; never an uncoded TypeError', async () => {
      const { w, client, g, first, release, calls } = busyClient();
      for (const [callName, call] of Object.entries(calls)) {
        const d = detachedBytes();
        await expect(call(d), `${callName} detached Uint8Array while busy`).rejects.toMatchObject({
          code: 'CLIENT_BUSY',
        });
        await expect(
          call(d.buffer),
          `${callName} detached ArrayBuffer while busy`,
        ).rejects.toMatchObject({ code: 'CLIENT_BUSY' });
      }
      expect(w.shim.clientPostMessageCalls).toHaveLength(0);
      release();
      await first;

      // idle again: the same detached inputs are SECRET_DETACHED_OR_EMPTY
      const d = detachedBytes();
      await expect(
        client.createVault({ passphrase: d, opGeneration: g }),
      ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });
      await expect(
        client.createVault({ passphrase: d.buffer as unknown as Uint8Array, opGeneration: g }),
      ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });
    });

    it('FE5-2: submitting the same transferable buffer twice before the first reply gives the second a coded CLIENT_BUSY and leaves the first call intact', async () => {
      const w = world('client');
      const client = new CryptoClient({ createWorker: () => w.shim.port });
      clients.push(client);
      const g = client.captureGeneration();
      const input = new TextEncoder().encode('double-submitted-passphrase');
      const firstP = client.createVault({
        passphrase: input,
        skipRecoveryKeys: true,
        opGeneration: g,
      });
      // the first call already transferred the buffer synchronously
      expect(input.buffer.byteLength).toBe(0);
      await expect(
        client.createVault({ passphrase: input, skipRecoveryKeys: true, opGeneration: g }),
      ).rejects.toMatchObject({ code: 'CLIENT_BUSY' });
      await expect(firstP).resolves.toMatchObject({ kdf: expect.anything() });
      expect(w.shim.clientPostMessageCalls).toHaveLength(1);
      expect(client.getState()).toBe('unlocked');
      // the slot is reusable afterwards
      await client.lock();
      await expect(
        client.createVault({
          passphrase: 'reuse-after-busy-passphrase',
          skipRecoveryKeys: true,
          opGeneration: client.captureGeneration(),
        }),
      ).resolves.toMatchObject({ kdf: expect.anything() });
    });
  });

  describe('FE5-3: Worker death frees the client state slot', () => {
    function deathSetup() {
      const w = world('client');
      const fresh = createWorkerShim({
        deriveKek: (s, pass, params) => fastDeriveKek(s, pass, params),
        recovery: makeDeterministicRecoveryAdapter(),
      });
      const shims = [w.shim, fresh];
      let created = 0;
      const states: string[] = [];
      let retry: Promise<unknown> | undefined;
      const unlockArgs = () => ({
        passphrase: shared.vault.passphrase,
        kdf: shared.vault.kdf,
        vaultKeyWrappedByKek: shared.vault.vaultKeyWrappedByKek,
        privateKeysWrapped: shared.vault.privateKeysWrapped,
        opGeneration: client.captureGeneration(),
      });
      const client: CryptoClient = new CryptoClient({
        createWorker: () => shims[created++]!.port,
        onStateChange: (state) => {
          states.push(state);
          // a vault provider reacting to the error state retries at once, before any old promise settles
          if (state === 'error' && !retry) retry = client.unlockPassphrase(unlockArgs());
        },
      });
      clients.push(client);
      return { w, fresh, client, states, unlockArgs, getRetry: () => retry };
    }

    it('an in-flight state call dies with the Worker -> WORKER_CRASHED, the observer retry on a fresh Worker is not CLIENT_BUSY', async () => {
      const { w, fresh, client, getRetry, unlockArgs } = deathSetup();
      w.derive.arm();
      const inFlight = client.unlockPassphrase(unlockArgs());
      await until(() => w.derive.parked, 'unlockPassphrase parked at the KDF');
      w.shim.simulateCrash();
      await expect(inFlight).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
      expect(getRetry()).toBeDefined();
      await expect(getRetry()).resolves.toEqual({ unlocked: true });
      expect(client.getState()).toBe('unlocked');
      expect(fresh.core.getState()).toBe('unlocked');
      expect(fresh.clientPostMessageCalls).toHaveLength(1);
      // the old call's late `finally` and any late event from the dead Worker leave the replacement alone
      await turns();
      w.shim.simulateCrash();
      w.shim.simulateMessageError();
      expect(client.getState()).toBe('unlocked');
      // slot is free again
      await client.lock();
      await client.unlockPassphrase(unlockArgs());
      expect(client.getState()).toBe('unlocked');
    });

    it('an in-flight call plus a call queued behind lock() both settle WORKER_CRASHED, the slot is free and the next call works on a fresh Worker', async () => {
      const { w, fresh, client, getRetry, unlockArgs } = deathSetup();
      w.derive.arm();
      const oldP = client.unlockPassphrase(unlockArgs());
      await until(() => w.derive.parked, 'unlockPassphrase parked at the KDF');
      await client.lock();
      const queuedP = client.unlockPrf({
        pwk: new Uint8Array(shared.pwk),
        vkWrap: shared.vkWrap,
        privateKeysWrapped: shared.vault.privateKeysWrapped,
        opGeneration: client.captureGeneration(),
      });
      await turns();
      w.shim.simulateCrash();
      const [oldR, queuedR] = await Promise.allSettled([oldP, queuedP]);
      expect(oldR.status).toBe('rejected');
      expect(queuedR.status).toBe('rejected');
      expect((oldR as PromiseRejectedResult).reason).toMatchObject({ code: 'WORKER_CRASHED' });
      expect((queuedR as PromiseRejectedResult).reason).toMatchObject({ code: 'WORKER_CRASHED' });
      await expect(getRetry()).resolves.toEqual({ unlocked: true });
      expect(fresh.core.getState()).toBe('unlocked');
      expect(client.getState()).toBe('unlocked');
    });
  });

  describe('T-r5-1: read-only commands in `recovering` do no key or plaintext work', () => {
    it.each(['client', 'worker'] as const)(
      '%s level: openEntry / sealEntry / wrapForDevice / wrapForPasskey / makeRecoveryKeys reject VAULT_RECOVERING with zero AEAD, seal, hash or randomness work',
      async (level) => {
        const w = world(level);
        await establishStartMode(w, 'recovering');
        const d = w.driver;
        const sodium = shared.sodium as unknown as Record<string, (...a: unknown[]) => unknown>;
        const spied = [
          'randombytes_buf',
          'crypto_generichash',
          'crypto_aead_xchacha20poly1305_ietf_encrypt',
          'crypto_aead_xchacha20poly1305_ietf_decrypt',
          'crypto_box_seed_keypair',
          'crypto_sign_seed_keypair',
          'crypto_secretbox_easy',
        ]
          .filter((name) => typeof sodium[name] === 'function')
          .map((name) => [name, vi.spyOn(sodium, name)] as const);
        expect(spied.length).toBeGreaterThanOrEqual(5);
        const subtleEncrypt = vi.spyOn(crypto.subtle, 'encrypt');
        const subtleDecrypt = vi.spyOn(crypto.subtle, 'decrypt');
        const allocationsBefore = w.tracker.allocations.length;
        const vkBefore = new Uint8Array(w.shim.core.inspectClosureVkForTest()!);
        const epochBefore = w.shim.core.getEpoch();

        const g = d.gen();
        for (const cmd of [
          'openEntry',
          'sealEntry',
          'wrapForDevice',
          'wrapForPasskey',
          'makeRecoveryKeys',
        ] as const) {
          expect(await d.call(cmd, g), cmd).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
          for (const [name, spy] of spied) {
            expect(spy.mock.calls.length, `${cmd}: ${name} calls`).toBe(0);
          }
          expect(subtleEncrypt.mock.calls.length, `${cmd}: subtle.encrypt`).toBe(0);
          expect(subtleDecrypt.mock.calls.length, `${cmd}: subtle.decrypt`).toBe(0);
          expect(w.tracker.allocations.length, `${cmd}: tracked allocations`).toBe(allocationsBefore);
        }
        expect(w.shim.core.getState()).toBe('recovering');
        expect(w.shim.core.inspectClosureVkForTest()).toEqual(vkBefore);
        expect(w.shim.core.getEpoch()).toBe(epochBefore);
      },
    );
  });
});
