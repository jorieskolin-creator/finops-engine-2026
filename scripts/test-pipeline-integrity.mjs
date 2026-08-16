import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const sourcePath = new URL('../src/services/pipelineIntegrityService.ts', import.meta.url);
const dir = await mkdtemp(join(tmpdir(), 'finops-pipeline-integrity-'));
const evidenceSupportSource = await readFile(new URL('../src/services/evidenceSupport.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'evidenceSupport.mjs'), ts.transpileModule(evidenceSupportSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 },
}).outputText, 'utf8');
let source = await readFile(sourcePath, 'utf8');
source = source
  .replace(/import type \{[\s\S]*?\} from '\.\.\/types';\n/, '')
  .replace(/import \{[\s\S]*?\} from '\.\.\/knowledge_base';\n/, `
const BATCH_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const BATCH_DEFINITIONS = Object.fromEntries(BATCH_IDS.map(domain => [domain, { title: domain, maturity: { one: true }, antipattern: { one: true } }]));
const buildShadowKnowledgePacket = () => ({ readiness: 'NOT_READY' });
`)
  .replace("import { isEvidenceQuoteBoundToChunk, isEvidenceQuoteBoundToDerivedEvidence } from './evidenceSupport';", "import { isEvidenceQuoteBoundToChunk, isEvidenceQuoteBoundToDerivedEvidence } from './evidenceSupport.mjs';")
  .replace("import { hashString } from './runTraceService';", `
const hashString = value => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return \`fnv1a_\${(hash >>> 0).toString(16).padStart(8, '0')}\`;
};
`);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 },
}).outputText;
const modulePath = join(dir, 'pipelineIntegrityService.mjs');
await writeFile(modulePath, output, 'utf8');
const {
  PipelineIntegrityError,
  validateEvidenceAcquisition,
  validateKnowledgeAcquisition,
  validatePreSynthesisIntegrity,
} = await import(pathToFileURL(modulePath));

const sourceRecord = {
  schema_version: 'source_record_v1', source_id: 'src-001', source_name: 'input.txt', kind: 'text', text: 'General finance material.',
  extraction: { unit: 'document', total_units: 1, processed_units: 1, truncated: false, quality: 'mixed', text_coverage_ratio: 0.8 },
};
const chunk = { chunk_id: 'src-001-c001', source_id: 'src-001', source_name: 'input.txt', type: 'text', text: sourceRecord.text, routing: [] };
const registry = {
  source_count: 1, chunk_count: 1, chunks: [chunk], warnings: [],
  acquisition_limitations: { schema_version: 'evidence_acquisition_limitations_v1', withheld_sheet_count: 0, withheld_row_count: 0, withheld_column_count: 0, active_filter_table_count: 0, merged_range_count: 0, uninspected_workbook_image_source_count: 0, partial_native_chart_count: 0, unsupported_object_codes: [] },
  extraction: {
    overall_completeness: 80, status: 'PARTIAL', warning_count: 0,
    sources: [{ source_id: 'src-001', source_name: 'input.txt', kind: 'text', completeness: 80, status: 'PARTIAL', unit: 'document', total_units: 1, processed_units: 1, text_coverage_ratio: 0.8, truncated: false, quality: 'mixed', warning_count: 0, warning_codes: ['MIXED_QUALITY'] }],
    blocking_reasons: [],
  },
};
const emptyPacket = domain => {
  const text = `<SOURCE_PACKET domain="${domain}"><NO_ROUTED_CHUNKS>None</NO_ROUTED_CHUNKS></SOURCE_PACKET>`;
  return { domain_id: domain, title: domain, text, images: [], manifest: [], included_chunk_count: 0, total_candidate_chunks: 0, weak_coverage: true, coverage_notes: [], char_count: text.length };
};
const packets = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map(domain => [domain, emptyPacket(domain)]));

const evidenceSnapshot = validateEvidenceAcquisition([sourceRecord], registry, packets);
assert.equal(Object.keys(evidenceSnapshot.packet_hashes).length, 6, 'valid empty domain packets must pass');
assert.throws(
  () => validateEvidenceAcquisition([sourceRecord], registry, { ...packets, F: undefined }),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_PACKET_INTEGRITY_FAILED',
);
assert.throws(
  () => validateEvidenceAcquisition([sourceRecord], registry, {
    ...packets,
    A: { ...packets.A, total_candidate_chunks: 1 },
  }),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_PACKET_INTEGRITY_FAILED' && error.domains[0] === 'A',
  'routed content that could not fit the governed packet is acquisition loss, not source silence',
);
const truncatedRegistry = structured => ({
  ...registry,
  extraction: { ...registry.extraction, status: 'PARTIAL', sources: [{ ...registry.extraction.sources[0], kind: structured ? 'csv' : 'text', unit: structured ? 'row' : 'document', total_units: 10, processed_units: 5, truncated: true }] },
});
assert.throws(
  () => validateEvidenceAcquisition([sourceRecord], truncatedRegistry(false), packets),
  error => error instanceof PipelineIntegrityError && error.code === 'SOURCE_EXTRACTION_INCOMPLETE',
);
const tableSource = { ...sourceRecord, kind: 'csv', extraction: { unit: 'row', total_units: 10, processed_units: 5, truncated: true }, structured_table: { schema_version: 'structured_table_v1', headers: ['cost'], rows: [['1']], total_row_count: 10, truncated: true } };
assert.throws(
  () => validateEvidenceAcquisition([tableSource], truncatedRegistry(true), packets),
  error => error instanceof PipelineIntegrityError && error.code === 'SOURCE_EXTRACTION_INCOMPLETE',
  'a bounded model sample must not excuse incomplete deterministic table acquisition',
);
const completeTableSource = {
  ...sourceRecord,
  kind: 'csv',
  extraction: { unit: 'row', total_units: 2, processed_units: 2, truncated: false },
  structured_table: {
    schema_version: 'structured_table_v1', headers: ['cost'], rows: [['1']],
    analysis_rows: [['1'], ['2']], analysis_row_numbers: [2, 3], total_row_count: 2,
    analysis_complete: true, truncated: true,
    deterministic_inspection: { schema_version: 'deterministic_table_inspection_v1', population_scope: 'FULL_TABLE', row_count: 2 },
  },
};
const completeTableRegistry = {
  ...registry,
  extraction: {
    ...registry.extraction,
    status: 'COMPLETE', overall_completeness: 100,
    sources: [{ ...registry.extraction.sources[0], kind: 'csv', unit: 'row', total_units: 2, processed_units: 2, completeness: 100, status: 'COMPLETE', truncated: false }],
  },
};
assert.doesNotThrow(
  () => validateEvidenceAcquisition([completeTableSource], completeTableRegistry, packets),
  'complete deterministic populations remain valid when only model context is bounded',
);

const knowledgeIndex = { status: { source: 'built_in', document_count: 0, failure_count: 1 }, documents: [], failures: [] };
const knowledgeSnapshot = validateKnowledgeAcquisition(knowledgeIndex);
assert.equal(knowledgeSnapshot.mode, 'built_in', 'valid built-in fallback must pass when remote KB is unavailable');
const healthyRemoteWithFutureContractNotReady = {
  status: {
    source: 'remote_blob', document_count: 60, failure_count: 0,
    delivery: { shadow_ready: false },
    shadow_packets: { 'A:forensic_audit': { readiness: 'NOT_READY' } },
  },
  documents: [], failures: [],
};
const remoteSnapshot = validateKnowledgeAcquisition(healthyRemoteWithFutureContractNotReady);
assert.equal(remoteSnapshot.mode, 'remote_blob', 'future packet readiness telemetry must not select built-in fallback');

const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domain => [1, 2, 3, 4, 5].map(index => `${domain}${index}`));
const logs = Object.fromEntries(ids.map(id => [id, { count: 0, evidence_quotes: [] }]));
const items = ids.flatMap(id => ['maturity', 'antipattern'].map(stream => ({ stream, id, status: 'missing', original_count: 0, verified_count: 0, rationale: 'No evidence in valid packet.' })));
const phase1 = {
  phase_1_audit_logs: { maturity: { ...logs }, antipattern: { ...logs } },
  evidence_check: { total_items: 60, supported_count: 0, weak_count: 0, unsupported_count: 0, missing_count: 60, downgraded_count: 0, rescan_count: 0, items, adjustments: [] },
  failed_batches: [],
};
assert.doesNotThrow(() => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, registry, packets, knowledgeIndex, phase1), 'valid source silence must reach synthesis');
assert.throws(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, registry, packets, knowledgeIndex, { ...phase1, failed_batches: ['F'] }),
  error => error instanceof PipelineIntegrityError && error.code === 'DOMAIN_ANALYSIS_FAILED' && error.domains[0] === 'F',
);
assert.throws(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, registry, { ...packets, A: { ...packets.A, text: `${packets.A.text} changed`, char_count: packets.A.char_count + 8 } }, knowledgeIndex, phase1),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_PACKET_CONTINUITY_FAILED',
);
const safelyDegradedVerification = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: {
      ...phase1.phase_1_audit_logs.maturity,
      A1: { ...phase1.phase_1_audit_logs.maturity.A1, verification_unresolved: true, verified_count: null },
    },
  },
  evidence_check: { ...phase1.evidence_check, failed: true, items: phase1.evidence_check.items.map((item, index) => index === 0 ? { ...item, verification_unresolved: true } : item) },
};
assert.doesNotThrow(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, registry, packets, knowledgeIndex, safelyDegradedVerification),
  'a complete conservative verifier fallback must reach the deterministic BLOCK quality gate',
);
assert.throws(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, registry, packets, knowledgeIndex, { ...phase1, evidence_check: { ...phase1.evidence_check, items: phase1.evidence_check.items.map((item, index) => index === 0 ? { ...item, status: 'supported', verified_count: 1, verification_unresolved: true } : item) } }),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_VERIFICATION_FAILED',
  'an unresolved positive verifier decision must remain fatal',
);
assert.throws(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, { ...registry, chunk_count: 2 }, packets, knowledgeIndex, phase1),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_PACKET_CONTINUITY_FAILED',
  'registry metadata mutation must be detected before synthesis',
);
assert.throws(
  () => validatePreSynthesisIntegrity(evidenceSnapshot, knowledgeSnapshot, {
    ...registry,
    acquisition_limitations: { ...registry.acquisition_limitations, withheld_row_count: 1 },
  }, packets, knowledgeIndex, phase1),
  error => error instanceof PipelineIntegrityError && error.code === 'EVIDENCE_PACKET_CONTINUITY_FAILED',
  'withheld-content accounting mutation must be detected before synthesis',
);
const routedPacket = {
  ...packets.A,
  text: `<SOURCE_PACKET domain="A"><CHUNK id="${chunk.chunk_id}" source_id="${chunk.source_id}">${chunk.text}</CHUNK></SOURCE_PACKET>`,
  manifest: [{ chunk_id: chunk.chunk_id, source_id: chunk.source_id, type: 'text', relevance: 'high', routed_domains: ['A'] }],
  included_chunk_count: 1,
};
routedPacket.char_count = routedPacket.text.length;
const routedPackets = { ...packets, A: routedPacket };
const routedSnapshot = validateEvidenceAcquisition([sourceRecord], registry, routedPackets);
const validLocatedPhase1 = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: { ...phase1.phase_1_audit_logs.maturity, A1: { count: 1, evidence_quotes: [{ quote: chunk.text, chunk_id: chunk.chunk_id, source_id: chunk.source_id }] } },
  },
};
assert.doesNotThrow(
  () => validatePreSynthesisIntegrity(routedSnapshot, knowledgeSnapshot, registry, routedPackets, knowledgeIndex, validLocatedPhase1),
  'positive evidence with an exact governed chunk locator and quote must pass',
);
const missingProvenancePhase1 = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: { ...phase1.phase_1_audit_logs.maturity, A1: { count: 1, evidence_quotes: [{ quote: chunk.text }] } },
  },
};
assert.throws(
  () => validatePreSynthesisIntegrity(routedSnapshot, knowledgeSnapshot, registry, routedPackets, knowledgeIndex, missingProvenancePhase1),
  error => error instanceof PipelineIntegrityError && error.code === 'FINDING_PROVENANCE_INVALID',
  'positive evidence without mandatory provenance must block synthesis',
);
const forgedQuotePhase1 = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: { ...phase1.phase_1_audit_logs.maturity, A1: { count: 1, evidence_quotes: [{ quote: 'A fabricated claim', chunk_id: chunk.chunk_id, source_id: chunk.source_id }] } },
  },
};
assert.throws(
  () => validatePreSynthesisIntegrity(routedSnapshot, knowledgeSnapshot, registry, routedPackets, knowledgeIndex, forgedQuotePhase1),
  error => error instanceof PipelineIntegrityError && error.code === 'FINDING_PROVENANCE_INVALID',
  'a quote that is absent from its cited chunk must block synthesis',
);
const invalidLocatorPhase1 = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: { ...phase1.phase_1_audit_logs.maturity, A1: { count: 1, evidence_quotes: [{ quote: chunk.text, chunk_id: 'missing-chunk', source_id: 'src-001' }] } },
  },
};
assert.throws(
  () => validatePreSynthesisIntegrity(routedSnapshot, knowledgeSnapshot, registry, routedPackets, knowledgeIndex, invalidLocatorPhase1),
  error => error instanceof PipelineIntegrityError && error.code === 'FINDING_PROVENANCE_INVALID',
  'evidence locators must resolve within the governed domain packet',
);
const mismatchedSheetPhase1 = {
  ...phase1,
  phase_1_audit_logs: {
    ...phase1.phase_1_audit_logs,
    maturity: { ...phase1.phase_1_audit_logs.maturity, A1: { count: 1, evidence_quotes: [{ quote: chunk.text, chunk_id: chunk.chunk_id, source_id: chunk.source_id, sheet_name: 'Wrong Sheet' }] } },
  },
};
assert.throws(
  () => validatePreSynthesisIntegrity(routedSnapshot, knowledgeSnapshot, registry, routedPackets, knowledgeIndex, mismatchedSheetPhase1),
  error => error instanceof PipelineIntegrityError && error.code === 'FINDING_PROVENANCE_INVALID',
  'model-supplied sheet and row locators must match the governed packet manifest',
);

console.log('pipeline integrity tests passed');
