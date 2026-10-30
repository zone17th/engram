'use client';

import { useEffect, useRef, useState } from 'react';
import { CryptoClient, CryptoClientError } from '@/lib/crypto/client';

export interface HarnessStepResult {
  step: string;
  ok: boolean;
  state: string;
  details: Record<string, string | number | boolean>;
}

export interface HarnessSummary {
  status: 'idle' | 'running' | 'done' | 'error';
  allPassed: boolean;
  steps: HarnessStepResult[];
  cspViolations: string[];
  errorMessage?: string;
  errorCode?: string;
}

const FIXED_TEST_PASSPHRASE = 'engram-p03-t5-e2e-fixed-test-passphrase-01';
const FIXED_WRONG_PASSPHRASE = 'engram-p03-t5-e2e-wrong-test-passphrase-99';
const FIXED_ENTRY_ID = '018f3a40-0000-7000-8000-000000000001';
const FIXED_KEY_ID = 'vk:ABCDEFGHIJKLMNOPQRSTUV';
const FIXED_PLAINTEXT = 'engram-p03-t5-e2e-public-fixture-payload';

export function CryptoHarnessClient() {
  const [summary, setSummary] = useState<HarnessSummary>({
    status: 'idle',
    allPassed: false,
    steps: [],
    cspViolations: [],
  });
  const activeRunRef = useRef<number>(0);

  useEffect(() => {
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;

    const cspViolations: string[] = [];
    const onCspViolation = (event: SecurityPolicyViolationEvent) => {
      cspViolations.push(`${event.violatedDirective}:${event.blockedURI}`);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('securitypolicyviolation', onCspViolation);
    }

    // Instantiate the real CryptoClient using its defaultWorkerFactory (module Worker -> worker.ts)
    const client = new CryptoClient();
    const steps: HarnessStepResult[] = [];

    const runHarness = async () => {
      setSummary({ status: 'running', allPassed: false, steps: [], cspViolations: [] });
      try {
        // Step 1: createVault (real Argon2id 64 MiB in module Worker)
        const createGen = client.captureGeneration();
        const created = await client.createVault({
          passphrase: FIXED_TEST_PASSPHRASE,
          opGeneration: createGen,
        });

        const createOk =
          client.getState() === 'unlocked' &&
          created.kdf.alg === 'argon2id13' &&
          created.kdf.ops === 3 &&
          created.kdf.mem === 67_108_864 &&
          created.kdf.parallelism === 1 &&
          typeof created.vault_key_wrapped_by_kek === 'string' &&
          created.vault_key_wrapped_by_kek.length > 0 &&
          typeof created.private_keys_wrapped === 'string' &&
          created.private_keys_wrapped.length > 0 &&
          created.recovery_keys.length === 10;

        steps.push({
          step: 'createVault',
          ok: createOk,
          state: client.getState(),
          details: {
            kdfAlg: created.kdf.alg,
            kdfOps: created.kdf.ops,
            kdfMem: created.kdf.mem,
            kdfParallelism: created.kdf.parallelism,
            recoveryKeysCount: created.recovery_keys.length,
            hasWrappedVk: created.vault_key_wrapped_by_kek.length > 0,
            hasWrappedPriv: created.private_keys_wrapped.length > 0,
          },
        });
        if (!createOk) {
          throw new Error('createVault assertions failed');
        }

        // Step 2: lock
        const lockRes1 = await client.lock();
        const lock1Ok = client.getState() === 'locked' && lockRes1.generation > createGen;
        steps.push({
          step: 'lockAfterCreate',
          ok: lock1Ok,
          state: client.getState(),
          details: {
            generation: lockRes1.generation,
          },
        });
        if (!lock1Ok) {
          throw new Error('lockAfterCreate assertions failed');
        }

        // Step 3: unlockPassphrase with correct fixed test passphrase
        const unlockGen = client.captureGeneration();
        const unlocked = await client.unlockPassphrase({
          passphrase: FIXED_TEST_PASSPHRASE,
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: unlockGen,
        });
        const unlockOk = unlocked.unlocked && client.getState() === 'unlocked';
        steps.push({
          step: 'unlockPassphrase',
          ok: unlockOk,
          state: client.getState(),
          details: {
            unlocked: unlocked.unlocked,
          },
        });
        if (!unlockOk) {
          throw new Error('unlockPassphrase assertions failed');
        }

        // Step 4: sealEntry -> openEntry round trip
        const sealGen = client.captureGeneration();
        const sealed = await client.sealEntry({
          entryId: FIXED_ENTRY_ID,
          keyId: FIXED_KEY_ID,
          plaintext: FIXED_PLAINTEXT,
          opGeneration: sealGen,
        });
        const openGen = client.captureGeneration();
        const opened = await client.openEntry({
          entryId: FIXED_ENTRY_ID,
          envelope: sealed.envelope,
          ciphertext: sealed.ciphertext,
          opGeneration: openGen,
        });
        const roundTripOk =
          opened.plaintext === FIXED_PLAINTEXT &&
          sealed.envelope.v === 1 &&
          sealed.envelope.alg === 'xchacha20poly1305-ietf' &&
          sealed.envelope.ct_enc === 'utf8' &&
          sealed.envelope.key_id === FIXED_KEY_ID &&
          sealed.ciphertext.length > 0;

        steps.push({
          step: 'sealAndOpenEntry',
          ok: roundTripOk,
          state: client.getState(),
          details: {
            envelopeVersion: sealed.envelope.v,
            envelopeAlg: sealed.envelope.alg,
            roundTripMatched: opened.plaintext === FIXED_PLAINTEXT,
            plaintextByteLength: opened.plaintext.length,
          },
        });
        if (!roundTripOk) {
          throw new Error('sealAndOpenEntry assertions failed');
        }

        // Step 5: lock before wrong-passphrase attempt
        const lockRes2 = await client.lock();
        const lock2Ok = client.getState() === 'locked' && lockRes2.generation > openGen;
        steps.push({
          step: 'lockBeforeWrongPassphrase',
          ok: lock2Ok,
          state: client.getState(),
          details: {
            generation: lockRes2.generation,
          },
        });
        if (!lock2Ok) {
          throw new Error('lockBeforeWrongPassphrase assertions failed');
        }

        // Step 6: wrong passphrase gives AEAD_DECRYPT_FAILED while keeping vault locked
        const wrongGen = client.captureGeneration();
        let observedWrongCode = 'NONE';
        try {
          await client.unlockPassphrase({
            passphrase: FIXED_WRONG_PASSPHRASE,
            kdf: created.kdf,
            vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
            privateKeysWrapped: created.private_keys_wrapped,
            opGeneration: wrongGen,
          });
        } catch (err) {
          if (err instanceof CryptoClientError) {
            observedWrongCode = err.code;
          } else if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            typeof err.code === 'string'
          ) {
            observedWrongCode = err.code;
          } else {
            observedWrongCode = 'UNKNOWN';
          }
        }

        const wrongPassphraseOk =
          observedWrongCode === 'AEAD_DECRYPT_FAILED' && client.getState() === 'locked';
        steps.push({
          step: 'wrongPassphrase',
          ok: wrongPassphraseOk,
          state: client.getState(),
          details: {
            errorCode: observedWrongCode,
          },
        });
        if (!wrongPassphraseOk) {
          throw new Error(
            `wrongPassphrase expected AEAD_DECRYPT_FAILED in locked state, got code=${observedWrongCode} state=${client.getState()}`,
          );
        }

        if (activeRunRef.current !== runId) return;
        setSummary({
          status: 'done',
          allPassed: steps.length === 6 && steps.every((s) => s.ok) && cspViolations.length === 0,
          steps: [...steps],
          cspViolations: [...cspViolations],
        });
      } catch (err) {
        if (activeRunRef.current !== runId) return;
        const errCode =
          err instanceof CryptoClientError
            ? err.code
            : typeof err === 'object' &&
                err !== null &&
                'code' in err &&
                typeof err.code === 'string'
              ? err.code
              : 'HARNESS_ERROR';
        const errMsg = err instanceof Error ? err.message : String(err);
        setSummary({
          status: 'error',
          allPassed: false,
          steps: [...steps],
          cspViolations: [...cspViolations],
          errorCode: errCode,
          errorMessage: errMsg,
        });
      }
    };

    void runHarness();

    return () => {
      activeRunRef.current += 1;
      if (typeof document !== 'undefined') {
        document.removeEventListener('securitypolicyviolation', onCspViolation);
      }
      client.terminate();
    };
  }, []);

  return (
    <main style={{ fontFamily: 'monospace', padding: '16px', maxWidth: '720px' }}>
      <h1>engram P03-T5 Real Crypto Worker E2E Harness (Dev-Only)</h1>
      <p data-testid="harness-status">
        <strong>Status:</strong> {summary.status}
      </p>
      <p data-testid="harness-all-passed">
        <strong>All Passed:</strong> {String(summary.allPassed)}
      </p>
      {summary.errorMessage && (
        <p data-testid="harness-error" style={{ color: 'red' }}>
          Error ({summary.errorCode}): {summary.errorMessage}
        </p>
      )}
      <pre
        data-testid="harness-result-json"
        style={{
          padding: '12px',
          border: '1px solid #888',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(summary, null, 2)}
      </pre>
    </main>
  );
}
