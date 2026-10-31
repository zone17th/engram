import { afterEach, describe, expect, it } from 'vitest';
import { CryptoClient } from './client';
import { deriveKek, KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from './kdf';
import { passphraseToKdfBytes } from './passphrase';
import { hasLoneSurrogate, PASSPHRASE_INVALID_MESSAGE } from './protocol';
import { getSodium, type Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';

// P03-T5 r5 fix-5a: passphrase NFC normalization + lone-surrogate / invalid-UTF-8 rejection before Argon2id
// (user-dec-003 = A, FE1-13). No shared vector file is touched; the Go cross-check derives KEKs from raw bytes.

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const VI_NFC = 'Mật khẩu'; // "Mật khẩu", precomposed
const VI_NFD = VI_NFC.normalize('NFD'); // base letters + combining marks
const E_NFC = 'é-passphrase-xx'; // é
const E_NFD = 'é-passphrase-xx'; // e + U+0301

/** Fast deterministic KEK that also records exactly which bytes reached the KDF (and a handle to zero-check them). */
function recordingDerive() {
  const seen: string[] = [];
  const buffers: Uint8Array[] = [];
  const derive: DeriveKekFn = (sodium: Sodium, pass: Uint8Array, p: ValidatedKdfParams) => {
    seen.push(hex(pass));
    buffers.push(pass);
    const input = new Uint8Array(pass.byteLength + p.saltBytes.byteLength);
    input.set(pass, 0);
    input.set(p.saltBytes, pass.byteLength);
    return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
  };
  return { derive, seen, buffers };
}

describe('P03-T5 passphrase NFC + well-formedness (user-dec-003, FE1-13)', () => {
  const shims: ShimmedWorkerInstance[] = [];
  const clients: CryptoClient[] = [];

  afterEach(() => {
    while (clients.length > 0) clients.pop()?.terminate();
    while (shims.length > 0) shims.pop()?.close();
  });

  function makeClient(deriveKekHook?: DeriveKekFn) {
    const shim = createWorkerShim(deriveKekHook ? { deriveKek: deriveKekHook } : {});
    shims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });
    clients.push(client);
    return { shim, client };
  }

  describe('pure KDF-input function', () => {
    it('hasLoneSurrogate: lone high, lone low, reversed pair are bad; real pairs and BMP text are fine', () => {
      expect(hasLoneSurrogate('ab\uD83Dcd')).toBe(true);
      expect(hasLoneSurrogate('ab\uDE00cd')).toBe(true);
      expect(hasLoneSurrogate('\uDE00\uD83D')).toBe(true);
      expect(hasLoneSurrogate('end\uD83D')).toBe(true);
      expect(hasLoneSurrogate('\uDE00')).toBe(true);
      expect(hasLoneSurrogate('\uD83D😀')).toBe(true);
      expect(hasLoneSurrogate('ok \u{1F600} ok')).toBe(false);
      expect(hasLoneSurrogate(VI_NFD)).toBe(false);
      expect(hasLoneSurrogate('')).toBe(false);
    });

    it('NFD (and non-canonical combining order) maps to exactly the NFC UTF-8 bytes', () => {
      expect(VI_NFD).not.toBe(VI_NFC);
      expect(E_NFD).not.toBe(E_NFC);
      expect(hex(passphraseToKdfBytes(enc.encode(VI_NFD)))).toBe(hex(enc.encode(VI_NFC)));
      expect(hex(passphraseToKdfBytes(enc.encode(E_NFD)))).toBe(hex(enc.encode(E_NFC)));
      // a + U+0302 + U+0323 is not canonical order; NFC still composes to U+1EAD
      expect(hex(passphraseToKdfBytes(enc.encode('ậ')))).toBe(hex(enc.encode('ậ')));
    });

    it('already-NFC and ASCII passphrases give byte-identical KDF input to the pre-fix TextEncoder bytes', () => {
      const samples = [
        'correct horse battery staple',
        'matrix-baseline-passphrase',
        VI_NFC,
        E_NFC,
        'emoji \u{1F600} astral \u{20BB7}',
        '﻿leading-bom-is-kept',
        'a\u0000b',
        'x'.repeat(5000),
      ];
      for (const s of samples) {
        const out = passphraseToKdfBytes(enc.encode(s));
        expect(hex(out), JSON.stringify(s.slice(0, 20))).toBe(hex(enc.encode(s)));
      }
    });

    it('always returns a fresh buffer (the caller zeroes both the incoming and the KDF bytes independently)', () => {
      const incoming = enc.encode('plain-ascii');
      const out = passphraseToKdfBytes(incoming);
      expect(out).not.toBe(incoming);
      expect(out.buffer).not.toBe(incoming.buffer);
      out.fill(0);
      expect(incoming.some((b) => b !== 0)).toBe(true);
    });

    it('rejects invalid UTF-8 with PASSPHRASE_INVALID and a message that never echoes the input', () => {
      const bad: Uint8Array[] = [
        Uint8Array.of(0xc3, 0x28),
        Uint8Array.of(0xff, 0xfe, 0x41),
        Uint8Array.of(0xed, 0xa0, 0x80), // UTF-8 encoded surrogate (CESU-style)
        Uint8Array.of(0xc0, 0xaf), // overlong
        Uint8Array.of(0x41, 0xe2, 0x82), // truncated
      ];
      for (const b of bad) {
        let caught: unknown;
        try {
          passphraseToKdfBytes(b);
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ name: 'CryptoWorkerError', code: 'PASSPHRASE_INVALID' });
        expect((caught as Error).message).toBe(PASSPHRASE_INVALID_MESSAGE);
      }
    });

    it('KDF-level vector: real Argon2id (fixed salt, ops=3, 64 MiB) gives one pinned KEK for NFD and NFC input', async () => {
      const sodium = await getSodium();
      const kdf = { alg: 'argon2id13', ops: 3, mem: 67_108_864, parallelism: 1, salt: 'AAECAwQFBgcICQoLDA0ODw' };
      // The expected KEK was derived once from the pre-fix input (raw NFC UTF-8 bytes 4de1baad74206b68e1baa975).
      const EXPECTED_KEK = '1f6a74e7e58e8e94d3fa655cce87efac5fd41d81a256a6d47bf68537d4b8b4f9';
      expect(hex(enc.encode(VI_NFC))).toBe('4de1baad74206b68e1baa975');
      const fromNfc = await deriveKek(sodium, passphraseToKdfBytes(enc.encode(VI_NFC)), kdf);
      const fromNfd = await deriveKek(sodium, passphraseToKdfBytes(enc.encode(VI_NFD)), kdf);
      expect(hex(fromNfc)).toBe(EXPECTED_KEK);
      expect(hex(fromNfd)).toBe(EXPECTED_KEK);
      // without the rule, the raw NFD bytes would derive a different KEK (the bug this fixes)
      const raw = await deriveKek(sodium, enc.encode(VI_NFD), kdf);
      expect(hex(raw)).not.toBe(EXPECTED_KEK);
    }, 60_000);
  });

  describe('public client: NFD and NFC are the same passphrase', () => {
    it('createVault(NFD) -> lock -> unlockPassphrase(NFC) and unlockPassphrase(NFD) open the same vault; KDF bytes are the NFC bytes', async () => {
      for (const [nfd, nfc] of [
        [VI_NFD, VI_NFC],
        [E_NFD, E_NFC],
      ] as const) {
        const rec = recordingDerive();
        const { client } = makeClient(rec.derive);
        const created = await client.createVault({
          passphrase: nfd,
          skipRecoveryKeys: true,
          opGeneration: client.captureGeneration(),
        });
        await client.lock();
        const unlockParams = {
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
        };
        await client.unlockPassphrase({
          ...unlockParams,
          passphrase: nfc,
          opGeneration: client.captureGeneration(),
        });
        expect(client.getState()).toBe('unlocked');
        await client.lock();
        await client.unlockPassphrase({
          ...unlockParams,
          passphrase: nfd,
          opGeneration: client.captureGeneration(),
        });
        expect(client.getState()).toBe('unlocked');
        await client.lock();
        // a genuinely different passphrase still fails (the round trip is not vacuous)
        await expect(
          client.unlockPassphrase({
            ...unlockParams,
            passphrase: `${nfc}!`,
            opGeneration: client.captureGeneration(),
          }),
        ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });
        expect(new Set(rec.seen.slice(0, 3))).toEqual(new Set([hex(enc.encode(nfc))]));
        // every KDF buffer was zeroed after use
        for (const b of rec.buffers) expect(b.every((x) => x === 0)).toBe(true);
      }
    });

    it('real Argon2id: createVault(NFD) -> lock -> unlockPassphrase(NFC)', async () => {
      const { client } = makeClient();
      const created = await client.createVault({
        passphrase: VI_NFD,
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      await client.lock();
      await client.unlockPassphrase({
        passphrase: VI_NFC,
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: client.captureGeneration(),
      });
      expect(client.getState()).toBe('unlocked');
    }, 60_000);

    it('rewrap(NFD) -> lock -> unlockPassphrase(NFC) with the rewrapped wrap', async () => {
      const rec = recordingDerive();
      const { client } = makeClient(rec.derive);
      const created = await client.createVault({
        passphrase: 'initial-ascii-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      const rewrapped = await client.rewrap({
        passphrase: VI_NFD,
        currentKdf: created.kdf,
        opGeneration: client.captureGeneration(),
      });
      expect(rec.seen.at(-1)).toBe(hex(enc.encode(VI_NFC)));
      await client.lock();
      await client.unlockPassphrase({
        passphrase: VI_NFC,
        kdf: rewrapped.kdf,
        vaultKeyWrappedByKek: rewrapped.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: client.captureGeneration(),
      });
      expect(client.getState()).toBe('unlocked');
    });

    it('ASCII / already-NFC passphrases reach the KDF byte-identical to TextEncoder (regression)', async () => {
      const rec = recordingDerive();
      const { client } = makeClient(rec.derive);
      await client.createVault({
        passphrase: 'plain ascii passphrase 123',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      await client.lock();
      const created = await client.createVault({
        passphrase: VI_NFC,
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      expect(created.kdf.alg).toBe('argon2id13');
      expect(rec.seen).toEqual([
        hex(enc.encode('plain ascii passphrase 123')),
        hex(enc.encode(VI_NFC)),
      ]);
    });
  });

  describe('PASSPHRASE_INVALID before any KDF call', () => {
    const badStrings: Array<[string, string]> = [
      ['lone high surrogate', 'secret\uD83Dpassphrase'],
      ['lone low surrogate', 'secret\uDE00passphrase'],
      ['reversed pair', 'secret\uDE00\uD83Dpassphrase'],
    ];

    it('client string input with a lone surrogate rejects createVault / unlockPassphrase / rewrap without Worker contact or KDF', async () => {
      const rec = recordingDerive();
      const { shim, client } = makeClient(rec.derive);
      const created = await client.createVault({
        passphrase: 'valid-initial-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      const kdfCalls = rec.seen.length;
      const posted = shim.clientPostMessageCalls.length;
      for (const [label, bad] of badStrings) {
        const calls: Array<[string, () => Promise<unknown>]> = [
          [
            'createVault',
            () => client.createVault({ passphrase: bad, opGeneration: client.captureGeneration() }),
          ],
          [
            'unlockPassphrase',
            () =>
              client.unlockPassphrase({
                passphrase: bad,
                kdf: created.kdf,
                vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
                opGeneration: client.captureGeneration(),
              }),
          ],
          [
            'rewrap',
            () =>
              client.rewrap({
                passphrase: bad,
                currentKdf: created.kdf,
                opGeneration: client.captureGeneration(),
              }),
          ],
        ];
        for (const [name, call] of calls) {
          let caught: unknown;
          try {
            await call();
          } catch (err) {
            caught = err;
          }
          expect(caught, `${name} ${label}`).toMatchObject({
            name: 'CryptoClientError',
            code: 'PASSPHRASE_INVALID',
          });
          expect((caught as Error).message).toBe(PASSPHRASE_INVALID_MESSAGE);
        }
      }
      expect(rec.seen.length).toBe(kdfCalls);
      expect(shim.clientPostMessageCalls.length).toBe(posted);
      expect(client.getState()).toBe('unlocked');
      // the single-flight slot was released: a valid call still runs
      const rewrapped = await client.rewrap({
        passphrase: 'valid-next-passphrase',
        currentKdf: created.kdf,
        opGeneration: client.captureGeneration(),
      });
      expect(rewrapped.kdf.salt).not.toBe(created.kdf.salt);
    });

    it('invalid UTF-8 bytes input is rejected in the Worker (PASSPHRASE_INVALID), the received buffer is wiped, no KDF call, state unchanged', async () => {
      const bad = [
        () => Uint8Array.of(0x73, 0x65, 0x63, 0xc3, 0x28, 0x72, 0x65, 0x74),
        () => Uint8Array.of(0xff, 0xfe, 0x73, 0x65, 0x63),
        () => Uint8Array.of(0x73, 0xed, 0xa0, 0x80, 0x65, 0x63),
      ];
      const rec = recordingDerive();
      const { shim, client } = makeClient(rec.derive);

      for (const make of bad) {
        // createVault on a locked client
        await expect(
          client.createVault({ passphrase: make(), opGeneration: client.captureGeneration() }),
        ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' });
        expect(client.getState()).toBe('locked');
        expect(shim.core.getState()).toBe('locked');
      }
      const created = await client.createVault({
        passphrase: 'valid-initial-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      const kdfCalls = rec.seen.length;
      await client.lock();
      for (const make of bad) {
        await expect(
          client.unlockPassphrase({
            passphrase: make(),
            kdf: created.kdf,
            vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
            privateKeysWrapped: created.private_keys_wrapped,
            opGeneration: client.captureGeneration(),
          }),
        ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' });
        expect(shim.core.getState()).toBe('locked');
      }
      await client.unlockPassphrase({
        passphrase: 'valid-initial-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: client.captureGeneration(),
      });
      const kdfAfterUnlock = rec.seen.length;
      expect(kdfAfterUnlock).toBe(kdfCalls + 1);
      for (const make of bad) {
        await expect(
          client.rewrap({
            passphrase: make(),
            currentKdf: created.kdf,
            opGeneration: client.captureGeneration(),
          }),
        ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' });
        expect(shim.core.getState()).toBe('unlocked');
      }
      // no KDF call for any rejected input
      expect(rec.seen.length).toBe(kdfAfterUnlock);

      // every passphrase buffer the Worker received for a rejected call was zeroed
      const received = shim.workerReceivedRequests.filter(
        (m) => 'passphraseBuffer' in m && (m.passphraseBuffer as ArrayBuffer).byteLength > 0,
      );
      expect(received.length).toBeGreaterThanOrEqual(bad.length * 3);
      for (const m of received) {
        const buf = new Uint8Array((m as { passphraseBuffer: ArrayBuffer }).passphraseBuffer);
        expect(buf.every((b) => b === 0)).toBe(true);
      }
    });

    it('the error message does not echo the passphrase', async () => {
      const { client } = makeClient(recordingDerive().derive);
      for (const pass of ['pw\uD83Dtail', Uint8Array.of(0x70, 0x77, 0xc3, 0x28)] as const) {
        let caught: unknown;
        try {
          await client.createVault({
            passphrase: pass,
            opGeneration: client.captureGeneration(),
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ code: 'PASSPHRASE_INVALID' });
        expect((caught as Error).message).toBe(PASSPHRASE_INVALID_MESSAGE);
      }
    });
  });
});
