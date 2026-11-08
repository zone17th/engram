// Self-test of the pure decision helpers of scripts/measure-nfr.mjs (no network, no browser).
// Run: node --test docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_4G,
  decide,
  evaluateSemantic,
  evaluateServerPerf,
  goDurationMs,
  histogramQuantile,
  semanticCriterion,
  stats,
} from '../../../scripts/measure-nfr.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const POPS = ['pop1_sequential', 'pop2_burst_no_purge', 'pop3_burst_purge_overlap'];

// One framed `go test -tags perf ./internal/perf/... -v` run, shaped like the real output.
function run({ sha = A, endSha = sha, exit = 0, p95 = ['12.5ms', '40ms', '90ms'], semP95 = ['20ms', '50ms', '100ms'], pass = true, semPass = true, ok = true, extra = '' } = {}) {
  const l = [`NFR_PERF_BEGIN sha=${sha}`, '=== RUN   TestEntryCreatePerformanceA10'];
  POPS.forEach((n, i) => {
    if (p95[i] !== null) l.push(`    entry_create_perf_test.go:1143: POPULATION ${n}: samples=300 status_201=300 new_rows=300 body_mix=x p50=5ms p95=${p95[i]} p99=1s ceiling=150ms`);
  });
  l.push('    entry_create_perf_test.go:1133: POPULATION selfcheck_a_pop2_20ms: samples=10 p50=1s p95=900ms p99=1s ceiling=150ms');
  l.push(`--- ${pass ? 'PASS' : 'FAIL'}: TestEntryCreatePerformanceA10 (300.00s)`);
  l.push('=== RUN   TestEntryCreatePerformanceA10SemanticOn');
  POPS.forEach((n, i) => {
    l.push(`    entry_create_perf_test.go:1143: POPULATION sem_${n}: samples=10 p50=1ms p95=999ms p99=1s ceiling=150ms`);
    l.push(`    entry_create_semantic_perf_test.go:744: SEMANTIC-ON POPULATION ${n}: n=10 p50=1ms p95=${semP95[i]} p99=1s max=1s ceiling=150ms`);
    l.push(`    entry_create_semantic_perf_test.go:749: SEMANTIC-ON POPULATION ${n}: item-row lock waits (no ceiling)`);
  });
  l.push(`--- ${semPass ? 'PASS' : 'FAIL'}: TestEntryCreatePerformanceA10SemanticOn (200.00s)`);
  if (extra) l.push(extra);
  l.push(ok ? 'ok  \tgithub.com/zone17th/engram/apps/api/internal/perf\t500.1s' : 'FAIL\tgithub.com/zone17th/engram/apps/api/internal/perf\t500.1s');
  l.push(`NFR_PERF_END sha=${endSha} exit=${exit}`);
  return l.join('\n');
}

test('Fast 4G profile is exactly 9/3 Mbps decimal, 40 ms', () => {
  assert.equal(FAST_4G.downloadThroughput, 1_125_000);
  assert.equal(FAST_4G.uploadThroughput, 375_000);
  assert.equal(FAST_4G.latency, 40);
});

test('stats are unrounded so strict thresholds hold at the boundary', () => {
  assert.ok(stats([199.96]).p95 < 200);
  assert.ok(!(stats([200]).p95 < 200));
  assert.ok(stats([1999.96]).p75 < 2000);
  assert.ok(!(stats([2000.04]).p50 < 2000));
});

test('Go durations parse to ms', () => {
  assert.equal(goDurationMs('812.5µs'), 0.8125);
  assert.equal(goDurationMs('12.3ms'), 12.3);
  assert.equal(goDurationMs('1.2s'), 1200);
  assert.equal(goDurationMs('nope'), null);
});

test('server p95: one valid framed same-SHA run passes; boundary 150 ms fails', () => {
  const ok = evaluateServerPerf(run(), A);
  assert.equal(ok.pass, true, ok.reason);
  assert.equal(ok.max_p95_ms, 100);
  assert.equal(evaluateServerPerf(run({ p95: ['149.999ms', '1ms', '1ms'] }), A).pass, true);
  assert.equal(evaluateServerPerf(run({ p95: ['150ms', '1ms', '1ms'] }), A).pass, false);
  assert.equal(evaluateServerPerf(run({ semP95: ['1ms', '151ms', '1ms'] }), A).pass, false);
});

test('server p95: missing, foreign, stale, mixed, duplicated, truncated and failed evidence fail', () => {
  const cases = {
    absent: null,
    'foreign sha': run({ sha: B }),
    'no frame (old NFR_PERF_SHA format)': `NFR_PERF_SHA=${A}\n${run().split('\n').slice(1, -1).join('\n')}`,
    'mixed A/B markers': run({ sha: A, endSha: B }),
    'marker A then passing segment B': `NFR_PERF_BEGIN sha=${A}\n${run({ sha: B })}`,
    'earlier pass then failed run, same sha': `${run()}\n${run({ pass: false, exit: 1, ok: false })}`,
    'duplicate passing runs': `${run()}\n${run()}`,
    'truncated (no END)': run().split('\n').slice(0, -1).join('\n'),
    'truncated (no ok line)': run({ ok: false }),
    'perf command exit 1': run({ exit: 1 }),
    'A10 FAIL': run({ pass: false }),
    'SemanticOn FAIL': run({ semPass: false }),
    'panic inside run': run({ extra: 'panic: boom' }),
    'missing population': run({ p95: ['1ms', null, '1ms'] }),
    'duplicate population line': run({ extra: `    x.go:1: POPULATION pop1_sequential: samples=1 p50=1ms p95=1ms p99=1ms ceiling=150ms` }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = evaluateServerPerf(text, A);
    assert.equal(r.pass, false, `${name} must fail`);
    assert.ok(r.reason, `${name} must give a reason`);
  }
});

test('histogram quantile interpolates cumulative buckets', () => {
  const b = [
    { le: 0.1, count: 0 },
    { le: 1, count: 50 },
    { le: 5, count: 100 },
    { le: Infinity, count: 100 },
  ];
  assert.equal(histogramQuantile(0.5, b), 1);
  assert.equal(histogramQuantile(0.95, b), 4.6);
  assert.equal(histogramQuantile(0.5, []), null);
});

const OC = `embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="1"} 4
embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="2.5"} 10
embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="+Inf"} 10
embedding_provider_latency_seconds_count{provider="openai_compat",op="query"} 10
embedding_provider_latency_seconds_count{provider="openai_compat",op="document"} 99
semantic_query_cache_total{result="hit"} 30
semantic_query_cache_total{result="miss"} 10
`;
const TEI = `embedding_provider_latency_seconds_bucket{provider="tei",op="query",le="0.01"} 100
embedding_provider_latency_seconds_bucket{provider="tei",op="query",le="+Inf"} 100
embedding_provider_latency_seconds_count{provider="tei",op="query"} 100
`;
const WORKER = 'embedding_jobs_total{kind="embed_item",outcome="ok"} 7\nembedding_jobs_total{kind="embed_tag",outcome="ok"} 2\n';

test('semantic: only a complete openai_compat histogram plus jobs is "collected"', () => {
  assert.equal(evaluateSemantic([]).state, 'pending');
  assert.equal(evaluateSemantic(['garbage without samples\n# only comments']).state, 'invalid');
  assert.equal(evaluateSemantic(['semantic_query_cache_total{result="hit"} 3\n']).state, 'no_cache_miss_observed');
  assert.equal(evaluateSemantic([TEI, WORKER]).state, 'no_cache_miss_observed', 'TEI-only cannot complete');
  assert.equal(evaluateSemantic(['embedding_provider_latency_seconds_count{provider="openai_compat",op="query"} 5\n', WORKER]).state, 'invalid_latency', 'count without buckets');
  assert.equal(evaluateSemantic([OC.replace('le="+Inf"} 10', 'le="+Inf"} 9'), WORKER]).state, 'invalid_latency', '+Inf != count');
  assert.equal(evaluateSemantic([OC]).state, 'partial');
  const full = evaluateSemantic([OC, TEI, WORKER]);
  assert.equal(full.state, 'collected');
  assert.equal(full.provider_query_latency_ms.cache_miss_calls, 10, 'TEI calls excluded');
  assert.equal(full.provider_query_latency_ms.p50, 1250, 'TEI buckets excluded');
  assert.deepEqual(full.query_cache, { hit: 30, miss: 10 });
  assert.deepEqual(full.embedding_jobs_total, { 'embed_item/ok': 7, 'embed_tag/ok': 2 });
});

test('semantic output carries no label values outside the allowlisted aggregates', () => {
  const leaky = `${OC}${WORKER}search_requests_total{q="secret needle"} 1\n`;
  assert.ok(!JSON.stringify(evaluateSemantic([leaky])).includes('secret needle'));
});

test('real-run decision: any non-pass criterion (pending/skipped/fail) is not met; dry-run tolerates pending/skipped', () => {
  const okCrit = { id: 'x', status: 'pass', value: 1 };
  for (const state of [evaluateSemantic([]), evaluateSemantic([TEI, WORKER]), evaluateSemantic([OC])]) {
    const c = semanticCriterion(state, false);
    assert.equal(c.status, 'fail', `${state.state} must fail a real run`);
    const d = decide([okCrit, c], false);
    assert.equal(d.pass, false);
    assert.equal(d.complete, false);
    assert.equal(d.notMet[0].id, 'semantic.observed');
  }
  const collected = semanticCriterion(evaluateSemantic([OC, WORKER]), false);
  assert.deepEqual(decide([okCrit, collected], false), { pass: true, complete: true, notMet: [] });
  assert.equal(decide([okCrit, { id: 'p', status: 'pending' }], false).pass, false);
  assert.equal(decide([okCrit, { id: 's', status: 'skipped' }], false).pass, false);
  const dry = decide([okCrit, semanticCriterion(evaluateSemantic([OC]), true), { id: 's', status: 'skipped' }], true);
  assert.equal(dry.pass, true);
  assert.equal(dry.complete, false);
  assert.equal(semanticCriterion({ state: 'invalid', reason: 'x' }, true).status, 'fail');
});
