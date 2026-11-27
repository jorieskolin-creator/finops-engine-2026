import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
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
      export { sanitizeEvidenceSources } from './src/services/deterministicPrivacyService';
      export { StageExecutionError } from './src/services/modelRouter';
      export { applyBoundedRetrieval } from './src/services/boundedRetrievalService';
      export { planAcquisitionGapQueries, retrieveAcquisitionGaps } from './src/services/acquisitionGapRetrievalService';
      export { acquireEvidence } from './src/services/evidenceAcquisitionService';
      export { runRetrievalVerification } from './src/monitoring/retrievalVerification';
      export { compareRetrievalReference } from './src/monitoring/retrievalReference';
      export { inspectEvidenceBytes } from './src/services/evidenceFileService';
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
        export class StageExecutionError extends Error {
          constructor(code, fallbackAllowed = false) {
            super(code);
            this.name = 'StageExecutionError';
            this.code = code;
            this.fallbackAllowed = fallbackAllowed;
          }
        }
      ` }));
    },
  }, {
    name: 'known-browser-fixture',
    setup(context) {
      context.onResolve({ filter: /^\.\/retrievalFixture$/ }, () => ({ path: 'fixture', namespace: 'mock-fixture' }));
      context.onLoad({ filter: /.*/, namespace: 'mock-fixture' }, () => ({
        contents: 'export const loadRetrievalFixture = () => globalThis.loadTestRetrievalFixture();',
      }));
    },
  }],
});
const engine = await import(pathToFileURL(out));
const { StageExecutionError: MockStageExecutionError } = await import(pathToFileURL(out));
engine.knowledgeBaseService.fetchReferenceKnowledgeBaseContext = async () => '';
const calls = [];
let plannerUnavailable = false;
let plannerTerm = 'spending outlook';
globalThis.dispatchTestModel = async (stage, prompt) => {
  if (stage === 'evidence_gap_analysis') {
    const request = JSON.parse(prompt.userText);
    calls.push([request.domain_id, stage]);
    assert.doesNotMatch(prompt.userText, /PRIVATE_CANARY|Azure|background\.txt|src-00/);
    assert.equal(request.round, 2);
    if (plannerUnavailable) throw new Error('Planner unavailable');
    const text = JSON.stringify({ schema_version: 'finops_evidence_gap_query_v1', domain_id: request.domain_id,
      queries: request.gaps.map(gap => ({ criterion_id: gap.criterion_id, themes: [plannerTerm], terms: [plannerTerm] })) });
    prompt.validateOutput(text);
    return { text, modelUsed: { id: 'stub' } };
  }
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

async function dispatch(input, derivedOnly = false) {
  const records = engine.sanitizeEvidenceSources(input).sources;
  let registry = engine.buildSourceRegistry(records);
  let derived = engine.deriveAllEvidenceSignals(records, registry).evidence;
  if (derivedOnly) registry.chunks.forEach(chunk => { chunk.routing = []; });
  const initialPackets = engine.buildDomainPackets(registry);
  const plan = engine.planAcquisitionGapQueries(registry, initialPackets, derived);
  const bounded = engine.applyBoundedRetrieval(registry, initialPackets, { reserve_semantic_round_for: new Set(plan.keys()) });
  const recovered = await engine.retrieveAcquisitionGaps(registry, bounded.packets, plan, { runId: 'dispatch-test' });
  if (recovered.registry !== registry) {
    registry = recovered.registry;
    derived = engine.deriveAllEvidenceSignals(records, registry).evidence;
  }
  const { packets } = recovered;
  const integrity = engine.validateEvidenceAcquisition(records, registry, packets);
  const status = engine.sourceRegistryRuntimeStatus(registry, packets, 0, engine.scanRegistryDlp(registry), privacy, integrity);
  const stages = engine.buildEvidenceLaneStagePackets({ source_packets: packets, source_packet_hashes: integrity.packet_hashes,
    derived_evidence: derived, acquisition_limitations: registry.acquisition_limitations, privacy_decision: privacy, acquisition_readiness: status.acquisition_readiness });
  const phase = await engine.runPhase1Audit(() => {}, { runId: 'dispatch-test' }, { packets: stages });
  const validate = (result, stagePackets = stages) => engine.validatePreSynthesisIntegrity(integrity, engine.validateKnowledgeAcquisition(knowledge), registry, packets, knowledge, result, derived, stagePackets);
  validate(phase);
  return { phase, stages, validate, initialPackets, bounded: bounded.trace, recovery: recovered.passes };
}

const empty = await dispatch(sources);
assert.deepEqual(calls, []);
assert.equal(empty.phase.evidence_check.total_items, 60);
assert.equal(empty.phase.evidence_check.skipped_count, 60);
assert.equal(empty.phase.evidence_check.missing_count, 0);
assert.equal(engine.calculateMetrics(empty.phase.phase_1_audit_logs).metrics.evidence_density, 0);
assert.deepEqual(engine.calculateMetrics(empty.phase.phase_1_audit_logs).confirmed_maturity_gaps, []);
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

const nearMiss = { ...sources[0], source_id: 'src-003', text: 'Our Azure team recorded the forecast as a spending outlook for next month. PRIVATE_CANARY.' };
const samePhraseUnscoped = { ...sources[0], source_id: 'src-004', text: 'A spending outlook and a forecast are theoretical topics for general study.' };
const samePhraseReference = { ...sources[0], source_id: 'src-005', text: 'Training material: our Azure forecast as a spending outlook is an example.' };
const recoveryInputs = [...sources, nearMiss, samePhraseUnscoped, samePhraseReference];
calls.length = 0;
const recovered = await dispatch(recoveryInputs);
assert.equal(recovered.initialPackets.C.included_chunk_count, 0);
assert.equal(recovered.bounded.domains.find(domain => domain.domain_id === 'C').passes.length, 1);
assert.deepEqual(recovered.recovery.map(pass => [pass.domain_id, pass.round, pass.outcome]), [['C', 2, 'NEW_EVIDENCE_SELECTED']]);
assert.deepEqual(recovered.stages.C.evidence.map(item => item.source_id), ['src-003']);
assert.deepEqual(calls, [['C', 'evidence_gap_analysis'], ['C', 'forensic_audit'], ['C', 'evidence_check']]);
assert.equal(recovered.recovery[0].recovery_source, 'model');
assert.equal(recovered.recovery[0].model_match_count, 1);
assert.equal(recovered.recovery[0].local_match_count, undefined, 'AI success must not run the fallback');

{
  const directory = new URL('../src/monitoring/fixtures/retrieval-v1/', import.meta.url);
  const inputs = await Promise.all(['billing.csv', 'forecast.html', 'background.html'].map(async (name, index) => {
    const bytes = await readFile(new URL(name, directory));
    const tabular = name.endsWith('.csv');
    const acquisition = await engine.inspectEvidenceBytes({ bytes, fileName: name, declaredMediaType: tabular ? 'text/csv' : 'text/html' });
    assert.equal(acquisition.original_sha256, `sha256_${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(acquisition.validation_status, 'PASS');
    const raw = bytes.toString('utf8');
    const rendered = tabular ? engine.renderDelimitedTableForAnalysis(raw, { fileName: name, delimiter: 'auto', sourceHash: acquisition.original_sha256 }) : null;
    // The fixture HTML files contain plain text in a single body. The browser intake uses DOMParser.
    const text = rendered?.text ?? raw.match(/<body>([^<>]+)<\/body>/)?.[1];
    assert.ok(text);
    return {
      schema_version: 'source_record_v1', source_id: `src-00${index + 1}`, source_name: `Document 00${index + 1}`,
      kind: tabular ? 'csv' : 'html', text, structured_table: rendered?.structuredTable,
      extraction: { unit: tabular ? 'row' : 'document', total_units: rendered?.rowCount ?? 1, processed_units: rendered?.rowCount ?? 1, truncated: false },
      acquisition: { ...acquisition, extraction_status: 'PASS', extraction_method: tabular ? 'browser_delimited' : 'browser_dom',
        extraction_version: tabular ? 'delimited_parser_v3' : 'dompurify@3' },
    };
  }));
  calls.length = 0;
  const acquisition = await engine.acquireEvidence(inputs, { runId: 'golden-retrieval-test' });
  assert.deepEqual(calls, [['C', 'evidence_gap_analysis']]);
  assert.deepEqual(acquisition.acquisitionGap.passes.map(pass => pass.criterion_ids), [['maturity.C2']]);
  assert.equal(acquisition.dlpScan.blocked, false);
  assert.ok(acquisition.evidenceIntegrity.packet_manifest_hash);
  const comparison = {
    sources: acquisition.acquiredSources, baselinePackets: acquisition.baselineSourcePackets,
    finalPackets: acquisition.sourcePackets, registry: acquisition.sourceRegistry,
  };
  assert.ok(Object.values(engine.compareRetrievalReference(comparison)).every(Boolean), JSON.stringify(engine.compareRetrievalReference(comparison)));

  const wrong = structuredClone(comparison);
  wrong.sources[0].structured_table.deterministic_inspection.duplicate_row_rate_percent = 0;
  wrong.finalPackets.A.manifest = [];
  wrong.finalPackets.C.manifest[0].source_id = 'src-003';
  const checks = engine.compareRetrievalReference(wrong);
  assert.equal(checks.calculation, false);
  assert.equal(checks.directEvidence, false);
  assert.equal(checks.recoveredEvidence, false);
  assert.equal(checks.irrelevantEvidenceExcluded, false);

  const fetchBefore = globalThis.fetch;
  const commands = [];
  globalThis.loadTestRetrievalFixture = async () => {
    commands.push('fixture_ready');
    return inputs;
  };
  let deadlineOffset = 60_000;
  globalThis.fetch = async (_url, init) => {
    const { action, opening_id } = JSON.parse(init.body);
    commands.push(action);
    const run = action === 'create_retrieval'
      ? { run_id: opening_id, state: 'active', cleanup_status: null, absolute_deadline_at: new Date(Date.now() + deadlineOffset).toISOString() }
      : { run_id: 'retrieval-test', state: 'completed', cleanup_status: 'verified',
          retrieval_usage: { reserved_attempts: 1, authorized_attempts: 1, input_tokens: 20, output_tokens: 12 } };
    return { ok: true, json: async () => run };
  };
  try {
    calls.length = 0;
    const opening = '00000000-0000-4000-8000-000000000001';
    const verification = engine.runRetrievalVerification(opening);
    assert.equal(engine.runRetrievalVerification(opening), verification, 'concurrent calls share one run');
    const passed = await verification;
    assert.equal(passed.status, 'Pass');
    assert.equal(passed.model, 'stub');
    assert.equal(passed.runId, opening);
    assert.equal(passed.usage.output_tokens, 12);
    assert.deepEqual(passed.diagnostics, { localLeads: 1, modelMatches: 1, localMatches: undefined, admitted: 1 });
    assert.deepEqual(calls, [['C', 'evidence_gap_analysis']]);
    assert.deepEqual(commands, ['fixture_ready', 'create_retrieval', 'finish_retrieval']);

    calls.length = 0;
    commands.length = 0;
    plannerUnavailable = true;
    const incomplete = await engine.runRetrievalVerification('00000000-0000-4000-8000-000000000002');
    assert.equal(incomplete.status, 'Incomplete');
    assert.equal(incomplete.reason, 'AI Gap Analyzer unverified');
    assert.equal(incomplete.checks.directEvidence, true);
    assert.equal(incomplete.checks.recoveredEvidence, true, 'local recovery cannot verify an unavailable AI response');
    assert.deepEqual(incomplete.diagnostics, { localLeads: 1, modelMatches: undefined, localMatches: 1, admitted: 1 });
    assert.deepEqual(calls, [['C', 'evidence_gap_analysis']]);
    assert.deepEqual(commands, ['fixture_ready', 'create_retrieval', 'finish_retrieval']);

    calls.length = 0;
    commands.length = 0;
    plannerUnavailable = false;
    plannerTerm = 'anticipated expenditure';
    const localRecovery = await engine.runRetrievalVerification('00000000-0000-4000-8000-000000000003');
    assert.equal(localRecovery.status, 'Review', 'recovering locally cannot pass the AI check');
    assert.equal(localRecovery.reason, 'Local fallback recovered');
    assert.equal(localRecovery.model, 'stub');
    assert.equal(localRecovery.checks.recoveredEvidence, true);
    assert.equal(localRecovery.checks.irrelevantEvidenceExcluded, true);
    assert.deepEqual(localRecovery.diagnostics, { localLeads: 1, modelMatches: 0, localMatches: 1, admitted: 1 });
    assert.deepEqual(calls, [['C', 'evidence_gap_analysis']], 'a query miss must not make a second provider call');
    assert.deepEqual(commands, ['fixture_ready', 'create_retrieval', 'finish_retrieval']);

    calls.length = 0;
    commands.length = 0;
    deadlineOffset = -1;
    const expired = await engine.runRetrievalVerification('00000000-0000-4000-8000-000000000004');
    assert.equal(expired.status, 'Incomplete');
    assert.equal(expired.reason, 'Retrieval deadline exceeded');
    assert.deepEqual(calls, []);
    assert.deepEqual(commands, ['fixture_ready', 'create_retrieval', 'finish_retrieval']);

    commands.length = 0;
    globalThis.loadTestRetrievalFixture = async () => { throw new Error('GOLDEN_STANDARD_FIXTURE_MISMATCH'); };
    const badFixture = await engine.runRetrievalVerification('00000000-0000-4000-8000-000000000005');
    assert.equal(badFixture.reason, 'Fixture needs review');
    assert.deepEqual(commands, []);
  } finally {
    globalThis.fetch = fetchBefore;
    delete globalThis.loadTestRetrievalFixture;
    plannerUnavailable = false;
    plannerTerm = 'spending outlook';
  }
}

{
  calls.length = 0;
  plannerTerm = 'anticipated expenditure';
  const noRecovery = await dispatch(recoveryInputs);
  const pass = noRecovery.recovery[0];
  assert.equal(pass.outcome, 'NO_ELIGIBLE_GAIN', 'a valid query still reports a miss when neither search corroborates a lead');
  assert.equal(pass.recovery_source, undefined);
  assert.equal(pass.model_match_count, 0);
  assert.equal(pass.local_match_count, 0);
  assert.deepEqual(pass.selected_chunk_ids, []);
  assert.deepEqual(calls, [['C', 'evidence_gap_analysis']]);

  calls.length = 0;
  const localInputs = [
    { ...nearMiss, text: 'Our Azure team reviewed the forecast. The spending projection was recorded for next month.' },
    { ...samePhraseUnscoped, text: 'A forecast and spending projection are theoretical examples for general study.' },
    { ...samePhraseReference, text: 'Training material: our Azure forecast uses a spending projection as an example.' },
    { ...nearMiss, source_id: 'src-006', text: 'Our Azure team recorded the forecast but did not review the next month yet.' },
  ];
  const localAssessment = await dispatch([...sources, ...localInputs]);
  assert.equal(localAssessment.recovery[0].recovery_source, 'local_fallback');
  assert.equal(localAssessment.recovery[0].candidate_count, 2, 'reference and unscoped text must not become leads');
  assert.equal(localAssessment.recovery[0].local_match_count, 1);
  assert.deepEqual(localAssessment.stages.C.evidence.map(item => item.source_id), ['src-003']);
  assert.deepEqual(calls, [['C', 'evidence_gap_analysis'], ['C', 'forensic_audit'], ['C', 'evidence_check']]);
  plannerTerm = 'spending outlook';
}

const distantText = 'Routine notes. '.repeat(24);
const repeatedMatches = [
  `Our Azure team recorded the forecast. ${distantText}The forecast is a spending outlook.`,
  `Our Azure team recorded a spending outlook. ${distantText}The spending outlook is our forecast.`,
  `Our Azure team recorded the forecast. ${distantText}The spending outlook is provisional. ${distantText}The forecast is a spending outlook.`,
  `Our Azure team recorded the forecast. ${distantText}The spending outlook is provisional. ${distantText}The forecast was recorded.`,
].map((text, index) => ({ ...sources[0], source_id: `src-00${index + 6}`, text }));
calls.length = 0;
const repeatedRecovery = await dispatch(repeatedMatches);
assert.equal(repeatedRecovery.initialPackets.C.included_chunk_count, 0);
assert.deepEqual(repeatedRecovery.stages.C.evidence.map(item => item.source_id), ['src-006', 'src-007', 'src-008']);
assert.deepEqual(calls, [['C', 'evidence_gap_analysis'], ['C', 'forensic_audit'], ['C', 'evidence_check']]);

calls.length = 0;
plannerUnavailable = true;
const fallback = await dispatch(recoveryInputs);
assert.equal(fallback.recovery[0].outcome, 'PLANNER_UNAVAILABLE');
assert.deepEqual(calls, [['C', 'evidence_gap_analysis']]);
assert.equal(fallback.phase.evidence_check.skipped_count, 60);
plannerUnavailable = false;

{
  // Deterministic 4xx governance rejections (e.g. RESIDUAL_CLASSIFICATION_REJECTED) and
  // post-fence OUTCOME_UNKNOWN errors must not burn a second batch retry attempt.
  const prevModel = globalThis.dispatchTestModel;
  let forensicAttempts = 0;
  globalThis.dispatchTestModel = async (stage) => {
    if (stage === 'forensic_audit') {
      forensicAttempts++;
      throw new MockStageExecutionError('RESIDUAL_CLASSIFICATION_REJECTED', false);
    }
    throw new Error(`Unexpected stage ${stage}`);
  };
  try {
    const records = engine.sanitizeEvidenceSources([...sources, billing]).sources;
    const registry = engine.buildSourceRegistry(records);
    const derived = engine.deriveAllEvidenceSignals(records, registry).evidence;
    const packets = engine.buildDomainPackets(registry);
    const integrity = engine.validateEvidenceAcquisition(records, registry, packets);
    const status = engine.sourceRegistryRuntimeStatus(registry, packets, 0, engine.scanRegistryDlp(registry), privacy, integrity);
    const stages = engine.buildEvidenceLaneStagePackets({
      source_packets: packets,
      source_packet_hashes: integrity.packet_hashes,
      derived_evidence: derived,
      acquisition_limitations: registry.acquisition_limitations,
      privacy_decision: privacy,
      acquisition_readiness: status.acquisition_readiness,
    });
    const failedPhase = await engine.runPhase1Audit(() => {}, { runId: 'non-retryable-test' }, { packets: stages });
    assert.equal(forensicAttempts, 1, 'deterministic governance rejection must not execute a second batch attempt');
    assert.deepEqual(failedPhase.failed_batches, ['A']);
    assert.match(failedPhase.evidence_check.failure_reason, /RESIDUAL_CLASSIFICATION_REJECTED/);
  } finally {
    globalThis.dispatchTestModel = prevModel;
  }
}

// Optional replay of the supplied files, without adding their content to Git.
if (process.env.FINOPS_CLEAR_BLOCK_REPLAY_DIR) {
  const folder = process.env.FINOPS_CLEAR_BLOCK_REPLAY_DIR;
  const file = 'Systems-Thinking-and-the-Cynefin-Framework-Final.3(1).pdf';
  const pages = execFileSync('pdftotext', [join(folder, file), '-'], { encoding: 'utf8' }).split('\f')
    .flatMap((text, index) => text.trim() ? [{ schema_version: 'source_page_v1', page_id: `p${index + 1}`, page_number: index + 1, text }] : []);
  const records = [{ schema_version: 'source_record_v1', source_id: 'src-001', source_name: file, kind: 'pdf', pages }];
  for (const [index, filename] of ['02-optimization-backlog(1).csv', '01-cost-line-items(1).csv'].entries()) {
    const table = engine.renderDelimitedTableForAnalysis(await readFile(join(folder, filename), 'utf8'), { fileName: filename, delimiter: ',' });
    records.push({ ...billing, source_id: `src-00${index + 2}`, source_name: filename, text: table.text, structured_table: table.structuredTable,
      extraction: { ...billing.extraction, total_units: table.rowCount, processed_units: table.rowCount } });
  }
  calls.length = 0;
  const replay = await dispatch(records);
  assert.deepEqual(calls.sort(), [['A', 'evidence_check'], ['A', 'forensic_audit'], ['B', 'evidence_check'], ['B', 'forensic_audit']]);
  assert.equal(replay.stages.A.evidence.length, 5);
  assert.equal(replay.stages.B.evidence.length, 6);
  assert.equal(replay.phase.evidence_check.skipped_count, 40);
  assert.ok(Object.values(replay.stages).every(packet => packet.evidence.every(item => item.source_id !== 'src-001')));
  console.log('Clear BLOCK replay retained 11 CSV chunks and skipped 40 criteria. Cynefin placements: 0.');
}
console.log('Domain dispatch and acquisition gap recovery tests passed');
