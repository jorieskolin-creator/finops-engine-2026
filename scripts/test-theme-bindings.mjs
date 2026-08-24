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

assert.equal(THEME_BINDING_FAMILIES.length, 9, 'nine families, no tenth');
assert.equal(THEME_BINDINGS.some(item => item.family === 'predictive_v1'), false);
assert.ok(liveThemeBindings().length >= 20, 'F0 moved the live detectors into the catalog');
assert.equal(liveThemeBindings().every(item => item.phase === 'F0'), true);
assert.ok(plannedThemeBindings().some(item => item.binding_id === 'A5.unit_cost.trend'));
assert.equal(plannedThemeBindings().every(item => item.status === 'planned'), true);
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
assert.doesNotMatch(JSON.stringify(finnishTrend), /108|110|"mean"|"slope"/i);

const unitCost = deriveAllEvidenceSignals([sourceOf(
  'a5-1',
  'unit-cost.csv',
  ['Period', 'unit_cost', 'cost_per_transaction'],
  months.map((period, index) => [period, String(0.11 + index * 0.01), String(0.42 + index * 0.02)]),
  'unit economics extract',
)]);
assert.equal(familyOf(unitCost, 'trend_v1'), undefined, 'A5 unit_cost must not fire until F1 binds it');
assert.equal(familyOf(unitCost, 'variation_v1'), undefined);
assert.equal(unitCost.evidence.some(item => item.targets?.some(target => target.criterion_id === 'A5') && STAT_FAMILIES.includes(item.derivation.analyzer_id)), false);

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
assert.doesNotMatch(JSON.stringify(modelConcentration), /gpt-4o|sonnet/i);

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
assert.doesNotMatch(JSON.stringify(envConcentration), /\bprod\b|\bdev\b|\btest\b/);

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
assert.doesNotMatch(JSON.stringify(ownerConcentration), /Alice|Bob|Cara/);

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
