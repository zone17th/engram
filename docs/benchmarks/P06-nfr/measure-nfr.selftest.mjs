// Self-test of the pure decision helpers of scripts/measure-nfr.mjs (no network, no browser).
// Run: node --test docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_4G,
  evaluateSemantic,
  evaluateServerPerf,
  goDurationMs,
  histogramQuantile,
  stats,
} from '../../../scripts/measure-nfr.mjs';

const SHA = 'a'.repeat(40);

function perfLog({ sha = SHA, pass = true, p95 = ['12.5ms', '40ms', '90ms'], semOn = null } = {}) {
  const names = ['pop1_sequential', 'pop2_burst_no_purge', 'pop3_burst_purge_overlap'];
  const lines = sha ? [`NFR_PERF_SHA=${sha}`] : [];
  names.forEach((n, i) => {
    if (p95[i] !== null) {
      lines.push(`    entry_create_perf_test.go:1143: POPULATION ${n}: samples=300 status_201=300 new_rows=300 body_mix=x p50=5ms p95=${p95[i]} p99=1s ceiling=150ms`);
    }
  });
  lines.push('    entry_create_perf_test.go:1133: POPULATION selfcheck_a_pop2_20ms: samples=10 p50=1s p95=900ms p99=1s ceiling=150ms');
  if (semOn) lines.push(`    entry_create_semantic_perf_test.go:744: SEMANTIC-ON POPULATION pop2_burst_no_purge: n=10 p50=1ms p95=${semOn} p99=1s max=1s ceiling=150ms`);
  lines.push(pass ? '--- PASS: TestEntryCreatePerformanceA10 (300.00s)' : '--- FAIL: TestEntryCreatePerformanceA10 (300.00s)');
  return lines.join('\n');
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

test('server p95: below passes; at, above, absent, wrong SHA, failed test, missing population fail', () => {
  const ok = evaluateServerPerf(perfLog(), SHA);
  assert.equal(ok.pass, true, ok.reason);
  assert.equal(ok.max_p95_ms, 90);
  assert.equal(evaluateServerPerf(perfLog({ p95: ['149.999ms', '1ms', '1ms'] }), SHA).pass, true);
  assert.equal(evaluateServerPerf(perfLog({ p95: ['150ms', '1ms', '1ms'] }), SHA).pass, false);
  assert.equal(evaluateServerPerf(perfLog({ p95: ['1ms', '1ms', '151ms'] }), SHA).pass, false);
  assert.equal(evaluateServerPerf(null, SHA).pass, false);
  assert.equal(evaluateServerPerf(perfLog({ sha: 'b'.repeat(40) }), SHA).pass, false);
  assert.equal(evaluateServerPerf(perfLog({ sha: null }), SHA).pass, false);
  assert.equal(evaluateServerPerf(perfLog({ pass: false }), SHA).pass, false);
  assert.equal(evaluateServerPerf(perfLog({ p95: ['1ms', null, '1ms'] }), SHA).pass, false);
});

test('server p95: semantic-on populations are gated, self-check populations are not', () => {
  assert.equal(evaluateServerPerf(perfLog({ semOn: '20ms' }), SHA).pass, true);
  const over = evaluateServerPerf(perfLog({ semOn: '160ms' }), SHA);
  assert.equal(over.pass, false);
  assert.equal(over.populations.pop2_burst_no_purge, 40);
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

const PROM = `# HELP embedding_provider_latency_seconds x
embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="1"} 4
embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="2.5"} 10
embedding_provider_latency_seconds_bucket{provider="openai_compat",op="query",le="+Inf"} 10
embedding_provider_latency_seconds_count{provider="openai_compat",op="query"} 10
embedding_provider_latency_seconds_count{provider="openai_compat",op="document"} 99
semantic_query_cache_total{result="hit"} 30
semantic_query_cache_total{result="miss"} 10
`;
const WORKER = 'embedding_jobs_total{kind="embed_item",outcome="ok"} 7\nembedding_jobs_total{kind="embed_tag",outcome="ok"} 2\n';

test('semantic: absent = pending, empty = invalid, no miss / no worker = pending states, full = collected', () => {
  assert.equal(evaluateSemantic([]).state, 'pending');
  assert.equal(evaluateSemantic(['garbage without samples\n# only comments']).state, 'invalid');
  assert.equal(evaluateSemantic(['semantic_query_cache_total{result="hit"} 3\n']).state, 'no_cache_miss_observed');
  assert.equal(evaluateSemantic([PROM]).state, 'partial');
  const full = evaluateSemantic([PROM, WORKER]);
  assert.equal(full.state, 'collected');
  assert.equal(full.provider_query_latency_ms.cache_miss_calls, 10);
  assert.equal(full.provider_query_latency_ms.p50, 1250);
  assert.deepEqual(full.query_cache, { hit: 30, miss: 10 });
  assert.deepEqual(full.embedding_jobs_total, { 'embed_item/ok': 7, 'embed_tag/ok': 2 });
});

test('semantic output carries no label values outside the allowlisted aggregates', () => {
  const leaky = `${PROM}${WORKER}search_requests_total{q="secret needle"} 1\n`;
  assert.ok(!JSON.stringify(evaluateSemantic([leaky])).includes('secret needle'));
});
