import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const sourcePath = new URL('../src/services/metricsService.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-metrics-'));
const modulePath = join(dir, 'metricsService.mjs');
await writeFile(modulePath, compiled, 'utf8');

const { calculateMetrics } = await import(`file://${modulePath}`);

const ids = ['A', 'B', 'C', 'D', 'E'].flatMap(batch => [1, 2, 3, 4, 5].map(n => `${batch}${n}`));

const item = (count, withEvidence = false) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence: withEvidence ? 'Validated source evidence for this criterion.' : 'Document is silent.',
  evidence_quotes: withEvidence ? [{ quote: 'Validated source evidence', category: 'Operational', evidence_source: 'text' }] : [],
  reasoning: withEvidence ? 'Evidence found.' : 'Not found.',
  is_silent: count === 0
});

const anti = (count, withEvidence = false) => ({
  count,
  status: count === 0 ? 'OK' : count === 3 ? 'NOK' : 'Partial',
  evidence: withEvidence ? 'Confirmed anti-pattern evidence.' : 'No confirmed anti-pattern evidence.',
  evidence_quotes: withEvidence ? [{ quote: 'Confirmed anti-pattern evidence', category: 'Operational', evidence_source: 'text' }] : [],
  reasoning: withEvidence ? 'Evidence found.' : 'Not found.',
  is_silent: count === 0
});

const logs = (maturityFactory, antiFactory) => ({
  maturity: Object.fromEntries(ids.map((id, index) => [id, maturityFactory(id, index)])),
  antipattern: Object.fromEntries(ids.map((id, index) => [id, antiFactory(id, index)])),
});

{
  const result = calculateMetrics(logs(
    (_id, index) => item(index < 12 ? 1 : 0, index < 4),
    () => anti(0, false)
  ));
  assert.equal(result.crawl_walk_run, 'Insufficient evidence');
  assert.ok(result.metrics.finops_readiness < 30, `expected capped low readiness, got ${result.metrics.finops_readiness}`);
  assert.equal(result.metrics.antipattern_burden_confidence, 'unknown');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(0, true)
  ));
  assert.equal(result.crawl_walk_run, 'Run');
  assert.ok(result.metrics.finops_readiness >= 90, `expected high readiness, got ${result.metrics.finops_readiness}`);
  assert.equal(result.metrics.antipattern_burden_confidence, 'confirmed');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(2, true)
  ));
  assert.ok(result.metrics.finops_readiness < result.metrics.maturity_depth, 'confirmed burden should reduce readiness');
  assert.ok(result.metrics.antipattern_burden > 50, 'fixture should contain high burden');
}

{
  const result = calculateMetrics(logs(
    (_id, index) => item(index < 8 ? 1 : 0, index < 3),
    () => anti(0, false)
  ));
  assert.equal(result.crawl_walk_run, 'Insufficient evidence');
  assert.ok(result.metrics.readiness_cap_reason, 'low evidence should explain readiness cap');
}

console.log('metrics unit tests passed');
