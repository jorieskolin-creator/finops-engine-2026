import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-families-'));
const derivedOut = await emitTypescript(new URL('../src/services/derivedEvidence/index.ts', import.meta.url).pathname, join(dir, 'derived'));
const taggingOut = await emitTypescript(new URL('../src/services/structuredDataAnalysisService.ts', import.meta.url).pathname, join(dir, 'tagging'));
const { deriveAllEvidenceSignals } = await import(`file://${derivedOut}`);
const { isDerivedEvidenceApprovedForPacket, EVIDENCE_ANALYSIS_REGISTRY } = await import(`file://${taggingOut}`);

assert.equal(EVIDENCE_ANALYSIS_REGISTRY.length, 1);
assert.equal(EVIDENCE_ANALYSIS_REGISTRY[0].analyzer_id, 'tagging_allocation_v1');

const months = ['2025-01','2025-02','2025-03','2025-04','2025-05','2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12'];
const forecastSource = {
  schema_version: 'source_record_v1', source_id: 'forecast-1', source_name: 'variance.csv', kind: 'csv',
  text: 'monthly forecast pack',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Period', 'Forecast', 'Actual'],
    rows: months.map((period, index) => [period, '100', String(108 + index * 2)]),
    total_row_count: 12, truncated: false,
  }
};
const forecast = deriveAllEvidenceSignals([forecastSource]);
const trend = forecast.evidence.find(item => item.derivation.analyzer_id === 'trend_v1');
const variation = forecast.evidence.find(item => item.derivation.analyzer_id === 'variation_v1');
assert.ok(trend, 'forecast/actual tables must produce a trend object');
assert.equal(trend.targets[0].criterion_id, 'C2');
assert.equal(trend.result.trend.direction, 'DETERIORATING');
assert.equal(isDerivedEvidenceApprovedForPacket(trend), true);
assert.equal(isDerivedEvidenceApprovedForPacket(variation), true);
assert.doesNotMatch(JSON.stringify(trend), /108|110|"mean"|"slope"|Alice/i);
assert.doesNotMatch(JSON.stringify(variation), /108|110|"cv"/);
assert.equal(trend.llm_policy.may_recalculate, false);
assert.equal(trend.llm_policy.causal_authority, 'NONE');
assert.ok(trend.quality);

const short = deriveAllEvidenceSignals([{
  ...forecastSource, source_id: 'forecast-short',
  structured_table: { ...forecastSource.structured_table, rows: months.slice(0, 4).map((period, index) => [period, '100', String(110 + index)]), total_row_count: 4 }
}]);
const shortTrend = short.evidence.find(item => item.derivation.analyzer_id === 'trend_v1');
assert.equal(shortTrend.result.status, 'NO_STATISTICALLY_USABLE_POPULATION');
assert.equal(isDerivedEvidenceApprovedForPacket(shortTrend), false);

const taggingSource = {
  schema_version: 'source_record_v1', source_id: 'table-1', source_name: 'allocation.csv', kind: 'csv',
  text: 'model-visible bounded table',
  structured_table: { schema_version: 'structured_table_v1', headers: ['Owner', 'Cost Center', 'Tags', 'Spend'], rows: [['Alice', 'CC-1', 'prod', '100'], ['', 'unallocated', '', '50']], total_row_count: 2, truncated: false }
};
const tagging = deriveAllEvidenceSignals([taggingSource]);
assert.equal(tagging.evidence.some(item => item.derivation.analyzer_id === 'tagging_allocation_v1'), true);
assert.equal(tagging.evidence.some(item => item.derivation.analyzer_id === 'trend_v1'), false);
assert.equal(tagging.evidence.some(item => item.derivation.analyzer_id === 'concentration_v1'), false);
assert.doesNotMatch(JSON.stringify(tagging.evidence.filter(item => item.derivation.analyzer_id === 'tagging_allocation_v1')), /Alice|CC-1/);

const concentrationSource = {
  schema_version: 'source_record_v1', source_id: 'seg-1', source_name: 'env.csv', kind: 'csv', text: 'environment distribution',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Environment', 'Spend'],
    rows: [['prod', '80'], ['dev', '10'], ['test', '10']],
    total_row_count: 3, truncated: false
  }
};
const concentration = deriveAllEvidenceSignals([concentrationSource]).evidence.find(item => item.derivation.analyzer_id === 'concentration_v1');
assert.ok(concentration);
assert.equal(concentration.result.concentration.concentration_band, 'HIGH');
assert.doesNotMatch(JSON.stringify(concentration), /\bprod\b|\bdev\b|\btest\b/);

const adoptionSource = {
  schema_version: 'source_record_v1', source_id: 'adopt-1', source_name: 'guardrails.csv', kind: 'csv', text: 'pipeline guardrails',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Repo', 'Iac Guardrail Enabled'],
    rows: [['alpha', 'yes'], ['beta', 'no'], ['gamma', 'yes'], ['delta', 'yes']],
    total_row_count: 4, truncated: false
  }
};
const adoption = deriveAllEvidenceSignals([adoptionSource]).evidence.find(item => item.derivation.analyzer_id === 'adoption_v1');
assert.ok(adoption);
assert.equal(adoption.targets[0].criterion_id, 'D2');
assert.equal(adoption.result.adoption.practice_presence, 'PRESENT');
assert.equal(adoption.result.adoption.adoption_band, '75_90');
assert.doesNotMatch(JSON.stringify(adoption), /alpha|beta|gamma|delta/i);

const processSource = {
  schema_version: 'source_record_v1', source_id: 'proc-1', source_name: 'cadence.csv', kind: 'csv', text: 'operating cadence',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Ticket ID', 'Status', 'Opened', 'Owner'],
    rows: [
      ['t-1', 'closed', '2026-01-01', 'Finance'],
      ['t-2', 'closed', '2026-01-08', 'Finance'],
      ['t-3', 'open', '2026-01-15', ''],
      ['t-4', 'open', '2026-01-22', 'Finance'],
    ],
    total_row_count: 4, truncated: false
  }
};
const process = deriveAllEvidenceSignals([processSource]).evidence.find(item => item.derivation.analyzer_id === 'process_v1');
assert.ok(process);
assert.equal(process.result.process.cadence, 'WEEKLY');
assert.equal(process.result.process.recurrence, 'NONE');
assert.doesNotMatch(JSON.stringify(process), /t-1|Finance/);

const weeklyPolicy = {
  ...processSource,
  source_id: 'proc-weekly-policy',
  text: 'The operating cadence is a weekly review of FinOps actions.',
};
const consistency = deriveAllEvidenceSignals([weeklyPolicy]).evidence.find(item => item.derivation.analyzer_id === 'consistency_v1');
assert.ok(consistency, 'declared weekly operating cadence vs weekly timestamps must emit consistency');
assert.equal(consistency.targets[0].criterion_id, 'C3');
assert.equal(consistency.result.consistency.agreement_state, 'ALIGNED');
assert.equal(consistency.result.consistency.policy_execution_alignment, 'CONSISTENT');
assert.equal(isDerivedEvidenceApprovedForPacket(consistency), true);

const divergent = deriveAllEvidenceSignals([{
  ...forecastSource,
  source_id: 'forecast-divergent',
  text: 'Weekly forecast review is the declared cadence.',
  structured_table: {
    ...forecastSource.structured_table,
    headers: ['Period', 'Forecast', 'Status', 'Opened'],
    rows: months.map((period, index) => [period, String(100 + index), index % 2 ? 'closed' : 'open', `${period}-01`]),
  }
}]).evidence.find(item => item.derivation.analyzer_id === 'consistency_v1');
assert.ok(divergent);
assert.equal(divergent.result.consistency.declared_cadence, 'WEEKLY');
assert.equal(divergent.result.consistency.observed_cadence, 'MONTHLY');
assert.equal(divergent.result.consistency.agreement_state, 'DIVERGENT');

const exceptionSource = {
  schema_version: 'source_record_v1', source_id: 'exc-1', source_name: 'alerts.csv', kind: 'csv', text: 'cost anomaly alerts',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Ticket ID', 'Anomaly Flag', 'Status', 'Opened'],
    rows: [
      ['a-1', 'yes', 'closed', '2026-01-01'],
      ['a-2', 'no', 'closed', '2026-01-02'],
      ['a-1', 'yes', 'open', '2026-01-08'],
      ['a-3', 'no', 'closed', '2026-01-09'],
    ],
    total_row_count: 4, truncated: false
  }
};
const exception = deriveAllEvidenceSignals([exceptionSource]).evidence.find(item => item.derivation.analyzer_id === 'exception_v1');
assert.ok(exception);
assert.equal(exception.targets[0].criterion_id, 'A3');
assert.equal(exception.result.exception.frequency_band, '50_75');
assert.equal(exception.result.exception.recurrence, 'PRESENT');
assert.equal(isDerivedEvidenceApprovedForPacket(exception), true);
assert.doesNotMatch(JSON.stringify(exception), /a-1|a-2|a-3/);
assert.equal(deriveAllEvidenceSignals([taggingSource]).evidence.some(item => item.derivation.analyzer_id === 'exception_v1'), false);

const associationSource = {
  schema_version: 'source_record_v1', source_id: 'assoc-1', source_name: 'ri.csv', kind: 'csv', text: 'commitment coverage',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Period', 'Coverage', 'Utilization'],
    rows: months.map((period, index) => [period, String(40 + index), String(42 + index)]),
    total_row_count: 12, truncated: false
  }
};
const association = deriveAllEvidenceSignals([associationSource]).evidence.find(item => item.derivation.analyzer_id === 'association_v1');
assert.ok(association);
assert.equal(association.result.association.pair_id, 'coverage_vs_utilization');
assert.equal(association.result.association.association_direction, 'POSITIVE');
assert.equal(association.result.association.causal_authority, 'NONE');
assert.equal(isDerivedEvidenceApprovedForPacket(association), true);
assert.doesNotMatch(JSON.stringify(association), /"r"|pearson|slope/i);
assert.equal(deriveAllEvidenceSignals([taggingSource]).evidence.some(item => item.derivation.analyzer_id === 'association_v1'), false);
assert.equal(deriveAllEvidenceSignals([associationSource]).evidence.some(item =>
  item.derivation.analyzer_id === 'association_v1' && item.result.association?.pair_id !== 'coverage_vs_utilization'
), false, 'unregistered column pairs must not be explored');

console.log('derived family tests passed');
