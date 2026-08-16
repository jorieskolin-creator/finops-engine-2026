import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../src/services/acquisitionQualityService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-acquisition-quality-'));
const modulePath = join(dir, 'acquisitionQualityService.mjs');
await writeFile(modulePath, compiled, 'utf8');
const { acquisitionQualityPersistence, buildAcquisitionQualitySnapshot, shadowTelemetryPersistence } = await import(`file://${modulePath}`);

const quote = (text, source, category) => ({ quote: text, source_id: source, source_document: `${source}.txt`, chunk_id: `${source}-c1`, category });
const item = (status, evidenceQuotes, extra = {}) => ({
  count: 1,
  status: 'Partial',
  evidence: 'report-visible evidence summary',
  evidence_quotes: evidenceQuotes,
  evidence_check_status: status,
  ...extra,
});
const logs = {
  maturity: {
    A1: item('supported', [quote('sensitive owner mapping detail', 'src-1', 'Policy'), quote('second source', 'src-2', 'Policy')]),
    A2: item('weak', [quote('allocation process', 'src-1', 'Process')]),
  },
  antipattern: {
    'AP-A1': item('supported', [quote('missing mapping signal', 'src-1', 'Operational')]),
    'AP-A2': item('supported', [], { count: 0, antipattern_absence_status: 'tested_absent', coverage_reason: 'Relevant source area was checked.' }),
  },
};
const extraction = {
  overall_completeness: 80,
  status: 'PARTIAL',
  warning_count: 1,
  sources: [{
    source_id: 'src-1', kind: 'pdf', completeness: 80, status: 'PARTIAL',
    unit: 'page', total_units: 10, processed_units: 8, truncated: true, warning_count: 1, warning_codes: ['TRUNCATED']
  }],
  blocking_reasons: ['src-1: extraction partial (80%)']
};
const sourceRegistry = {
  source_count: 1,
  chunk_count: 4,
  dlp_review_chunk_count: 2,
  dlp_high_risk_hits: 0,
  dlp_caution_hits: 1,
  extraction,
  packets: { A: { included_chunk_count: 4, total_candidate_chunks: 4, weak_coverage: false, char_count: 1200 } }
};
const delivery = {
  sectioned_document_count: 60, page_limit_document_count: 0, sparse_page_count: 0,
  duplicate_section_heading_count: 0, invalid_section_order_document_count: 0,
  missing_expected_document_count: 0, unexpected_document_count: 0, duplicate_document_count: 0,
  shadow_ready: true
};
const knowledgeBase = {
  source: 'remote_blob', document_count: 60, failure_count: 0, delivery,
  shadow_packets: { 'A:forensic_audit': { stage: 'forensic_audit', domain_id: 'A', readiness: 'READY', packet_hash: 'fnv1a_1', document_count: 10, char_count: 1000, missing_requirement_count: 0, coverage_issue_count: 0, oversized_section_count: 0, page_limit_document_count: 0 } }
};
const evidencePaths = [
  { stream: 'maturity', criterion_id: 'A1', source_id: 'src-1' },
  { stream: 'maturity', criterion_id: 'A2', source_id: 'src-1' },
  { stream: 'antipattern', criterion_id: 'AP-A1', source_id: 'src-1' },
];
const runTrace = {
  input_manifest: [
    { source_id: 'src-1', chunk_ids: ['src-1-c1'] },
    { source_id: 'src-2', chunk_ids: ['src-2-c1'] },
  ],
  evidence_paths: evidencePaths,
  dlp: { blocked: false, caution_hit_count: 1, high_risk_hit_count: 0, scanned_chunk_count: 4 }
};

const snapshot = buildAcquisitionQualitySnapshot({
  logs,
  phase2: { metrics: { evidence_density: 100 } },
  sourceRegistry,
  knowledgeBase,
  runTrace
});

assert.equal(snapshot.schema_version, 'acquisition_quality_snapshot_v1');
assert.equal(snapshot.enforcement, 'observability_only');
assert.equal(snapshot.evidence.coverage.overall, 100);
assert.equal(snapshot.evidence.coverage.by_domain.A.completeness, 100);
assert.equal(snapshot.evidence.density.verified_strength, 88);
assert.equal(snapshot.evidence.density.source_diversity, 50);
assert.equal(snapshot.evidence.density.category_diversity, 75);
assert.equal(snapshot.evidence.density.overall, 78);
assert.equal(snapshot.evidence.provenance.integrity, 75);
assert.deepEqual(snapshot.evidence.provenance.unresolved_criterion_ids, ['antipattern:AP-A2']);
assert.equal(snapshot.knowledge.ready, true);
assert.equal(snapshot.readiness.evidence_packet, 'NOT_READY');
assert.equal(snapshot.readiness.knowledge_packet, 'READY');
assert.equal(snapshot.readiness.acquisition, 'NOT_READY');
assert.equal(snapshot.security.status, 'WARN');
assert.doesNotMatch(JSON.stringify(snapshot), /sensitive owner mapping detail|allocation process|missing mapping signal/);

const futureContractNotReady = buildAcquisitionQualitySnapshot({
  logs,
  phase2: { metrics: { evidence_density: 100 } },
  sourceRegistry: { ...sourceRegistry, extraction: { ...extraction, blocking_reasons: [] } },
  knowledgeBase: {
    ...knowledgeBase,
    delivery: { ...delivery, shadow_ready: false },
    shadow_packets: { 'A:forensic_audit': { ...knowledgeBase.shadow_packets['A:forensic_audit'], readiness: 'NOT_READY', missing_requirement_count: 1 } }
  },
  runTrace
});
assert.equal(futureContractNotReady.knowledge.ready, true, 'future packet diagnostics must not claim the operational remote KB is unavailable');
assert.equal(futureContractNotReady.readiness.knowledge_packet, 'READY');
assert.equal(futureContractNotReady.readiness.acquisition, 'READY', 'future packet diagnostics must not block current acquisition readiness');
assert.equal(futureContractNotReady.knowledge.blocking_reasons.length, 0);
const persisted = acquisitionQualityPersistence(snapshot, sourceRegistry);
assert.deepEqual(Object.keys(persisted).sort(), [
  'acquisition_status', 'evidence_coverage', 'evidence_density', 'evidence_packet_status',
  'extraction_completeness', 'extraction_incomplete_count', 'formula_version', 'kb_blocking_count',
  'kb_completeness', 'knowledge_packet_status', 'provenance_integrity', 'schema_version',
  'security_status', 'unresolved_provenance_count', 'weak_source_packet_count'
].sort());
assert.equal(persisted.unresolved_provenance_count, 1);
assert.doesNotMatch(JSON.stringify(persisted), /source\.pdf|sensitive owner mapping detail|allocation process|missing mapping signal/);
const shadow = shadowTelemetryPersistence({
  policy_version: 'bounded_retrieval_policy_v1',
  domains: [
    { baseline_coverage: 50, final_coverage: 70, stop_reason: 'MAX_PASSES_REACHED', passes: [{ pass: 1, selected_chunk_ids: ['PRIVATE_CHUNK_CANARY'] }, { pass: 2, selected_chunk_ids: ['c2'] }] },
    { baseline_coverage: 100, final_coverage: 100, stop_reason: 'SUFFICIENT_BASELINE', passes: [] }
  ]
}, [
  { result: { status: 'OBSERVED', row_scope: 'full_table' } },
  { result: { status: 'INSUFFICIENT_SIGNAL', row_scope: 'bounded_prefix' } }
], { registry_version: 'data_signal_registry_v1', total_object_count: 60, analyzer_available_count: 2, unsupported_count: 58 });
assert.equal(shadow.retrieval_domain_count, 2);assert.equal(shadow.retrieval_triggered_domain_count, 1);assert.equal(shadow.retrieval_selected_candidate_count, 2);assert.equal(shadow.retrieval_average_gain_points, 10);assert.equal(shadow.retrieval_max_gain_points, 20);assert.equal(shadow.derived_observed_count, 1);assert.equal(shadow.scale_unsupported_count, 58);
assert.doesNotMatch(JSON.stringify(shadow), /PRIVATE_CHUNK_CANARY|source_id|chunk_id|row_value/);

const forgedLogs = {
  maturity: { A1: item('supported', [quote('FORGED_SOURCE_CANARY', 'invented-source', 'Policy')]) },
  antipattern: {}
};
const forgedSnapshot = buildAcquisitionQualitySnapshot({
  logs: forgedLogs,
  phase2: { metrics: { evidence_density: 100 } },
  sourceRegistry,
  knowledgeBase,
  runTrace: { ...runTrace, evidence_paths: [{ stream: 'maturity', criterion_id: 'A1', source_id: 'invented-source' }] }
});
assert.equal(forgedSnapshot.evidence.density.source_diversity, 0, 'unknown source IDs must receive no diversity credit');
assert.equal(forgedSnapshot.evidence.provenance.integrity, 0, 'unknown source IDs must remain unresolved');
assert.deepEqual(forgedSnapshot.evidence.provenance.unresolved_criterion_ids, ['maturity:A1']);
assert.doesNotMatch(JSON.stringify(forgedSnapshot), /FORGED_SOURCE_CANARY/);

const duplicateNameTrace = {
  ...runTrace,
  input_manifest: [
    { source_id: 'src-1', chunk_ids: ['src-1-c1'] },
    { source_id: 'src-2', chunk_ids: ['src-2-c1'] },
  ],
  evidence_paths: [{ stream: 'maturity', criterion_id: 'A1', source_document: 'duplicate.pdf' }]
};
const duplicateNameLogs = { maturity: { A1: item('supported', [{ quote: 'duplicate name evidence', source_document: 'duplicate.pdf', category: 'Policy' }]) }, antipattern: {} };
const ambiguousSnapshot = buildAcquisitionQualitySnapshot({ logs: duplicateNameLogs, phase2: { metrics: { evidence_density: 100 } }, sourceRegistry, knowledgeBase, runTrace: duplicateNameTrace });
assert.equal(ambiguousSnapshot.evidence.provenance.integrity, 0, 'a duplicate filename alone must remain unresolved');
const disambiguatedLogs = { maturity: { A1: item('supported', [{ quote: 'disambiguated evidence', source_id: 'src-1', source_document: 'duplicate.pdf', chunk_id: 'src-1-c1', category: 'Policy' }]) }, antipattern: {} };
const disambiguatedSnapshot = buildAcquisitionQualitySnapshot({ logs: disambiguatedLogs, phase2: { metrics: { evidence_density: 100 } }, sourceRegistry, knowledgeBase, runTrace: { ...duplicateNameTrace, evidence_paths: [{ stream: 'maturity', criterion_id: 'A1', source_id: 'src-1', source_document: 'duplicate.pdf', chunk_id: 'src-1-c1' }] } });
assert.equal(disambiguatedSnapshot.evidence.provenance.integrity, 100, 'source ID and chunk must establish provenance without retaining a filename');

console.log('acquisition quality tests passed');
