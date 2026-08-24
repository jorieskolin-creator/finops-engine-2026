import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-coverage-'));
const coverageOut = await emitTypescript(new URL('../src/services/derivedEvidence/coverageAnalyzer.ts', import.meta.url).pathname, join(dir, 'coverage'));
const taggingOut = await emitTypescript(new URL('../src/services/structuredDataAnalysisService.ts', import.meta.url).pathname, join(dir, 'tagging'));
const { analyzeCrucialItemCoverage } = await import(`file://${coverageOut}`);
const { isDerivedEvidenceApprovedForPacket, analyzeTaggingAllocationTable, EVIDENCE_ANALYSIS_REGISTRY } = await import(`file://${taggingOut}`);

assert.equal(EVIDENCE_ANALYSIS_REGISTRY.length, 1);
assert.equal(EVIDENCE_ANALYSIS_REGISTRY[0].analyzer_id, 'tagging_allocation_v1');

const silentSources = [{
  schema_version: 'source_record_v1', source_id: 'src-silent', source_name: 'notes.txt', kind: 'text',
  text: 'Office lunch roster and travel policy for Helsinki staff.'
}];
const silent = analyzeCrucialItemCoverage(silentSources);
assert.equal(silent.evidence.length, 30);
assert.equal(silent.evidence.every(item => item.result.coverage.found === 0), true);
assert.equal(silent.evidence.find(item => item.targets[0].criterion_id === 'C2').result.coverage.critical_coverage, 'MISSING');
assert.equal(silent.evidence.find(item => item.targets[0].criterion_id === 'C2').result.coverage.coverage_band, '0_25');
assert.match(silent.evidence[0].summary_lines.join('\n'), /not tested absence/i);
assert.doesNotMatch(JSON.stringify(silent.evidence), /Helsinki|lunch roster/);
assert.equal(silent.evidence.every(item => item.raw_value_exposure === false), true);

const forecastSources = [{
  schema_version: 'source_record_v1', source_id: 'src-c2', source_name: 'forecast.md', kind: 'text',
  text: [
    'Monthly forecast and ennuste cadence is owned by finance.',
    'Budget-to-actual variance is tracked. Corrective action is documented.',
    'Overrun limits are not documented in this pack.',
  ].join(' ')
}];
const forecast = analyzeCrucialItemCoverage(forecastSources);
const c2 = forecast.evidence.find(item => item.targets[0].criterion_id === 'C2');
assert.equal(c2.derivation.analyzer_id, 'crucial_item_coverage_v1');
assert.equal(c2.derivation.registry_version, 'evidence_analysis_registry_v2');
assert.equal(c2.result.row_scope, 'acquired_corpus');
assert.ok(c2.result.coverage.found >= 4, 'Finnish ennuste plus forecast aliases should match several C2 items');
assert.ok(c2.result.coverage.missing_items.includes('variance_threshold'));
assert.equal(c2.result.coverage.critical_coverage, 'PARTIAL');
assert.equal(isDerivedEvidenceApprovedForPacket(c2), true);
assert.doesNotMatch(JSON.stringify(c2), /€|EUR [0-9]|Alice|invoice/i);

const taggingTable = {
  schema_version: 'source_record_v1', source_id: 'table-1', source_name: 'allocation.csv', kind: 'csv',
  text: 'model-visible bounded table',
  structured_table: { schema_version: 'structured_table_v1', headers: ['Owner', 'Cost Center', 'Tags', 'Spend'], rows: [['Alice', 'CC-1', 'prod', '100'], ['', 'unallocated', '', '50']], total_row_count: 2, truncated: false }
};
const tagging = analyzeTaggingAllocationTable(taggingTable);
assert.equal(tagging.derivation.analyzer_id, 'tagging_allocation_v1');
assert.equal(tagging.derivation.registry_version, 'evidence_analysis_registry_v1');
assert.equal(isDerivedEvidenceApprovedForPacket(tagging), true);

console.log('crucial item coverage tests passed');
