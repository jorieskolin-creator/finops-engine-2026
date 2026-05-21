import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-metrics-'));
const semanticsSource = await readFile(new URL('../src/services/antiPatternSemantics.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'antiPatternSemantics.mjs'), compile(semanticsSource), 'utf8');
const sourcePath = new URL('../src/services/metricsService.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const modulePath = join(dir, 'metricsService.mjs');
await writeFile(modulePath, compile(source).replace('./antiPatternSemantics', './antiPatternSemantics.mjs'), 'utf8');

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

const anti = (count, withEvidence = false, absenceStatus = undefined) => ({
  count,
  status: count === 0 ? 'OK' : count === 3 ? 'NOK' : 'Partial',
  evidence: withEvidence ? 'Confirmed anti-pattern evidence.' : 'No confirmed anti-pattern evidence.',
  evidence_quotes: withEvidence ? [{ quote: 'Confirmed anti-pattern evidence', category: 'Operational', evidence_source: 'text' }] : [],
  reasoning: withEvidence ? 'Evidence found.' : 'Not found.',
  is_silent: count === 0 && absenceStatus !== 'tested_absent',
  antipattern_absence_status: absenceStatus,
  coverage_reason: absenceStatus === 'tested_absent' ? 'Relevant source coverage reviewed; anti-pattern was not found.' : undefined
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
  assert.equal(result.metrics.antipattern_clearance, 0);
  assert.equal(result.metrics.antipattern_coverage, 0);
  assert.equal(result.unknown_antipattern_absences.length, 25);
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(0, true)
  ));
  assert.equal(result.crawl_walk_run, 'Run');
  assert.ok(result.metrics.finops_readiness >= 90, `expected high readiness, got ${result.metrics.finops_readiness}`);
  assert.equal(result.metrics.antipattern_burden_confidence, 'confirmed');
  assert.equal(result.metrics.antipattern_clearance, 100);
  assert.equal(result.metrics.antipattern_coverage, 100);
  assert.equal(result.verified_antipattern_absences.length, 25);
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(2, true)
  ));
  assert.ok(result.metrics.finops_readiness < result.metrics.maturity_depth, 'confirmed burden should reduce readiness');
  assert.ok(result.metrics.antipattern_burden > 50, 'fixture should contain high burden');
  assert.equal(result.metrics.antipattern_coverage, 100);
}

{
  const result = calculateMetrics(logs(
    (_id, index) => item(index < 8 ? 1 : 0, index < 3),
    () => anti(0, false)
  ));
  assert.equal(result.crawl_walk_run, 'Insufficient evidence');
  assert.ok(result.metrics.readiness_cap_reason, 'low evidence should explain readiness cap');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(0, false, 'tested_absent')
  ));
  assert.equal(result.metrics.evidence_density, 100, 'verified absence should count as evidence coverage even without finding quotes');
  assert.equal(result.metrics.antipattern_clearance, 100);
  assert.equal(result.metrics.antipattern_coverage, 100);
}

{
  const result = calculateMetrics(logs(
    () => item(0, true),
    () => anti(0, false)
  ));
  assert.equal(result.metrics.evidence_density, 50, 'quote-backed maturity gaps should count as verified source coverage');
  assert.equal(result.metrics.maturity_depth, 0, 'gap evidence must not improve maturity score');
  assert.equal(result.maturity_gaps.length, 25);
  assert.equal(result.silent_areas.length, 0, 'quote-backed maturity gaps should not be treated as silent');
  assert.match(result.maturity_gaps[0], /Confirmed gap/, 'quote-backed maturity gaps should be labelled as confirmed gaps');
}

{
  const result = calculateMetrics(logs(
    () => item(0, false),
    () => anti(0, false)
  ));
  assert.equal(result.metrics.evidence_density, 0, 'silent maturity gaps should not count as source coverage');
  assert.equal(result.silent_areas.length, 25, 'silent maturity gaps should remain silent areas');
  assert.match(result.maturity_gaps[0], /Missing/, 'silent maturity gaps should remain missing, not confirmed');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => ({ ...anti(0, false, 'unknown_absent'), coverage_reason: 'Source did not cover this anti-pattern.' })
  ));
  assert.equal(result.metrics.evidence_density, 50, 'unknown anti-pattern absence should not count as verified coverage');
  assert.equal(result.metrics.antipattern_clearance, 0);
}

console.log('metrics unit tests passed');
