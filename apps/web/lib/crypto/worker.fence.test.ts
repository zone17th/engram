import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CryptoClient } from './client';
import type { CryptoWorkerPort } from './client';
import type { VaultKdfParams, WorkerRequestMessage, WorkerResponseMessage } from './protocol';
import {
  assertSecretsZeroed,
  buildSharedArtifacts,
  CREATE_PASSPHRASE,
  createWorld,
  expectOk,
  nonZeroInboundSecrets,
  type PersistedVault,
  type SharedArtifacts,
  type World,
} from './test/fence-harness';

// Named structural-fence regressions (r5 fix-4, advisor-dec-023): serial state queue, lock preemption,
// CLIENT_BUSY, authoritative replies, start-time whitelist, single state writer, Worker secret wipes.

async function turns(n = 6): Promise<void> {
  for (let i = 0; i < n; i += 1) await nextTurn();
}

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 5000 && !cond(); i += 1) await nextTurn();
  expect(cond(), `timed out waiting for ${label}`).toBe(true);
}

function created(value: unknown, passphrase: string): PersistedVault {
  const v = value as {
    kdf: VaultKdfParams;
    vault_key_wrapped_by_kek: string;
    private_keys_wrapped: string;
  };
  return {
    passphrase,
    kdf: v.kdf,
    vaultKeyWrappedByKek: v.vault_key_wrapped_by_kek,
    privateKeysWrapped: v.private_keys_wrapped,
  };
}

describe('P03-T5 structural fence regressions (r5 fix-4)', () => {
  let shared: SharedArtifacts;
  const worlds: World[] = [];

  beforeAll(async () => {
    shared = await buildSharedArtifacts();
  });

  afterEach(() => {
    while (worlds.length > 0) worlds.pop()?.close();
  });

  const world = (level: 'client' | 'worker'): World => {
    const w = createWorld(shared, level);
    worlds.push(w);
    return w;
  };

  const isOriginalVk = (w: World): boolean => {
    const vk = w.shim.core.inspectClosureVkForTest();
    return vk !== null && shared.sodium.memcmp(vk, shared.originalVk);
  };

  describe('BE4-1 createVault data loss (queued unlockPrf + createVault)', () => {
    it('client: the pipelined createVault is CLIENT_BUSY, the original VK stays, and the persisted vault still opens the entry', async () => {
      const w = world('client');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      const posted = d.posted();
      const [prf, create] = await Promise.all([d.call('unlockPrf', g), d.call('createVault', g)]);
      expect(prf).toMatchObject({ ok: true });
      expect(create).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(d.posted()).toBe(posted + 1);
      expect(isOriginalVk(w)).toBe(true);
      expect(d.mirror()).toMatchObject({ mode: 'unlocked' });

      const sealed = expectOk(await d.seal('data-loss-probe', d.gen()), 'seal') as {
        envelope: unknown;
        ciphertext: string;
      };
      expectOk(await d.call('lock', d.gen()), 'lock');
      expectOk(await d.unlockWith(shared.vault, d.gen()), 'unlock persisted original vault');
      expect(expectOk(await d.open(sealed, d.gen()), 'open')).toMatchObject({
        plaintext: 'data-loss-probe',
      });
    });

    it('Worker: back-to-back unlockPrf then createVault run serially; the installed key is the created vault (never a rejected one)', async () => {
      const w = world('worker');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      const [prf, create] = await Promise.all([d.call('unlockPrf', g), d.call('createVault', g)]);
      expect(prf).toMatchObject({ ok: true });
      expect(create).toMatchObject({ ok: true });
      expect(w.shim.core.getState()).toBe('unlocked');
      expect(isOriginalVk(w)).toBe(false);

      const createdVault = created((create as { value: unknown }).value, CREATE_PASSPHRASE);
      const sealed = expectOk(await d.seal('serial-create', d.gen()), 'seal') as {
        envelope: unknown;
        ciphertext: string;
      };
      expectOk(await d.call('lock', d.gen()), 'lock');
      // The created vault's persisted wraps open the entry sealed under the key the Worker really held.
      expectOk(await d.unlockWith(createdVault, d.gen()), 'unlock created vault');
      expect(expectOk(await d.open(sealed, d.gen()), 'open')).toMatchObject({
        plaintext: 'serial-create',
      });
      // ... while the original vault yields a different key.
      expectOk(await d.call('lock', d.gen()), 'lock');
      expectOk(await d.unlockWith(shared.vault, d.gen()), 'unlock original vault');
      expect(await d.open(sealed, d.gen())).toEqual({ ok: false, code: 'AEAD_DECRYPT_FAILED' });
    });
  });

  describe('BE4-1 / FE4-1 client and Worker never diverge', () => {
    it('client: unlockPrf then unlockRecovery{wrap} in one tick -> second call CLIENT_BUSY, client and Worker both unlocked', async () => {
      const w = world('client');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      const [prf, rec] = await Promise.all([d.call('unlockPrf', g), d.call('unlockRecoveryWrap', g)]);
      expect(prf).toMatchObject({ ok: true });
      expect(rec).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(w.shim.core.getState()).toBe('unlocked');
      expect(d.mirror()).toMatchObject({ mode: 'unlocked', epoch: w.shim.core.getEpoch() });
    });

    it('Worker: both back-to-back commands succeed and the authoritative replies end in recovering', async () => {
      const w = world('worker');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      const [prf, rec] = await Promise.all([d.call('unlockPrf', g), d.call('unlockRecoveryWrap', g)]);
      expect(prf).toMatchObject({ ok: true });
      expect(rec).toMatchObject({ ok: true });
      expect(w.shim.core.getState()).toBe('recovering');
      const replies = w.shim.workerPostMessageCalls;
      expect(replies.map((r) => r.state.mode)).toEqual(['locked', 'unlocked', 'recovering']);
      expect(await d.call('openEntry', d.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
    });

    // A scripted Worker port: the client must follow the reply's authoritative state, not its own bookkeeping.
    function scriptedClient(): {
      client: CryptoClient;
      requests: WorkerRequestMessage[];
      reply: (r: Partial<WorkerResponseMessage> & { id: number }) => void;
    } {
      const requests: WorkerRequestMessage[] = [];
      const port: CryptoWorkerPort = {
        onmessage: null,
        postMessage: (m) => {
          requests.push(m);
        },
      };
      const client = new CryptoClient({ createWorker: () => port });
      return {
        client,
        requests,
        reply: (r) => port.onmessage?.({ data: r } as MessageEvent<WorkerResponseMessage>),
      };
    }

    it('adopts mode and epoch from every reply (success and error) and ignores stale-epoch or older-generation reports', async () => {
      const { client, requests, reply } = scriptedClient();
      const gen = client.captureGeneration();

      const p1 = client.sealEntry({ entryId: 'e', keyId: 'k', plaintext: 'x', opGeneration: gen });
      reply({
        id: requests[0]!.id,
        generation: gen,
        state: { mode: 'unlocked', generation: gen, epoch: 4 },
        ok: true,
        result: { envelope: {}, ciphertext: '' },
      });
      await p1;
      expect(client.getState()).toBe('unlocked');
      expect(client.getEpoch()).toBe(4);

      // success reply whose Worker state is `recovering`: the client follows the Worker
      const p2 = client.sealEntry({ entryId: 'e', keyId: 'k', plaintext: 'x', opGeneration: gen });
      reply({
        id: requests[1]!.id,
        generation: gen,
        state: { mode: 'recovering', generation: gen, epoch: 6 },
        ok: true,
        result: { envelope: {}, ciphertext: '' },
      });
      await p2;
      expect(client.getState()).toBe('recovering');
      expect(client.getEpoch()).toBe(6);

      // a regressed epoch is not adopted
      const p3 = client.openEntry({
        entryId: 'e',
        envelope: {},
        ciphertext: '',
        opGeneration: gen,
      });
      reply({
        id: requests[2]!.id,
        generation: gen,
        state: { mode: 'unlocked', generation: gen, epoch: 5 },
        ok: false,
        error: { code: 'ENVELOPE_INVALID', message: 'x' },
      });
      await expect(p3).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
      expect(client.getState()).toBe('recovering');
      expect(client.getEpoch()).toBe(6);

      // an ERROR reply from the current generation with a newer epoch is adopted too
      const p4 = client.openEntry({
        entryId: 'e',
        envelope: {},
        ciphertext: '',
        opGeneration: gen,
      });
      reply({
        id: requests[3]!.id,
        generation: gen,
        state: { mode: 'locked', generation: gen, epoch: 9 },
        ok: false,
        error: { code: 'VAULT_LOCKED', message: 'x' },
      });
      await expect(p4).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
      expect(client.getState()).toBe('locked');
      expect(client.getEpoch()).toBe(9);

      // a report that belongs to an older generation is not adopted
      const lockP = client.lock();
      const gen2 = client.captureGeneration();
      const p5 = client.openEntry({
        entryId: 'e',
        envelope: {},
        ciphertext: '',
        opGeneration: gen2,
      });
      reply({
        id: requests[5]!.id,
        generation: gen2,
        state: { mode: 'unlocked', generation: gen, epoch: 12 },
        ok: true,
        result: { plaintext: '' },
      });
      await p5.catch(() => undefined);
      expect(client.getState()).toBe('locked');
      expect(client.getEpoch()).toBe(9);
      reply({
        id: requests[4]!.id,
        generation: gen2,
        state: { mode: 'locked', generation: gen2, epoch: 13 },
        ok: true,
        result: { generation: gen2 },
      });
      await lockP;
      expect(client.getEpoch()).toBe(13);
    });

    it('treats a reply without authoritative state as a protocol violation: request rejects and the client fails closed', async () => {
      const { client, requests, reply } = scriptedClient();
      const gen = client.captureGeneration();
      const p = client.sealEntry({ entryId: 'e', keyId: 'k', plaintext: 'x', opGeneration: gen });
      reply({ id: requests[0]!.id, generation: gen, ok: true, result: {} } as never);
      await expect(p).rejects.toMatchObject({ code: 'WORKER_INTERNAL_ERROR' });
      expect(client.getState()).toBe('error');
    });
  });

  describe('lock preempts queued and in-flight state commands (Task 5 "lock mid-flight cancels stale results")', () => {
    it('lock settles at once while createVault is parked; the queued unlockPrf is cancelled with its secrets wiped; the parked createVault settles STALE_GENERATION without committing', async () => {
      const w = world('worker');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      w.derive.arm();
      let createSettled = false;
      const createP = d.call('createVault', g).then((r) => {
        createSettled = true;
        return r;
      });
      await until(() => w.derive.parked, 'createVault parked');
      let prfSettled = false;
      const prfP = d.call('unlockPrf', g).then((r) => {
        prfSettled = true;
        return r;
      });
      await turns();
      expect(prfSettled).toBe(false); // queued behind the parked createVault: serial queue

      const lock = await d.call('lock', g);
      expect(lock).toMatchObject({ ok: true });
      expect(createSettled).toBe(false); // lock did not wait for the parked command
      expect(await prfP).toEqual({ ok: false, code: 'STALE_GENERATION' });
      expect(nonZeroInboundSecrets(w.shim)).toEqual(['createVault.passphraseBuffer']); // only the parked one is still live
      expect(w.shim.core.getState()).toBe('locked');

      w.derive.release();
      expect(await createP).toEqual({ ok: false, code: 'STALE_GENERATION' });
      expect(w.shim.core.getState()).toBe('locked');
      expect(w.shim.core.inspectClosureVkForTest()).toBeNull();
      assertSecretsZeroed(w);
    });

    it('lock preempts a parked unlockDevKey (real subtle.decrypt) and a parked rewrap; neither commits', async () => {
      for (const cmd of ['unlockDevKey', 'rewrap'] as const) {
        const w = world('worker');
        const d = w.driver;
        if (cmd === 'rewrap') expectOk(await d.call('unlockPassphrase', d.gen()), 'unlock');
        else expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
        (cmd === 'unlockDevKey' ? w.decrypt : w.derive).arm();
        const p = d.call(cmd, d.gen());
        await until(() => (cmd === 'unlockDevKey' ? w.decrypt : w.derive).parked, `${cmd} parked`);
        expectOk(await d.call('lock', d.gen()), 'lock');
        (cmd === 'unlockDevKey' ? w.decrypt : w.derive).release();
        expect(await p).toEqual({ ok: false, code: 'STALE_GENERATION' });
        expect(w.shim.core.getState()).toBe('locked');
        expect(w.shim.core.inspectClosureVkForTest()).toBeNull();
        assertSecretsZeroed(w);
      }
    });
  });

  describe('CLIENT_BUSY', () => {
    it('rejects a second state-changing call without contacting the Worker and wipes its secret inputs; read-only calls and lock stay allowed', async () => {
      const w = world('client');
      const d = w.driver;
      expectOk(await d.call('unlockPassphrase', d.gen()), 'unlock');
      // hold a rewrap at the Worker (derive gate) through the public client
      w.derive.arm();
      const g = d.gen();
      const rewrapP = d.call('rewrap', g);
      await until(() => w.derive.parked, 'rewrap parked');

      const posted = d.posted();
      expect(await d.call('createVault', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('unlockPassphrase', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('unlockPrf', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('unlockDevKey', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('unlockRecovery', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('resumeRecovery', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('confirmRecovery', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(await d.call('rewrap', g)).toEqual({ ok: false, code: 'CLIENT_BUSY' });
      expect(d.posted()).toBe(posted);
      // read-only commands are not state-changing: they run concurrently against committed state
      expect(await d.call('sealEntry', g)).toMatchObject({ ok: true });
      expect(await d.call('makeRecoveryKeys', g)).toMatchObject({ ok: true });
      expect(d.posted()).toBe(posted + 2);

      w.derive.release();
      expect(await rewrapP).toMatchObject({ ok: true });
      // the slot is free again
      expectOk(await d.call('rewrap', g), 'rewrap after the slot freed');
    });

    it('wipes caller secret inputs of a CLIENT_BUSY call (Uint8Array and ArrayBuffer)', async () => {
      const w = world('client');
      const client = new CryptoClient({ createWorker: () => w.shim.port });
      worlds.push({ close: () => client.terminate() } as World);
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
      const pass = new TextEncoder().encode('secret-passphrase');
      await expect(
        client.createVault({ passphrase: pass, opGeneration: g }),
      ).rejects.toMatchObject({ code: 'CLIENT_BUSY' });
      expect(pass.every((b) => b === 0)).toBe(true);
      const pwkBuf = new Uint8Array(32).fill(7);
      await expect(
        client.unlockPrf({
          pwk: pwkBuf.buffer as ArrayBuffer,
          vkWrap: shared.vkWrap,
          opGeneration: g,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_BUSY' });
      expect(pwkBuf.every((b) => b === 0)).toBe(true);
      expect(w.shim.clientPostMessageCalls).toHaveLength(0);
      release();
      await first;
    });

    it('lock() is always allowed: it frees the slot, the superseded call settles STALE_GENERATION and the next unlock runs after it', async () => {
      const w = world('client');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      const g = d.gen();
      w.derive.arm();
      const oldP = d.call('unlockPassphrase', g);
      await until(() => w.derive.parked, 'unlockPassphrase parked');
      const lockP = d.call('lock', g);
      expect(await lockP).toMatchObject({ ok: true });
      const g2 = d.gen();
      expect(g2).toBe(g + 1);
      // the single-flight slot was freed by lock(): this is NOT CLIENT_BUSY; it queues behind the superseded command
      let newSettled = false;
      const newP = d.call('unlockPrf', g2).then((r) => {
        newSettled = true;
        return r;
      });
      await turns();
      expect(newSettled).toBe(false);
      w.derive.release();
      expect(await oldP).toEqual({ ok: false, code: 'STALE_GENERATION' });
      expect(await newP).toMatchObject({ ok: true });
      expect(d.mirror()).toMatchObject({ mode: 'unlocked', generation: g2 });
      expect(w.shim.core.getState()).toBe('unlocked');
    });
  });

  describe('BE4-4 / FE4-3 start-time whitelist: createVault and unlockPassphrase in recovering never reach the KDF', () => {
    for (const level of ['client', 'worker'] as const) {
      it(`${level}: VAULT_RECOVERING before any KDF for valid and invalid KDF params; keys, mode and secrets untouched`, async () => {
        const w = world(level);
        const d = w.driver;
        expectOk(await d.call('unlockRecovery', d.gen()), 'lookup');
        expectOk(await d.call('resumeRecovery', d.gen()), 'resume');
        expect(w.shim.core.getState()).toBe('recovering');
        w.derive.arm(); // the first KDF would park here; it must never be reached
        const epoch = w.shim.core.getEpoch();
        const vkBefore = w.shim.core.inspectClosureVkForTest();

        expect(await d.call('createVault', d.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
        expect(await d.call('unlockPassphrase', d.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
        expect(w.derive.parked).toBe(false);
        expect(w.derive.armed).toBe(true); // the KDF hook was never reached

        if (level === 'worker') {
          // invalid KDF params must not win over the recovery fence either
          const buf = new TextEncoder().encode('p').buffer as ArrayBuffer;
          const bad = await new Promise<WorkerResponseMessage>((resolveReply) => {
            w.shim.port.onmessage = (ev) => resolveReply(ev.data);
            w.shim.port.postMessage(
              {
                type: 'unlockPassphrase',
                id: 99,
                generation: d.gen(),
                passphraseBuffer: buf,
                kdf: { alg: 'argon2id13', ops: 1, mem: 1, parallelism: 1, salt: 'x' },
                vaultKeyWrappedByKek: 'x',
              },
              [buf],
            );
          });
          expect(bad).toMatchObject({ ok: false, error: { code: 'VAULT_RECOVERING' } });
          expect(w.derive.armed).toBe(true);
        }
        w.derive.release();
        expect(w.shim.core.getEpoch()).toBe(epoch);
        expect(w.shim.core.inspectClosureVkForTest()).toEqual(vkBefore);
        expect(w.shim.core.getState()).toBe('recovering');
        expect(nonZeroInboundSecrets(w.shim)).toEqual([]);
        expect(w.tracker.nonZero('recovering')).toEqual([]);
      });
    }
  });

  describe('wrapForDevice re-checks (mode, generation, epoch) after its LAST await (FE4-4)', () => {
    for (const change of ['unlockPrf', 'unlockRecoveryWrap', 'lock'] as const) {
      it(`parked at the second await (self-check decrypt), then ${change}`, async () => {
        const w = world('worker');
        const d = w.driver;
        expectOk(await d.call('unlockPassphrase', d.gen()), 'unlock');
        w.decrypt.arm();
        const p = d.call('wrapForDevice', d.gen());
        await until(() => w.decrypt.parked, 'wrapForDevice parked at the self-check decrypt (last await)');
        expectOk(await d.call(change, d.gen()), change);
        w.decrypt.release();
        expect(await p).toEqual({
          ok: false,
          code: change === 'unlockRecoveryWrap' ? 'VAULT_RECOVERING' : 'STALE_GENERATION',
        });
        expect(nonZeroInboundSecrets(w.shim)).toEqual([]);
        expect(w.tracker.nonZero(w.shim.core.getState()).map((a) => a.kind)).toEqual([]);
      });
    }
  });

  describe('Worker-owned VK / seed / wrap-key allocations are zeroed (FE4-4, T-r4-2)', () => {
    it('a rejected commit zeroes the temporary VK and seeds (unlockPassphrase parked, then lock)', async () => {
      const w = world('worker');
      const d = w.driver;
      expect(await d.call('sealEntry', d.gen())).toMatchObject({ code: 'VAULT_LOCKED' });
      w.derive.arm();
      const p = d.call('unlockPassphrase', d.gen());
      await until(() => w.derive.parked, 'unlockPassphrase parked');
      expectOk(await d.call('lock', d.gen()), 'lock');
      w.derive.release();
      expect(await p).toEqual({ ok: false, code: 'STALE_GENERATION' });
      const kinds = w.tracker.kinds();
      expect(kinds['aead-plaintext']).toBeGreaterThanOrEqual(2); // VK + combined seeds
      expect(kinds['seed-copy']).toBe(2);
      expect(kinds['closure-vk']).toBeUndefined(); // nothing was installed
      expect(w.tracker.nonZero()).toEqual([]);
    });

    it('a successful unlock zeroes its temporaries; the closure copies are zeroed by lock', async () => {
      const w = world('worker');
      const d = w.driver;
      expectOk(await d.call('unlockPassphrase', d.gen()), 'unlockPassphrase');
      expectOk(await d.call('lock', d.gen()), 'lock');
      expectOk(await d.call('unlockPrf', d.gen()), 'unlockPrf');
      expectOk(await d.call('lock', d.gen()), 'lock');
      expectOk(await d.call('unlockRecoveryWrap', d.gen()), 'unlockRecovery{wrap}');
      expectOk(await d.call('lock', d.gen()), 'lock');
      const kinds = w.tracker.kinds();
      expect(kinds['closure-vk']).toBe(3);
      expect(kinds['closure-seed']).toBe(6);
      expect(kinds['seed-copy']).toBe(6);
      expect(w.tracker.nonZero()).toEqual([]);
    });

    it('a rejected createVault in recovering allocates nothing; resumeRecovery zeroes its wrap-key copy and the pending wrap key', async () => {
      const w = world('worker');
      const d = w.driver;
      expectOk(await d.call('unlockRecovery', d.gen()), 'lookup');
      expect(w.tracker.nonZero().map((a) => a.kind)).toEqual(['hash32']); // the live pending wrap key
      expectOk(await d.call('resumeRecovery', d.gen()), 'resume');
      const kinds = w.tracker.kinds();
      expect(kinds['wrap-key-copy']).toBe(1);
      expect(w.tracker.nonZero('recovering')).toEqual([]);
      const before = w.tracker.allocations.length;
      expect(await d.call('createVault', d.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
      expect(w.tracker.allocations.length).toBe(before);
    });
  });

  describe('BE4-5 / T-r4-1 single state writer', () => {
    const STATE_VARS = new Set([
      'workerGeneration',
      'workerEpoch',
      'currentVk',
      'currentX25519Seed',
      'currentEd25519Seed',
      'pendingRecovery',
      'vaultMode',
    ]);

    function rootIdentifier(expr: ts.Expression): string | null {
      let cur: ts.Expression = expr;
      for (;;) {
        if (ts.isIdentifier(cur)) return cur.text;
        if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
          cur = cur.expression;
        } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
          cur = cur.expression;
        } else {
          return null;
        }
      }
    }

    function identifiersIn(node: ts.Node, out: string[]): void {
      if (ts.isIdentifier(node)) out.push(node.text);
      ts.forEachChild(node, (c) => identifiersIn(c, out));
    }

    it('every write to workerGeneration, workerEpoch, currentVk, seeds, pendingRecovery and vaultMode (assignment, compound, ++/--, in-place .set/.fill, destructuring, redeclaration) is inside commitTransition', () => {
      const file = resolve(__dirname, 'worker-core.ts');
      const source = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const outside: string[] = [];
      let inside = 0;

      const enclosingFunctions = (node: ts.Node): string[] => {
        const names: string[] = [];
        for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
          if (ts.isFunctionDeclaration(cur) && cur.name) names.push(cur.name.text);
          else if (
            (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) &&
            ts.isVariableDeclaration(cur.parent) &&
            ts.isIdentifier(cur.parent.name)
          ) {
            names.push(cur.parent.name.text);
          } else if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) names.push(cur.name.text);
        }
        return names;
      };

      const record = (node: ts.Node, name: string): void => {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (enclosingFunctions(node).includes('commitTransition')) inside += 1;
        else outside.push(`${name}@${line}`);
      };

      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          const names: string[] = [];
          if (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left)) {
            identifiersIn(node.left, names);
          } else {
            const root = rootIdentifier(node.left);
            if (root) names.push(root);
          }
          for (const n of names) if (STATE_VARS.has(n)) record(node, n);
        }
        if (
          (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
          const root = rootIdentifier(node.operand);
          if (root && STATE_VARS.has(root)) record(node, root);
        }
        if (ts.isDeleteExpression(node)) {
          const root = rootIdentifier(node.expression);
          if (root && STATE_VARS.has(root)) record(node, root);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['set', 'fill', 'copyWithin', 'reverse', 'sort'].includes(node.expression.name.text)
        ) {
          const root = rootIdentifier(node.expression.expression);
          if (root && STATE_VARS.has(root)) record(node, `${root}.${node.expression.name.text}()`);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && STATE_VARS.has(node.name.text)) {
          // only the single top-level `let` declarations inside createWorkerCore are allowed
          const fns = enclosingFunctions(node);
          if (!(fns.length === 1 && fns[0] === 'createWorkerCore')) record(node, `redeclare ${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      expect(outside).toEqual([]);
      // non-vacuity: the writers really are in commitTransition
      expect(inside).toBeGreaterThanOrEqual(15);
    });

    it('every committed transition bumps the epoch by exactly one (lookup, resume = dispose + enter, rewrap in recovering, confirm, lock); non-transitions do not', async () => {
      const w = world('worker');
      const d = w.driver;
      const core = w.shim.core;
      const epochs: number[] = [core.getEpoch()];
      const step = async (cmd: Parameters<typeof d.call>[0], what: string): Promise<void> => {
        expectOk(await d.call(cmd, d.gen()), what);
        epochs.push(core.getEpoch());
      };
      await step('unlockRecovery', 'lookup'); // install continuation
      await step('resumeRecovery', 'resume'); // dispose continuation + enter recovering
      await step('rewrap', 'rewrap in recovering');
      await step('confirmRecovery', 'confirm');
      await step('rewrap', 'rewrap while unlocked (not a transition)');
      await step('lock', 'lock');
      expect(epochs).toEqual([0, 1, 3, 4, 5, 5, 6]);
      // every reply reports the epoch at its own commit point
      expect(w.shim.workerPostMessageCalls.map((r) => r.state.epoch)).toEqual([1, 3, 4, 5, 5, 6]);
    });

    it('continuation disposal and locked-state generation adoption go through the commit point: observable epoch/generation/continuation behaviour', async () => {
      const w = world('worker');
      const d = w.driver;
      // fresh Worker (generation 0) adopts the caller's generation on its first command
      const core = w.shim.core;
      expect(core.getStateSnapshot()).toMatchObject({ generation: 0, epoch: 0 });
      const first = await new Promise<WorkerResponseMessage>((resolveReply) => {
        w.shim.port.onmessage = (ev) => resolveReply(ev.data);
        w.shim.port.postMessage(
          { type: 'sealEntry', id: 7, generation: 5, entryId: 'e', keyId: 'k', plaintext: new Uint8Array(1) },
          [],
        );
      });
      expect(first).toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
      expect(core.getStateSnapshot()).toMatchObject({ generation: 5, epoch: 1 }); // adoption is a counted transition
      expect(first.state).toEqual({ mode: 'locked', generation: 5, epoch: 1 });
      void d;
    });
  });
});
