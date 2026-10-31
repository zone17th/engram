// Opt-in: prints the generated state-fence matrix case list to the file given on the command line.
//   pnpm --filter @engram/web run matrix:list <output-file>
// The tests themselves never write files. Needs Node with native TypeScript type stripping (>= 22.18).
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outPath = process.argv.slice(2).find((arg) => arg !== '--');
if (!outPath) {
  console.error('usage: pnpm --filter @engram/web run matrix:list <output-file>');
  process.exit(2);
}

const { buildMatrixSpecs, buildQueueSpecs } = await import('../lib/crypto/test/matrix-specs.ts');
const names = [
  ...buildMatrixSpecs('client').map((s) => s.name),
  ...buildMatrixSpecs('worker').map((s) => s.name),
  ...buildQueueSpecs().map((s) => s.name),
];
const lines = names.map((n, i) => `${String(i + 1).padStart(4, '0')}. ${n}`);
writeFileSync(resolve(outPath), `${lines.join('\n')}\n`, 'utf8');
console.log(`wrote ${names.length} cases to ${resolve(outPath)}`);
