import { beforeAll, describe, expect, it } from 'vitest';
import { buildQueueSpecs } from './test/matrix-specs';
import { buildSharedArtifacts, runQueueCase, type SharedArtifacts } from './test/fence-harness';

// Worker serial-queue matrix (r5 fix-4): a state-changing command parked at its last await, every state-changing
// command queued behind it, with and without a `lock` preempting both. Executed against the reference model in
// lock-step, with the same final-state, secret-zeroing and persisted-vault round-trip assertions.
describe('P03-T5 Worker serial-queue matrix', () => {
  let shared: SharedArtifacts;
  const specs = buildQueueSpecs();

  beforeAll(async () => {
    shared = await buildSharedArtifacts();
  });

  it('enumerates 4 held x 9 queued x 5 start modes x 2 variants', () => {
    expect(specs).toHaveLength(360);
  });

  it.each(specs)('$name', async (spec) => {
    await runQueueCase(shared, spec);
  });
});
