import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildMatrixSpecs,
  MATRIX_CASES_PER_LEVEL,
} from './test/matrix-specs';
import { buildSharedArtifacts, runMatrixCase, type SharedArtifacts } from './test/fence-harness';

// Generated matrix, public CryptoClient (r5 fix-4). Every case runs the schedule in lock-step against an executable
// reference model, asserts the exact settlement of EVERY promise it created, the final Worker state and
// authoritative replies, the actual Worker-owned secret allocations, and a seal -> lock ->
// unlock-from-persisted-vault -> open round trip. The case list is printed only by `pnpm run matrix:list`.
describe('P03-T5 state-fence matrix (public CryptoClient)', () => {
  let shared: SharedArtifacts;
  const specs = buildMatrixSpecs('client');

  beforeAll(async () => {
    shared = await buildSharedArtifacts();
  });

  it('enumerates 15 commands x 5 start modes x 4 mode changes x 3 timings', () => {
    expect(specs).toHaveLength(MATRIX_CASES_PER_LEVEL);
    expect(MATRIX_CASES_PER_LEVEL).toBe(900);
    expect(new Set(specs.map((s) => s.name)).size).toBe(900);
  });

  it.each(specs)('$name', async (spec) => {
    await runMatrixCase(shared, spec);
  });
});
