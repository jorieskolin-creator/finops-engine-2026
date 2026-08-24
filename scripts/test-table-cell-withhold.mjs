import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-withhold-'));
const outfile = await emitTypescript(new URL('../src/services/evidenceStagePacketService.ts', import.meta.url).pathname, dir);
const { buildEvidenceLaneStagePackets: buildEvidenceLaneStagePacketsRaw } = await import(`file://${outfile}`);

const hashString = value => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};
const hashSourcePacket = packet => hashString(JSON.stringify({
  domain_id: packet.domain_id,
  text: packet.text,
  images: packet.images.map(image => ({
    mime_type: image.mimeType, data_hash: hashString(image.data), source_id: image.source_id,
    page_id: image.page_id, page_number: image.page_number, chunk_id: image.chunk_id,
  })),
  manifest: packet.manifest,
  included_chunk_count: packet.included_chunk_count,
  total_candidate_chunks: packet.total_candidate_chunks,
  char_count: packet.char_count,
}));

const sourcePacket = {
  domain_id: 'A', title: 'Cost Visibility & Allocation',
  text: '<SOURCE_PACKET domain="A"><CHUNK id="src-001-c000" source_id="src-001" type="table_profile">Headers: Owner | Spend</CHUNK><CHUNK id="src-001-c001" source_id="src-001" type="table_row">Owner: Alice | Spend: 150</CHUNK></SOURCE_PACKET>',
  images: [],
  manifest: [
    { chunk_id: 'src-001-c000', source_id: 'src-001', type: 'table_profile', relevance: 'high', routed_domains: ['A'] },
    { chunk_id: 'src-001-c001', source_id: 'src-001', type: 'table_row', relevance: 'high', routed_domains: ['A'] },
  ],
  included_chunk_count: 2, total_candidate_chunks: 2, weak_coverage: false, coverage_notes: [], char_count: 180
};
const approvedDerived = {
  schema_version: 'derived_analytical_evidence_v1', mode: 'authoritative', evidence_id: 'EVID-DER-12345678',
  evidence_type: 'deterministic_analytical', source_id: 'src-001',
  targets: [{ stream: 'maturity', criterion_id: 'A1' }, { stream: 'antipattern', criterion_id: 'A1' }],
  derivation: { analyzer_id: 'tagging_allocation_v1', analyzer_version: '1.3.0', registry_version: 'evidence_analysis_registry_v1', method: 'tagging_allocation_coverage_analysis', calculation_ids: ['field_row_coverage'] },
  result: {
    status: 'OBSERVED', source_row_count: 2, analyzed_row_count: 2, eligible_row_count: 2, excluded_total_row_count: 0,
    row_scope: 'full_table', row_truncated: false, detected_signal_count: 1,
    mapping_population_coverage: 50, tagging_population_coverage: null, allocation_population_coverage: 50,
    field_coverage: [], cost_basis: { state: 'VALID', column_index: 1, currencies: [], excluded_row_count: 0 },
    reconciliation: { state: 'PASSED' }
  },
  summary_lines: ['owner row coverage: 50%; valid=1/2; invalid placeholders=0; state=FIELD_PRESENT_PARTIAL.'],
  locator: {}, eligibility: { state: 'ELIGIBLE', reasons: [] }, unit_fingerprint: '12345678', report_eligible: true, raw_value_exposure: false
};
const privacyDecision = {
  schema_version: 'evidence_privacy_decision_v1', policy_version: 'deterministic_evidence_privacy_v1', decision: 'PASS_WITH_REDACTIONS',
  scanned_source_count: 1, scanned_text_unit_count: 1, scanned_table_cell_count: 2, redaction_count: 0,
  findings: [], blocking_codes: []
};
const sourcePacketHash = hashSourcePacket(sourcePacket);
const sourcePacketHashes = { A: sourcePacketHash };
const readiness = {
  status: 'READY', reasons: [], privacy_decision: 'PASS_WITH_REDACTIONS',
  registry_hash: 'registry-hash', packet_manifest_hash: hashString(JSON.stringify(sourcePacketHashes))
};
const acquisitionLimitations = {
  schema_version: 'evidence_acquisition_limitations_v1', withheld_sheet_count: 0,
  withheld_row_count: 0, withheld_column_count: 0, active_filter_table_count: 0, merged_range_count: 0,
  uninspected_workbook_image_source_count: 0, partial_native_chart_count: 0, unsupported_object_codes: []
};

const withAnalyzer = buildEvidenceLaneStagePacketsRaw({
  source_packets: { A: sourcePacket }, source_packet_hashes: sourcePacketHashes,
  derived_evidence: [approvedDerived], privacy_decision: privacyDecision,
  acquisition_readiness: readiness, acquisition_limitations: acquisitionLimitations
}).A;
assert.match(withAnalyzer.text, /WITHHELD_CELL_VALUES/);
assert.doesNotMatch(withAnalyzer.text, /Alice|\b150\b/);
assert.match(withAnalyzer.text, /table_row cell chunk\(s\) withheld/);
assert.match(withAnalyzer.text, /Headers: Owner \| Spend/);

const withoutAnalyzer = buildEvidenceLaneStagePacketsRaw({
  source_packets: { A: sourcePacket }, source_packet_hashes: sourcePacketHashes,
  derived_evidence: [], privacy_decision: privacyDecision,
  acquisition_readiness: readiness, acquisition_limitations: acquisitionLimitations
}).A;
assert.match(withoutAnalyzer.text, /Owner: Alice \| Spend: 150/);
assert.doesNotMatch(withoutAnalyzer.text, /WITHHELD_CELL_VALUES/);

console.log('table cell withhold tests passed');
