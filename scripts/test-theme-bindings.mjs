import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-theme-bindings-'));
const derivedOut = await emitTypescript(new URL('../src/services/derivedEvidence/index.ts', import.meta.url).pathname, join(dir, 'derived'));
const bindingsOut = await emitTypescript(new URL('../src/services/derivedEvidence/bindings.ts', import.meta.url).pathname, join(dir, 'bindings'));
const taggingOut = await emitTypescript(new URL('../src/services/structuredDataAnalysisService.ts', import.meta.url).pathname, join(dir, 'tagging'));

const { deriveAllEvidenceSignals } = await import(`file://${derivedOut}`);
const {
  THEME_BINDINGS,
  THEME_BINDING_FAMILIES,
  liveThemeBindings,
  plannedThemeBindings,
} = await import(`file://${bindingsOut}`);
const { analyzeTaggingAllocationTable } = await import(`file://${taggingOut}`);

const STAT_FAMILIES = [
  'trend_v1', 'variation_v1', 'concentration_v1', 'adoption_v1',
  'process_v1', 'exception_v1', 'association_v1', 'consistency_v1',
];

const months = ['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'];

const sourceOf = (id, name, headers, rows, text = 'structured evidence') => ({
  schema_version: 'source_record_v1',
  source_id: id,
  source_name: name,
  kind: 'csv',
  text,
  structured_table: {
    schema_version: 'structured_table_v1',
    headers,
    rows,
    total_row_count: rows.length,
    truncated: false,
  },
});

const familyOf = (bundle, analyzerId) => bundle.evidence.find(item => item.derivation.analyzer_id === analyzerId);
const familiesPresent = (bundle) =>
  [...new Set(bundle.evidence.map(item => item.derivation.analyzer_id).filter(id => STAT_FAMILIES.includes(id)))];
const leaked = (item) => JSON.stringify(item);

assert.equal(THEME_BINDING_FAMILIES.length, 9, 'nine families, no tenth');
assert.equal(THEME_BINDINGS.some(item => item.family === 'predictive_v1'), false);
assert.ok(liveThemeBindings().filter(item => item.phase === 'F0').length >= 20);
assert.equal(liveThemeBindings().filter(item => item.phase === 'F1').every(item => item.priority === 'must' && item.status === 'live'), true);
assert.ok(liveThemeBindings().some(item => item.binding_id === 'A5.unit_cost.trend'));
assert.ok(liveThemeBindings().some(item => item.binding_id === 'F2.cost_per_unit.trend'));
assert.equal(liveThemeBindings('trend_v1').some(item => item.binding_id === 'F2.cost_per_unit.trend' && item.header_patterns.includes('unit_cost')), false, 'F2 must not share unit_cost with A5');
assert.equal(liveThemeBindings().filter(item => item.phase === 'F2').length, 4);
assert.equal(liveThemeBindings().filter(item => item.phase === 'F2').every(item => item.priority === 'should' && item.status === 'live'), true);
assert.ok(liveThemeBindings().some(item => item.binding_id === 'A1.coverage.trend'));
assert.ok(liveThemeBindings().some(item => item.binding_id === 'A4.freshness.process'));
assert.ok(liveThemeBindings().some(item => item.binding_id === 'E2.ownerless.process'));
assert.ok(liveThemeBindings().some(item => item.binding_id === 'F4.usage_vs_budget.association'));
assert.equal(plannedThemeBindings().length, 0, 'F2 remainder is live; F3 is alias retry, not catalog rows');
assert.ok(liveThemeBindings('concentration_v1').some(item => item.criterion_id === 'F3' && item.header_patterns.includes('model')));
assert.ok(liveThemeBindings('concentration_v1').some(item => item.criterion_id === 'B5' && item.header_patterns.includes('storage_class')));
assert.ok(liveThemeBindings('concentration_v1').every(item => item.criterion_id !== 'A1' || !item.header_patterns.includes('model')));

const finnish = deriveAllEvidenceSignals([sourceOf(
  'fi-1',
  'ennuste.csv',
  ['Jakso', 'Ennuste', 'Actual'],
  months.map((period, index) => [period, '100', String(108 + index * 2)]),
  'monthly forecast pack',
)]);
const finnishTrend = familyOf(finnish, 'trend_v1');
assert.ok(finnishTrend, 'alias header ennuste/actual must still yield C2');
assert.equal(finnishTrend.targets[0].criterion_id, 'C2');
assert.equal(finnishTrend.result.trend.direction, 'DETERIORATING');
assert.equal(finnishTrend.llm_policy.may_recalculate, false);
assert.equal(finnishTrend.llm_policy.causal_authority, 'NONE');
assert.doesNotMatch(leaked(finnishTrend), /108|110|"mean"|"slope"/i);

const unitCost = deriveAllEvidenceSignals([sourceOf(
  'a5-1',
  'unit-cost.csv',
  ['Period', 'unit_cost', 'cost_per_transaction'],
  months.map((period, index) => [period, String(0.11 + index * 0.01), String(0.42 + index * 0.02)]),
  'unit economics extract',
)]);
const unitCostTrend = familyOf(unitCost, 'trend_v1');
const unitCostVariation = familyOf(unitCost, 'variation_v1');
assert.ok(unitCostTrend, 'F1 A5 unit_cost must fire');
assert.equal(unitCostTrend.targets[0].criterion_id, 'A5');
assert.notEqual(unitCostTrend.targets[0].criterion_id, 'F2');
assert.ok(unitCostVariation);
assert.equal(unitCostVariation.targets[0].criterion_id, 'A5');
assert.equal(unitCostTrend.llm_policy.causal_authority, 'NONE');
assert.doesNotMatch(leaked(unitCostTrend), /0\.11|0\.42|"mean"|"slope"/i);

const tokenCost = deriveAllEvidenceSignals([sourceOf(
  'f2-1',
  'token-unit.csv',
  ['Period', 'cost_per_token'],
  months.map((period, index) => [period, String(0.00012 + index * 0.00001)]),
  'AI unit cost extract',
)]);
const tokenTrend = familyOf(tokenCost, 'trend_v1');
assert.ok(tokenTrend, 'F1 F2 cost_per_token must fire');
assert.equal(tokenTrend.targets[0].criterion_id, 'F2');
assert.notEqual(tokenTrend.targets[0].criterion_id, 'A5');
assert.doesNotMatch(leaked(tokenTrend), /0\.00012|"mean"|"slope"/i);

const unattributed = familyOf(deriveAllEvidenceSignals([sourceOf(
  'a2-1',
  'attribution.csv',
  ['Resource', 'Unattributed'],
  [['svc-a', 'yes'], ['svc-b', 'no'], ['svc-c', 'yes'], ['svc-d', 'no']],
  'unattributed share flags',
)]), 'adoption_v1');
assert.ok(unattributed, 'F1 A2 unattributed must fire');
assert.equal(unattributed.targets[0].criterion_id, 'A2');
assert.equal(unattributed.result.adoption.practice_presence, 'PRESENT');
assert.doesNotMatch(leaked(unattributed), /svc-a|svc-b/i);

const unusedBundle = deriveAllEvidenceSignals([sourceOf(
  'b1-unused',
  'unused-ri.csv',
  ['Instrument', 'Unused RI'],
  [['ri-1', 'yes'], ['ri-2', 'no'], ['ri-3', 'yes'], ['ri-4', 'yes']],
  'unused commitment incidence',
)]);
const unused = familyOf(unusedBundle, 'exception_v1');
assert.ok(unused, 'F1 B1 unused instrument must fire');
assert.equal(unused.targets[0].criterion_id, 'B1');
assert.equal(familyOf(unusedBundle, 'adoption_v1'), undefined, 'unused_ri must not look like commitment adoption');
assert.doesNotMatch(leaked(unused), /ri-1|ri-2/i);

const eligible = familyOf(deriveAllEvidenceSignals([sourceOf(
  'd1-1',
  'eligible.csv',
  ['Service', 'Architecture Review'],
  [['api', 'yes'], ['batch', 'yes'], ['etl', 'no'], ['web', 'yes']],
  'eligible-scope reviews',
)]), 'adoption_v1');
assert.ok(eligible, 'F1 D1 eligible-scope must fire');
assert.equal(eligible.targets[0].criterion_id, 'D1');
assert.doesNotMatch(leaked(eligible), /\bapi\b|\bbatch\b|\betl\b/i);

const aiAttr = familyOf(deriveAllEvidenceSignals([sourceOf(
  'f1-1',
  'ai-attr.csv',
  ['Workload', 'AI Attributed'],
  [['chat', 'yes'], ['search', 'no'], ['summarise', 'yes'], ['embed', 'yes']],
  'AI workload attribution',
)]), 'adoption_v1');
assert.ok(aiAttr, 'F1 F1 attribution must fire');
assert.equal(aiAttr.targets[0].criterion_id, 'F1');
assert.doesNotMatch(leaked(aiAttr), /chat|search|summarise|embed/i);

const procurement = familyOf(deriveAllEvidenceSignals([sourceOf(
  'c4-1',
  'procurement.csv',
  ['Period', 'Status', 'Vendor'],
  [
    ['2026-01-01', 'closed', 'cloud-a'],
    ['2026-01-08', 'closed', 'cloud-b'],
    ['2026-01-15', 'open', 'cloud-a'],
    ['2026-01-22', 'open', 'cloud-c'],
  ],
  'procurement cycle',
)]), 'process_v1');
assert.ok(procurement, 'F1 C4 procurement must fire over C3 fallback');
assert.equal(procurement.targets[0].criterion_id, 'C4');
assert.doesNotMatch(leaked(procurement), /cloud-a|cloud-b|cloud-c/i);

const tagCoverage = deriveAllEvidenceSignals([sourceOf(
  'a1-cov',
  'tag-coverage.csv',
  ['Period', 'tag_coverage'],
  months.map((period, index) => [period, String(0.40 + index * 0.02)]),
  'tagging coverage over time',
)]);
const tagCoverageTrend = familyOf(tagCoverage, 'trend_v1');
assert.ok(tagCoverageTrend, 'F2 A1 tag_coverage must fire');
assert.equal(tagCoverageTrend.targets[0].criterion_id, 'A1');
assert.notEqual(tagCoverageTrend.targets[0].criterion_id, 'B1', 'tag_coverage must not be stolen by commitment coverage');
assert.equal(tagCoverageTrend.result.trend.direction, 'IMPROVING');
assert.doesNotMatch(leaked(tagCoverageTrend), /0\.40|0\.42|"mean"|"slope"/i);

const commitmentCoverage = familyOf(deriveAllEvidenceSignals([sourceOf(
  'b1-cov',
  'commitment-coverage.csv',
  ['Period', 'Coverage'],
  months.map((period, index) => [period, String(40 + index)]),
  'commitment coverage over time',
)]), 'trend_v1');
assert.ok(commitmentCoverage, 'bare Coverage still binds B1');
assert.equal(commitmentCoverage.targets[0].criterion_id, 'B1');

const freshness = familyOf(deriveAllEvidenceSignals([sourceOf(
  'a4-1',
  'freshness.csv',
  ['Dashboard', 'Last Refresh'],
  [
    ['cost', '2026-01-01'],
    ['usage', '2026-01-08'],
    ['commitments', '2026-01-15'],
    ['unit', '2026-01-22'],
  ],
  'dashboard freshness listing',
)]), 'process_v1');
assert.ok(freshness, 'F2 A4 freshness must fire');
assert.equal(freshness.targets[0].criterion_id, 'A4');
assert.notEqual(freshness.targets[0].criterion_id, 'C3');
assert.doesNotMatch(leaked(freshness), /\bcost\b|\busage\b|commitments/i);

const ownerless = familyOf(deriveAllEvidenceSignals([sourceOf(
  'e2-1',
  'ownerless.csv',
  ['Item', 'Status', 'Ownerless'],
  [
    ['t-1', 'closed', 'yes'],
    ['t-2', 'closed', 'no'],
    ['t-3', 'open', 'yes'],
    ['t-4', 'open', 'yes'],
  ],
  'ownerless item listing',
)]), 'process_v1');
assert.ok(ownerless, 'F2 E2 ownerless must fire over C3 fallback');
assert.equal(ownerless.targets[0].criterion_id, 'E2');
assert.doesNotMatch(leaked(ownerless), /t-1|t-2|t-3|t-4/i);

const ownerlessFlags = familyOf(deriveAllEvidenceSignals([sourceOf(
  'e2-flags',
  'ownerless-flags.csv',
  ['Item', 'Ownerless'],
  [['alpha', 'yes'], ['beta', 'no'], ['gamma', 'yes'], ['delta', 'yes']],
  'ownerless flags without status',
)]), 'process_v1');
assert.ok(ownerlessFlags, 'F2 E2 ownerless flags fire without a status column');
assert.equal(ownerlessFlags.targets[0].criterion_id, 'E2');
assert.doesNotMatch(leaked(ownerlessFlags), /alpha|beta|gamma|delta/i);

const usageBudget = familyOf(deriveAllEvidenceSignals([sourceOf(
  'f4-1',
  'ai-budget.csv',
  ['Period', 'ai_usage', 'ai_budget'],
  months.map((period, index) => [period, String(100 + index * 4), String(110 + index * 3)]),
  'AI usage versus budget',
)]), 'association_v1');
assert.ok(usageBudget, 'F2 F4 usage-vs-budget must fire');
assert.equal(usageBudget.targets[0].criterion_id, 'F4');
assert.equal(usageBudget.result.association.pair_id, 'ai_usage_vs_budget');
assert.equal(usageBudget.result.association.causal_authority, 'NONE');
assert.doesNotMatch(leaked(usageBudget), /100|110|"r"|pearson/i);

const aliasRetryBlocked = deriveAllEvidenceSignals([sourceOf(
  'f3-blocked',
  'alias.csv',
  ['Jakso', 'tunnisteet'],
  months.map((period, index) => [period, String(0.40 + index * 0.01)]),
  'Finnish tagging alias',
)]);
assert.equal(familyOf(aliasRetryBlocked, 'trend_v1'), undefined, 'F3 column-alias retry is not live');
assert.equal(familyOf(aliasRetryBlocked, 'process_v1'), undefined);
assert.equal(familyOf(aliasRetryBlocked, 'adoption_v1'), undefined);

const modelSeg = deriveAllEvidenceSignals([sourceOf(
  'f3-1',
  'models.csv',
  ['Model', 'Spend'],
  [['gpt-4o', '80'], ['gpt-4o-mini', '10'], ['sonnet', '10']],
  'model mix',
)]);
const modelConcentration = familyOf(modelSeg, 'concentration_v1');
assert.ok(modelConcentration, 'model segment must still produce concentration');
assert.equal(modelConcentration.targets[0].criterion_id, 'F3');
assert.notEqual(modelConcentration.targets[0].criterion_id, 'A1');
assert.doesNotMatch(leaked(modelConcentration), /gpt-4o|sonnet/i);

const storageSeg = deriveAllEvidenceSignals([sourceOf(
  'b5-1',
  'storage.csv',
  ['Storage Class', 'Spend'],
  [['hot', '70'], ['warm', '20'], ['cold', '10']],
  'storage tier mix',
)]);
const storageConcentration = familyOf(storageSeg, 'concentration_v1');
assert.ok(storageConcentration);
assert.equal(storageConcentration.targets[0].criterion_id, 'B5');

const envSeg = deriveAllEvidenceSignals([sourceOf(
  'a1-env',
  'env.csv',
  ['Environment', 'Spend'],
  [['prod', '80'], ['dev', '10'], ['test', '10']],
  'environment distribution',
)]);
const envConcentration = familyOf(envSeg, 'concentration_v1');
assert.ok(envConcentration);
assert.equal(envConcentration.targets[0].criterion_id, 'A1');
assert.doesNotMatch(leaked(envConcentration), /\bprod\b|\bdev\b|\btest\b/);

const ownerSeg = deriveAllEvidenceSignals([sourceOf(
  'a1-owner',
  'owners.csv',
  ['Owner', 'Spend'],
  [['Alice', '40'], ['Bob', '35'], ['Cara', '25']],
  'owner distribution',
)]);
const ownerConcentration = familyOf(ownerSeg, 'concentration_v1');
assert.ok(ownerConcentration, 'tag/owner segments bind to A1');
assert.equal(ownerConcentration.targets[0].criterion_id, 'A1');
assert.doesNotMatch(leaked(ownerConcentration), /Alice|Bob|Cara/);

const teamSeg = deriveAllEvidenceSignals([sourceOf(
  'unbound-team',
  'teams.csv',
  ['Team', 'Spend'],
  [['Payments', '80'], ['Data', '10'], ['Platform', '10']],
  'unbound segment',
)]);
assert.equal(familyOf(teamSeg, 'concentration_v1'), undefined, 'unbound segments must not default to A1');

const randomSheet = deriveAllEvidenceSignals([sourceOf(
  'random-1',
  'widgets.csv',
  ['Widget', 'Qty', 'Notes'],
  Array.from({ length: 12 }, (_, index) => [`w-${index}`, String(10 + index), 'ok']),
  'inventory listing',
)]);
assert.deepEqual(familiesPresent(randomSheet), [], 'random numeric sheet yields NO_SIGNAL for statistical families');

const taggingSource = sourceOf(
  'table-1',
  'allocation.csv',
  ['Owner', 'Cost Center', 'Tags', 'Spend'],
  [['Alice', 'CC-1', 'prod', '100'], ['', 'unallocated', '', '50']],
  'model-visible bounded table',
);
const tagging = deriveAllEvidenceSignals([taggingSource]);
assert.equal(tagging.evidence.some(item => item.derivation.analyzer_id === 'tagging_allocation_v1'), true);
assert.equal(familyOf(tagging, 'trend_v1'), undefined);
assert.equal(familyOf(tagging, 'concentration_v1'), undefined);
const taggingDirect = analyzeTaggingAllocationTable(taggingSource);
assert.equal(taggingDirect.result.status, 'OBSERVED');
assert.equal(taggingDirect.result.mapping_population_coverage, 50);
assert.doesNotMatch(JSON.stringify(taggingDirect), /Alice|CC-1/);

const guardrail = familyOf(deriveAllEvidenceSignals([sourceOf(
  'adopt-1',
  'guardrails.csv',
  ['Repo', 'Iac Guardrail Enabled'],
  [['alpha', 'yes'], ['beta', 'no'], ['gamma', 'yes'], ['delta', 'yes']],
  'pipeline guardrails',
)]), 'adoption_v1');
assert.ok(guardrail);
assert.equal(guardrail.targets[0].criterion_id, 'D2');

console.log('theme-binding catalog tests passed');
