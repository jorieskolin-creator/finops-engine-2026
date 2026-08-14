import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-stage-packet-'));
const outfile = join(dir, 'evidenceStagePacketService.mjs');
await build({
  entryPoints: [new URL('../src/services/evidenceStagePacketService.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { assertEvidenceLaneStagePacket, buildEvidenceLaneStagePackets } = await import(`file://${outfile}`);

const textualManifest = {
  chunk_id: 'src-001-c001', source_id: 'src-001', type: 'table_profile',
  relevance: 'high', routed_domains: ['A']
};
const visualManifest = {
  chunk_id: 'src-002-v001-c001', source_id: 'src-002', type: 'image',
  visual_unit_id: 'visual-aaaaaaaaaaaaaaaaaaaaaaaa', bounding_box: { x0: 0, y0: 0, x1: 800, y1: 600 },
  relevance: 'medium', routed_domains: ['A']
};
const sourcePacket = {
  domain_id: 'A', title: 'Cost Visibility & Allocation',
  text: '<SOURCE_PACKET domain="A"><CHUNK id="src-001-c001">owner allocation evidence</CHUNK><CHUNK id="src-002-v001-c001" type="image">OCR chart label</CHUNK></SOURCE_PACKET>',
  images: [], manifest: [textualManifest, visualManifest], included_chunk_count: 2,
  total_candidate_chunks: 3, weak_coverage: true,
  coverage_notes: ['One relevant chunk was withheld by the bounded context limit.'], char_count: 170
};
const shadowDerived = {
  schema_version: 'derived_analytical_evidence_v1', mode: 'shadow', evidence_id: 'EVID-DER-12345678',
  evidence_type: 'deterministic_analytical', source_id: 'src-001',
  targets: [{ stream: 'maturity', criterion_id: 'A1' }, { stream: 'antipattern', criterion_id: 'A1' }],
  derivation: { analyzer_id: 'tagging_allocation_v1', analyzer_version: '1.1.0', registry_version: 'evidence_analysis_registry_v1', method: 'tagging_allocation_coverage_analysis', calculation_ids: ['field_row_coverage'] },
  result: {
    status: 'OBSERVED', source_row_count: 2, analyzed_row_count: 2, eligible_row_count: 2, excluded_total_row_count: 0, row_scope: 'full_table', row_truncated: false,
    detected_signal_count: 1, mapping_population_coverage: 50, tagging_population_coverage: null, allocation_population_coverage: 50,
    field_coverage: [], cost_basis: { state: 'VALID', column_index: 1, currencies: ['USD'], excluded_row_count: 0 },
    reconciliation: { state: 'PASSED', calculated_total: 150, declared_total: 150, difference: 0 }
  },
  locator: { sheet: 'Costs', range: 'A1:B4', header_row: 1 }, eligibility: { state: 'SHADOW_ONLY', reasons: ['REGISTRY_SHADOW_ONLY'] }, unit_fingerprint: '12345678', report_eligible: false, raw_value_exposure: false
};
const privacyDecision = {
  schema_version: 'evidence_privacy_decision_v1', policy_version: 'deterministic_evidence_privacy_v1', decision: 'PASS_WITH_REDACTIONS',
  scanned_source_count: 2, scanned_text_unit_count: 2, scanned_table_cell_count: 4, redaction_count: 1,
  findings: [], blocking_codes: []
};
const readiness = {
  status: 'READY_WITH_WARNINGS', reasons: ['PACKET_COVERAGE_WARNINGS_PRESENT'], privacy_decision: 'PASS_WITH_REDACTIONS',
  registry_hash: 'registry-hash', packet_manifest_hash: 'manifest-hash'
};

const packets = buildEvidenceLaneStagePackets({
  source_packets: { A: sourcePacket }, source_packet_hashes: { A: 'source-packet-hash' },
  derived_evidence: [shadowDerived], privacy_decision: privacyDecision, acquisition_readiness: readiness
});
const packet = packets.A;
assert.equal(packet.schema_version, 'evidence_lane_stage_packet_v1');
assert.equal(packet.source_role, 'CUSTOMER_EVIDENCE');
assert.deepEqual(packet.knowledge_context, []);
assert.deepEqual(packet.images, []);
assert.deepEqual(packet.evidence, [textualManifest]);
assert.deepEqual(packet.sanitized_visual_evidence, [visualManifest]);
assert.deepEqual(packet.derived_evidence, [], 'shadow-only deterministic metrics must not reach model context');
assert.equal(packet.withheld_content.shadow_derived_evidence_count, 1);
assert.equal(packet.withheld_content.uninspected_visual_region_count, 1);
assert.equal(packet.withheld_content.raw_image_payload_count, 0);
assert.match(packet.text, /knowledge_context\[\] is intentionally empty/);
assert.match(packet.text, /<EVIDENCE_MANIFEST count="1">/);
assert.match(packet.text, /<SANITIZED_VISUAL_EVIDENCE_MANIFEST count="1">/);
assert.match(packet.text, /No report-eligible deterministic analytical evidence is approved/);
assert.match(packet.text, /<CUSTOMER_EVIDENCE>[\s\S]*owner allocation evidence/);
assert.doesNotThrow(() => assertEvidenceLaneStagePacket(packet));
assert.throws(() => assertEvidenceLaneStagePacket({ ...packet, text: `${packet.text} tampered` }), /INTEGRITY_FAILED/);

const unapprovedClaim = { ...shadowDerived, mode: 'authoritative', report_eligible: true };
const unapprovedPacket = buildEvidenceLaneStagePackets({
  source_packets: { A: sourcePacket }, source_packet_hashes: { A: 'source-packet-hash' },
  derived_evidence: [unapprovedClaim], privacy_decision: privacyDecision, acquisition_readiness: readiness
}).A;
assert.deepEqual(unapprovedPacket.derived_evidence, [], 'self-declared authority cannot bypass the registry approval state');
assert.equal(unapprovedPacket.withheld_content.shadow_derived_evidence_count, 1);

assert.throws(() => buildEvidenceLaneStagePackets({
  source_packets: { A: sourcePacket }, source_packet_hashes: { A: 'source-packet-hash' }, derived_evidence: [],
  privacy_decision: { ...privacyDecision, decision: 'BLOCK', blocking_codes: ['PROHIBITED_SECRET_DETECTED'] },
  acquisition_readiness: { ...readiness, status: 'BLOCKED' }
}), /NOT_APPROVED/);
assert.throws(() => buildEvidenceLaneStagePackets({
  source_packets: { A: { ...sourcePacket, images: [{ mimeType: 'image/png', data: 'raw' }] } },
  source_packet_hashes: { A: 'source-packet-hash' }, derived_evidence: [], privacy_decision: privacyDecision, acquisition_readiness: readiness
}), /RAW_IMAGE_PAYLOAD_NOT_PERMITTED/);
assert.throws(() => buildEvidenceLaneStagePackets({
  source_packets: { A: sourcePacket }, source_packet_hashes: { A: 'source-packet-hash' },
  derived_evidence: [{ ...shadowDerived, result: { ...shadowDerived.result, reconciliation: { state: 'FAILED', calculated_total: 150, declared_total: 200, difference: -50 } } }],
  privacy_decision: privacyDecision, acquisition_readiness: readiness
}), /DERIVED_EVIDENCE_RECONCILIATION_FAILED/);

console.log('evidence stage packet tests passed');
