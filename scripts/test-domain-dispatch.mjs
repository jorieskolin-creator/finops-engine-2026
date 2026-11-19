import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(await mkdtemp(join(tmpdir(), 'finops-dispatch-')), 'test.mjs');
await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    contents: `
      export { runPhase1Audit } from './src/orchestrator';
      export { knowledgeBaseService } from './src/knowledge_base';
      export { buildDomainPackets, buildSourceRegistry, scanRegistryDlp, sourceRegistryRuntimeStatus } from './src/services/sourceRegistryService';
      export { deriveAllEvidenceSignals } from './src/services/derivedEvidence';
      export { validateEvidenceAcquisition, validateKnowledgeAcquisition, validatePreSynthesisIntegrity } from './src/services/pipelineIntegrityService';
      export { buildEvidenceLaneStagePackets } from './src/services/evidenceStagePacketService';
      export { renderDelimitedTableForAnalysis } from './src/services/tableService';
      export { calculateMetrics } from './src/services/metricsService';
      export { inferAntiPatternAbsenceStatus } from './src/services/antiPatternSemantics';`,
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{
    name: 'mock-model-boundary',
    setup(context) {
      context.onResolve({ filter: /\/modelRouter$/ }, () => ({ path: 'router', namespace: 'mock-model' }));
      context.onLoad({ filter: /.*/, namespace: 'mock-model' }, () => ({ contents: `
        export const runStage = (...args) => globalThis.dispatchTestModel(...args);
        export const serverLog = () => {};
        export class StageExecutionError extends Error {}
      ` }));
    },
  }],
});
const engine = await import(pathToFileURL(out));
engine.knowledgeBaseService.fetchReferenceKnowledgeBaseContext = async () => '';
const calls = [];
globalThis.dispatchTestModel = async (stage, prompt) => {
  const domain = prompt.userText.match(/<EVIDENCE_LANE_STAGE_PACKET[^>]+domain="([A-F])"/)?.[1];
  assert.ok(domain);
  calls.push([domain, stage]);
  const entries = Array.from({ length: 5 }, (_, index) => `${domain}${index + 1}`);
  const result = stage === 'forensic_audit'
    ? Object.fromEntries(['maturity', 'antipattern'].map(stream => [stream, Object.fromEntries(entries.map(id => [id, {
      count: 0, evidence: 'Insufficient criterion coverage.', reasoning: 'Insufficient criterion coverage.',
      assessment_status: 'not_assessed', evidence_quotes: [], question_results: ['unknown', 'unknown', 'unknown'],
    }]))]))
    : { items: ['maturity', 'antipattern'].flatMap(stream => entries.map(id => ({
      stream, id, original_count: 0, verified_count: 0, status: 'supported', assessment_status: 'not_assessed',
      rationale: 'Insufficient criterion coverage.', quote_supported: false, rescan_recommended: false,
      ...(stream === 'antipattern' ? { antipattern_absence_status: 'unknown_absent', coverage_reason: 'Insufficient criterion coverage.' } : {}),
    }))) };
  return { text: JSON.stringify(result), modelUsed: { id: 'stub' } };
};

const sources = [{ schema_version: 'source_record_v1', source_id: 'src-001', source_name: 'background.txt', kind: 'text', text: 'Our organizational methods include learning and decision reviews.' }];
const csv = engine.renderDelimitedTableForAnalysis('UsageDate,Cost Center,BilledCost,BillingCurrency\n2026-05-01,CC-1,8,EUR', { fileName: 'cost.csv', delimiter: ',' });
const billing = { schema_version: 'source_record_v1', source_id: 'src-002', source_name: 'cost.csv', kind: 'csv', text: csv.text, structured_table: csv.structuredTable,
  extraction: { unit: 'row', total_units: 1, processed_units: 1, truncated: false, quality: 'good' } };
const knowledge = { status: { source: 'built_in', document_count: 0 }, documents: [] };
const privacy = { decision: 'PASS', blocking_codes: [] };

async function dispatch(records, derivedOnly = false) {
  const registry = engine.buildSourceRegistry(records);
  const derived = engine.deriveAllEvidenceSignals(records, registry).evidence;
  if (derivedOnly) registry.chunks.forEach(chunk => { chunk.routing = []; });
  const packets = engine.buildDomainPackets(registry);
  const integrity = engine.validateEvidenceAcquisition(records, registry, packets);
  const status = engine.sourceRegistryRuntimeStatus(registry, packets, 0, engine.scanRegistryDlp(registry), privacy, integrity);
  const stages = engine.buildEvidenceLaneStagePackets({ source_packets: packets, source_packet_hashes: integrity.packet_hashes,
    derived_evidence: derived, acquisition_limitations: registry.acquisition_limitations, privacy_decision: privacy, acquisition_readiness: status.acquisition_readiness });
  const phase = await engine.runPhase1Audit(() => {}, { runId: 'dispatch-test' }, { packets: stages });
  const validate = (result, stagePackets = stages) => engine.validatePreSynthesisIntegrity(integrity, engine.validateKnowledgeAcquisition(knowledge), registry, packets, knowledge, result, derived, stagePackets);
  validate(phase);
  return { phase, stages, validate };
}

const empty = await dispatch(sources);
assert.deepEqual(calls, []);
assert.equal(empty.phase.evidence_check.total_items, 60);
assert.equal(empty.phase.evidence_check.skipped_count, 60);
assert.equal(empty.phase.evidence_check.missing_count, 0);
assert.equal(engine.calculateMetrics(empty.phase.phase_1_audit_logs).metrics.evidence_density, 0);
assert.equal(engine.inferAntiPatternAbsenceStatus({ ...empty.phase.phase_1_audit_logs.antipattern.F4, coverage_reason: 'Weak evidence of an anti-pattern.' }), 'unknown_absent');
assert.throws(() => empty.validate({ ...empty.phase, skipped_domains: { ...empty.phase.skipped_domains, A: 'bad-hash' } }), /Evidence verification/);

for (const derivedOnly of [false, true]) {
  calls.length = 0;
  const { phase, stages } = await dispatch([...sources, billing], derivedOnly);
  assert.deepEqual(calls, [['A', 'forensic_audit'], ['A', 'evidence_check']]);
  assert.equal(phase.evidence_check.skipped_count, 50);
  assert.equal(phase.evidence_check.supported_count, 10);
  assert.deepEqual(Object.keys(phase.skipped_domains).sort(), ['B', 'C', 'D', 'E', 'F']);
  if (derivedOnly) {
    assert.equal(stages.A.evidence.length, 0);
    assert.ok(stages.A.derived_evidence.length > 0);
  }
}
console.log('empty, mixed and derived-only domain dispatch tests passed');
