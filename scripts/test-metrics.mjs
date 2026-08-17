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
const source = (await readFile(sourcePath, 'utf8')).replace(
  "import { BATCH_TITLES, FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';",
  "const BATCH_TITLES = { A: '', B: '', C: '', D: '', E: '', F: '' }; const FINOPS_ANTIPATTERNS = Array(30); const FINOPS_CRITERIA = Array(30);"
);
const modulePath = join(dir, 'metricsService.mjs');
await writeFile(modulePath, compile(source).replace('./antiPatternSemantics', './antiPatternSemantics.mjs'), 'utf8');

const { applyQualityGateScoreCap, calculateMetrics } = await import(`file://${modulePath}`);

const reportViewSource = (await readFile(new URL('../src/services/reportViewModel.ts', import.meta.url), 'utf8'))
  .replace(
    "import { FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';",
    "const FINOPS_CRITERIA = Array.from({ length: 30 }, (_, index) => ({ id: `M${index + 1}` })); const FINOPS_ANTIPATTERNS = Array.from({ length: 30 }, (_, index) => ({ id: `A${index + 1}` }));"
  )
  .replace('./antiPatternSemantics', './antiPatternSemantics.mjs');
await writeFile(join(dir, 'reportViewModel.mjs'), compile(reportViewSource), 'utf8');
const { buildReportViewModel } = await import(`file://${join(dir, 'reportViewModel.mjs')}`);

const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(batch => [1, 2, 3, 4, 5].map(n => `${batch}${n}`));

const item = (count, withEvidence = false) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence: withEvidence ? 'Validated source evidence for this criterion.' : 'Document is silent.',
  evidence_quotes: withEvidence ? [{ quote: 'Validated source evidence', category: 'Operational', evidence_source: 'text' }] : [],
  assessment_status: withEvidence ? 'assessed' : 'not_assessed',
  question_results: withEvidence
    ? Array.from({ length: 3 }, (_, index) => index < count ? 'supported' : 'not_supported')
    : ['unknown', 'unknown', 'unknown'],
  reasoning: withEvidence ? 'Evidence found.' : 'Not found.',
  is_silent: count === 0
});

const anti = (count, withEvidence = false, absenceStatus = undefined) => ({
  count,
  status: count === 0 ? 'OK' : count === 3 ? 'NOK' : 'Partial',
  evidence: withEvidence ? 'Confirmed anti-pattern evidence.' : 'No confirmed anti-pattern evidence.',
  evidence_quotes: withEvidence ? [{ quote: 'Confirmed anti-pattern evidence', category: 'Operational', evidence_source: 'text' }] : [],
  assessment_status: withEvidence || absenceStatus === 'tested_absent' ? 'assessed' : 'not_assessed',
  question_results: withEvidence
    ? Array.from({ length: 3 }, (_, index) => index < count ? 'supported' : 'not_supported')
    : ['unknown', 'unknown', 'unknown'],
  reasoning: withEvidence ? 'Evidence found.' : 'Not found.',
  is_silent: count === 0 && absenceStatus !== 'tested_absent',
  antipattern_absence_status: absenceStatus,
  coverage_reason: absenceStatus === 'tested_absent' ? 'Relevant source coverage reviewed; anti-pattern was not found.' : undefined,
  evidence_check_status: absenceStatus === 'tested_absent' ? 'supported' : undefined
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
  assert.equal(result.unknown_antipattern_absences.length, 30);
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(0, false, 'tested_absent')
  ));
  assert.equal(result.crawl_walk_run, 'Run');
  assert.ok(result.metrics.finops_readiness >= 90, `expected high readiness, got ${result.metrics.finops_readiness}`);
  assert.equal(result.metrics.antipattern_burden_confidence, 'confirmed');
  assert.equal(result.metrics.antipattern_clearance, 100);
  assert.equal(result.metrics.antipattern_coverage, 100);
  assert.equal(result.verified_antipattern_absences.length, 30);
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
  assert.ok(result.score_evidence_gaps.length > 0, 'low evidence should produce explicit score evidence gaps');
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
  assert.equal(result.metrics.maturity_assessed_count, 30);
  assert.equal(result.metrics.maturity_zero_count, 30, 'assessed 0/3 capabilities must be retained as evidence-backed gaps');
  assert.equal(result.metrics.maturity_zero_ratio, 100, 'capability-gap concentration must remain observable independently of evidence density');
  assert.equal(result.metrics.assessed_zero_count, 30, 'assessed 0/3 criteria must be retained as assessed evidence');
  assert.equal(result.metrics.assessed_zero_ratio, 100, 'compatibility zero ratio must describe maturity only');
  assert.equal(result.maturity_gaps.length, 30);
  assert.equal(result.silent_areas.length, 0, 'quote-backed maturity gaps should not be treated as silent');
  assert.match(result.maturity_gaps[0], /Confirmed gap/, 'quote-backed maturity gaps should be labelled as confirmed gaps');
}

{
  const result = calculateMetrics(logs(
    () => item(0, false),
    () => anti(0, false)
  ));
  assert.equal(result.metrics.evidence_density, 0, 'silent maturity gaps should not count as source coverage');
  assert.equal(result.metrics.assessed_zero_count, 0, 'unknown criteria must not be misclassified as assessed zeroes');
  assert.equal(result.silent_areas.length, 30, 'silent maturity gaps should remain silent areas');
  assert.match(result.maturity_gaps[0], /Not demonstrated by supplied material/, 'silent maturity gaps should remain evidence gaps, not confirmed capability absences');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    (_id, index) => index < 12
      ? anti(0, false, 'tested_absent')
      : index < 20
        ? anti(1, true, 'partially_present')
        : anti(0, false, 'unknown_absent')
  ));
  assert.equal(result.metrics.maturity_zero_count, 0, 'anti-pattern 0/3 results must never enter capability-gap concentration');
  assert.equal(result.metrics.maturity_zero_ratio, 0);
  assert.equal(result.metrics.antipattern_assessed_count, 20);
  assert.equal(result.metrics.antipattern_score_eligible_count, 20);
  assert.equal(result.metrics.antipattern_finding_count, 8);
  assert.equal(Math.round(result.metrics.antipattern_finding_ratio * 10) / 10, 26.7, 'finding prevalence must use the complete anti-pattern surface');
  assert.equal(Math.round(result.metrics.antipattern_control * 10) / 10, 86.7, 'control must invert verified burden without counting unknown criteria');
  assert.equal(result.metrics.antipattern_clearance, 40, 'only explicitly tested absences count as positive clearance');
}

{
  const result = calculateMetrics(logs(
    (_id, index) => item(0, index < 23),
    (_id, index) => index < 11
      ? anti(1, true, 'partially_present')
      : index < 13
        ? anti(2, true, 'partially_present')
        : index < 15
          ? anti(0, true, 'unknown_absent')
          : index < 21
            ? anti(0, false, 'partially_present')
            : anti(0, false, 'unknown_absent')
  ));
  assert.equal(result.metrics.evidence_density, 63, 'fixture must reproduce the latest run evidence coverage');
  assert.equal(result.metrics.capability_attainment, 0);
  assert.equal(result.metrics.antipattern_assessed_count, 15, 'only evidence-covered anti-patterns count as assessed coverage');
  assert.equal(result.metrics.antipattern_score_eligible_count, 13, 'unknown and not-assessed signals must not enter the control denominator');
  assert.equal(Math.round(result.metrics.antipattern_burden * 10) / 10, 38.5);
  assert.equal(Math.round(result.metrics.antipattern_control * 10) / 10, 61.5);
  assert.equal(Math.round(result.metrics.finops_readiness * 10) / 10, 30.8);
  assert.equal(result.crawl_walk_run, 'Crawl');
}

{
  const result = calculateMetrics(logs(
    (_id, index) => index < 10
      ? { ...item(3, true), original_count: 3, verified_count: null, verification_unresolved: true }
      : item(3, true),
    (_id, index) => index < 10
      ? { ...anti(3, true, 'confirmed_present'), original_count: 3, verified_count: null, verification_unresolved: true }
      : anti(0, false, 'tested_absent')
  ));
  assert.equal(result.metrics.capability_attainment, 100, 'unresolved scanner candidates must not depress or improve the verified capability score');
  assert.equal(result.metrics.antipattern_control, 100, 'unresolved scanner candidates must be excluded from the anti-pattern score denominator');
  assert.equal(result.metrics.score_gap_breakdown.maturity_verification_unresolved, 10);
  assert.equal(result.metrics.score_gap_breakdown.antipattern_verification_unresolved, 10);
  assert.equal(result.verification_unresolved.length, 20);
  assert.equal(result.maturity_gaps.length, 0, 'unresolved candidates are not confirmed maturity gaps');
  assert.equal(result.antipattern_findings.length, 0, 'unresolved candidates are not confirmed anti-pattern findings');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => ({ ...anti(0, false, 'unknown_absent'), coverage_reason: 'Source did not cover this anti-pattern.' })
  ));
  assert.equal(result.metrics.evidence_density, 50, 'unknown anti-pattern absence should not count as verified coverage');
  assert.equal(result.metrics.antipattern_clearance, 0);
}

{
  const result = calculateMetrics(logs(
    (_id, index) => item(index < 12 ? 3 : index < 22 ? 2 : index < 25 ? 1 : 0, true),
    (_id, index) => index < 22
      ? anti(0, false, 'tested_absent')
      : index < 25
        ? anti(1, true, 'partially_present')
        : anti(0, false, 'unknown_absent')
  ));
  assert.equal(Math.round(result.metrics.capability_attainment * 10) / 10, 65.6);
  assert.equal(Math.round(result.metrics.antipattern_control * 10) / 10, 96);
  assert.equal(Math.round(result.metrics.finops_readiness * 10) / 10, 80.8, 'unknown items must be excluded and verified question results must contribute linearly');
  assert.equal(result.metrics.score_gap_breakdown.maturity_not_demonstrated, 0);
  assert.equal(result.metrics.score_gap_breakdown.antipattern_not_assessed, 5);
  assert.equal(result.score_evidence_gaps.length, 5, 'unknown anti-pattern absence should remain an evidence discussion');
}

{
  const result = calculateMetrics(logs(
    () => item(3, true),
    () => anti(0, false, 'tested_absent')
  ));
  applyQualityGateScoreCap(result, 'BLOCK');
  assert.equal(result.metrics.raw_finops_maturity_score, 100);
  assert.equal(result.metrics.finops_readiness, 70, 'BLOCKED report score must never exceed 70%');
  assert.equal(result.metrics.quality_gate_score_cap, 70);
  assert.match(result.metrics.quality_gate_score_cap_reason, /calculated score was 100%/);
  applyQualityGateScoreCap(result, 'GO');
  assert.equal(result.metrics.finops_readiness, 100, 'GO must preserve the calculated score');
  assert.equal(result.metrics.quality_gate_score_cap, undefined);
}

{
  const antiLogs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`A${index + 1}`, {
    count: 0,
    status: 'OK',
    evidence: 'No supported finding.',
    evidence_quotes: [],
    reasoning: 'Not assessed.',
    antipattern_absence_status: 'unknown_absent',
  }]));
  const evidenceItems = Array.from({ length: 60 }, (_, index) => ({
    stream: index < 30 ? 'maturity' : 'antipattern',
    id: index < 30 ? `M${index + 1}` : `A${index - 29}`,
    status: index === 59 ? 'missing' : 'supported',
    original_count: 0,
    verified_count: 0,
    rationale: 'Fixture verdict.',
    adjudication_unresolved: index === 59,
  }));
  const view = buildReportViewModel({
    phase_1_audit_logs: { maturity: {}, antipattern: antiLogs },
    phase_2_validation: {
      metrics: { evidence_density: 43, maturity_depth: 10 },
      raw_counts: { maturity_sub_criteria_met: 9, antipattern_sub_criteria_met: 0 },
    },
    phase_3_strategy: {
      diagnosis: { confidence: 'low' },
      planning_decision: { decision: 'NO_GO' },
    },
    quality_gate: {
      decision: 'BLOCK',
      blocking_reasons: ['Unresolved adjudication.'],
      evidence_check: {
        total_items: 60,
        supported_count: 59,
        weak_count: 0,
        unsupported_count: 0,
        missing_count: 1,
        downgraded_count: 0,
        rescan_count: 0,
        items: evidenceItems,
        adjustments: [],
        failed: true,
      },
    },
  });
  assert.equal(view.metrics.length, 5, 'report summary should expose evidence, verification, both score dimensions, and the composite score');
  assert.equal(view.metrics[1].label, 'Verification Completion');
  assert.equal(view.metrics[1].value, 98, 'one unresolved decision should produce 59/60 completion');
  assert.equal(view.antipatternDisposition.unresolved, 1);
  assert.equal(
    Object.values(view.antipatternDisposition).reduce((sum, value) => sum + value, 0),
    30,
    'anti-pattern disposition states must partition all 30 anti-pattern criteria'
  );
}

console.log('metrics unit tests passed');
