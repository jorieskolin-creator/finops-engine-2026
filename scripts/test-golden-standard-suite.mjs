import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { issueCookie } from '../lib/auth.js';
import { cases } from '../lib/goldenStandardCases.js';
import { goldenStandardSuiteHandler } from '../api/golden-standard-suite.js';

process.env.SECRET_KEY = 'disposable-golden-standard-suite-test';
const cookie = issueCookie().split(';')[0];
const caseId = 'clear-go';
const suiteId = randomUUID();
const runId = randomUUID();
const recorded = [];
const routing = { label: 'Test routing', roles: { WORKHORSE: { profiles: [{ provider: 'stub', id: 'model' }] } } };
const card = {
  reference_version: 'v1', status: 'review',
  proposed_decisions: { evidence_sufficiency: null, quality_gate: null, planning_decision: null, intended_calibration_gate: 'GO' },
  facts: [
    { id: 'sampled-terraform-control', file: 'terraform.html', locator: 'Sample only', expected_meaning: 'Private card expectation.',
      summary_expectation: 'Sample scope.', local_numeric_expectation: { approved_monthly: '240' } },
    { id: 'scoped-ai-unit-cost', local_numeric_expectation: { total: '80', per_completed_task: '0.008' } },
    { id: 'weekly-rightsizing', local_numeric_expectation: { delta: '82' } },
  ],
  diagnosis: ['Preserve the sample scope.'], allowed_roadmap: ['Validate recurrence.'], forbidden: ['Invent an unconditional GO.'],
};
let active;
const store = {
  async start(id, configuration, selected, repetitions) {
    recorded.push({ id, selected, repetitions });
    active = { suite_id: id, configuration, attempts: [{ case_id: caseId, ordinal: 0, run_id: runId }] };
    return true;
  },
  async read(id) { return active?.suite_id === id ? active : null; },
  async finish(id, ordinal, assignedRun, compact, summary) {
    assert.deepEqual([id, ordinal, assignedRun], [suiteId, 0, runId]);
    active.attempts[0].comparison = compact;
    active.attempts[0].summary = summary;
    active.attempts[0].state = 'delivered';
    return true;
  },
  async fail(id, ordinal, assignedRun, failure) {
    assert.deepEqual([id, ordinal, assignedRun], [suiteId, 0, runId]);
    active.attempts[0].state = 'incomplete';
    active.attempts[0].failure = failure;
    return { recorded: true, cleanupRunIds: [runId] };
  },
  async cancel() { return [runId]; },
  async review(id, ordinal, assignedRun, sha256) {
    return id === suiteId && ordinal === 0 && assignedRun === runId && sha256 === cases[caseId].reference.sha256;
  },
};
const handler = goldenStandardSuiteHandler({
  store,
  lifecycle: { async transition(id, target) { recorded.push({ id, target }); } },
  readRouting: () => routing,
  readBuild: () => null,
  loadCase: () => ({
    async loadReference() { return card; },
    async loadInputs() { return [{ path: 'inputs/clear-go/01.csv', bytes: 2, sha256: 'fixture-hash' }]; },
  }),
});
async function request(method, body, { query = {}, authorized = true } = {}) {
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
    setHeader(key, value) { assert.deepEqual([key, value], ['Cache-Control', 'private, no-store']); },
  };
  await handler({ method, body, headers: authorized ? { cookie } : {}, query }, res);
  return res;
}
const start = { action: 'start', suiteId, selection: 'all', repetitions: 3, deepMode: false, build: null,
  routingHash: createHash('sha256').update(JSON.stringify(routing)).digest('hex') };
assert.equal((await request('POST', start, { authorized: false })).statusCode, 401);
assert.equal((await request('POST', { ...start, repetitions: 2 })).statusCode, 400);
assert.equal((await request('POST', { ...start, routingHash: '0'.repeat(64) })).statusCode, 409);
assert.equal((await request('POST', start)).statusCode, 201);
assert.deepEqual(recorded[0].selected, Object.keys(cases));
assert.equal(recorded[0].repetitions, 3);
assert.equal((await request('GET', null, { query: { caseId, input: '../reference' } })).statusCode, 400);
const metadata = await request('GET', null, { query: { caseId } });
assert.ok(metadata.body.files.length);
assert.doesNotMatch(JSON.stringify(metadata.body), /Private card expectation/);
const observation = {
  evidenceSufficiency: 'PASS', qualityGate: 'WARN', planningDecision: 'CONDITIONAL GO',
  loadedInputsInTrace: true, excludedDocument: true, directiveRoadmapWithheld: false, maturityClassificationWithheld: false,
  billingRows: 0, billingCents: 0, backlogRows: 0, backlogCents: 0,
  assessed: 31, kbHash: 'a'.repeat(64), numbers: [240, 80, 0.008, 82],
  monitoring: {
    crawlWalkRun: 'Walk',
    corroboratedMaturity: 58.5,
    observedMaturity: 64.2,
    adjustedMaturity: 51.4,
    assessmentResolution: 64,
    criterionEvidenceDensity: 51.7,
    antipatternBurden: 22.5,
    assessedCriteria: ['maturity.A1', 'antipattern.B2'],
    admittedCustomerSources: 3,
    expectedCustomerSources: 3,
    factCheck: {
      totalClaims: 18,
      supportedClaims: 17,
      unsupportedClaims: 1,
      sanitizedClaims: 1,
      byCategory: { evidence: 1, inference: 0, scope: 0, other: 0 },
    },
  },
};
const summary = {
  headline: 'Scoped FinOps practices are documented, with open AI coverage limits.',
  bottleneck: 'Shared AI attribution outside the sampled workflow remains open.',
  planningRationale: 'Proceed conditionally on evidenced controls while verifying recurrence.',
  keyMetrics: ['31/60 criteria assessed', 'EUR 0.008 per completed task on sampled AI workflow'],
  narrative: {
    diagnosis: ['Sampled controls are documented for the reviewed scope.'],
    planning: ['Validate recurrence before expanding commitments.'],
    masterData: ['Domain F: sampled workflow reconciled at EUR 80.00 across 10,000 tasks.'],
  },
};
const finish = { action: 'finish', suiteId, ordinal: 0, runId, observation, summary };
assert.equal((await request('POST', { ...finish, observation: { ...observation, summary: 'Private output' } })).statusCode, 400);
const delivered = await request('POST', finish);
assert.equal(delivered.statusCode, 200);
assert.deepEqual(delivered.body.comparison.checks.find(check => check.label === 'Quality Gate'),
  { label: 'Quality Gate', expected: null, observed: 'WARN', matches: null });
const compact = active.attempts[0].comparison;
assert.ok(compact);
assert.equal(compact.monitoring.adjustedMaturity, 51.4);
assert.equal(active.attempts[0].summary.headline, summary.headline);
assert.doesNotMatch(JSON.stringify(compact), /Private card expectation|terraform.html|Sample scope/);

// Failure recording transitions a running attempt to incomplete with stage + code and requests cleanup.
active.attempts[0].state = 'running';
const failRes = await request('POST', {
  action: 'fail',
  suiteId,
  ordinal: 0,
  runId,
  failure: { stage: 'input_download', code: 'GOLDEN_STANDARD_BLOB_NOT_FOUND', timedOut: false },
});
assert.equal(failRes.statusCode, 200);
assert.equal(active.attempts[0].failure.code, 'GOLDEN_STANDARD_BLOB_NOT_FOUND');
assert.deepEqual(recorded.at(-1), { id: runId, target: 'deletion_requested' });

// Server-side final_report checkpoint verification binds the comparison to pinned inputs and run outputs.
{
  let acknowledged = false;
  let runState = 'ready_for_delivery';
  let cleanupStatus = null;
  const verifiedSuiteId = randomUUID();
  const verifiedRunId = randomUUID();
  const checkpointPayload = JSON.stringify({
    result: {
      meta: {
        run_id: verifiedRunId,
        run_trace: { input_manifest: [{ source_hash: 'sha256_fixture-hash' }] },
      },
      phase_2_validation: {
        assessment_sufficiency: { decision: 'PASS' },
        metrics: { maturity_assessed_count: 20, antipattern_assessed_count: 11 },
      },
      phase_3_strategy: { planning_decision: { decision: 'CONDITIONAL_GO' } },
      quality_gate: { decision: 'WARN' },
    },
  });
  const payloadHash = createHash('sha256').update(checkpointPayload).digest('hex');
  const verifiedState = {
    suite_id: verifiedSuiteId,
    state: 'running',
    configuration: {
      packageVersion: '2026-11-26-v1',
      references: Object.fromEntries(Object.keys(cases).map(id => [id, cases[id].reference.sha256])),
    },
    attempts: [{ case_id: caseId, ordinal: 0, run_id: verifiedRunId, state: 'running', comparison: null }],
  };
  const verifiedHandler = goldenStandardSuiteHandler({
    store: {
      async read(id) { return id === verifiedSuiteId ? verifiedState : null; },
      async finish(_id, _ordinal, _runId, compact, storedSummary) {
        if (verifiedState.attempts[0].state === 'delivered') {
          return JSON.stringify(verifiedState.attempts[0].comparison) === JSON.stringify(compact);
        }
        verifiedState.attempts[0].comparison = compact;
        verifiedState.attempts[0].summary = storedSummary;
        verifiedState.attempts[0].state = 'delivered';
        return true;
      },
    },
    lifecycle: {
      async transition() {},
      async acknowledgeDelivery(id) {
        assert.equal(id, verifiedRunId);
        acknowledged = true;
        runState = 'completed';
        cleanupStatus = 'verified';
        return { run_id: id, state: runState, cleanup_status: cleanupStatus };
      },
    },
    repository: {
      async getRun(id) { return { run_id: id, state: runState, cleanup_status: cleanupStatus }; },
      async listCheckpoints() {
        return [{ checkpoint_id: 'cp-1', kind: 'final_report', state: 'available', payload_hash: payloadHash }];
      },
    },
    redis: {
      async getCheckpoint() { return checkpointPayload; },
    },
    readRouting: () => routing,
    readBuild: () => null,
    loadCase: () => ({
      async loadReference() { return card; },
      async loadInputs() { return [{ path: 'inputs/clear-go/01.csv', bytes: 2, sha256: 'fixture-hash' }]; },
    }),
  });
  const callVerified = async body => {
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; },
      setHeader() {},
    };
    await verifiedHandler({ method: 'POST', body, headers: { cookie }, query: {} }, res);
    return res;
  };
  const mismatchRes = await callVerified({
    action: 'finish',
    suiteId: verifiedSuiteId,
    ordinal: 0,
    runId: verifiedRunId,
    observation: { ...observation, qualityGate: 'GO' },
    summary,
  });
  assert.equal(mismatchRes.statusCode, 409);
  assert.equal(mismatchRes.body.reason, 'GOLDEN_STANDARD_OBSERVATION_MISMATCH');
  assert.equal(acknowledged, false);

  const okRes = await callVerified({
    action: 'finish',
    suiteId: verifiedSuiteId,
    ordinal: 0,
    runId: verifiedRunId,
    observation,
    summary,
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(acknowledged, true);
  assert.equal(verifiedState.attempts[0].comparison.serverVerified, true);

  // Idempotent retry after acknowledgeDelivery + cleanup must still return 200 with identical comparison.
  const retryRes = await callVerified({
    action: 'finish',
    suiteId: verifiedSuiteId,
    ordinal: 0,
    runId: verifiedRunId,
    observation,
    summary,
  });
  assert.equal(retryRes.statusCode, 200);
}
assert.equal((await request('POST', { action: 'review', suiteId, ordinal: 0, runId,
  referenceSha256: compact.referenceSha256, dispositions: { 'weekly-rightsizing': 'Supported' } })).statusCode, 400);
assert.equal((await request('POST', { action: 'cancel', suiteId })).statusCode, 200);
assert.deepEqual(recorded.at(-1), { id: runId, target: 'deletion_requested' });

async function loadTypescript(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { numericObservations } = await loadTypescript('../src/monitoring/goldenStandardCalculations.ts');
assert.deepEqual(numericObservations('near-block-conditional-go', [
  { name: '05-budget.html', text: 'EUR 145,000 approved to EUR 146,200 forecast' },
  { name: '04-optimization.html', text: 'ENT-RI-00032 was underused at 36.3%. EUR 82 observed lower run cost' },
]), [1200, 82, 36.3]);
assert.deepEqual(numericObservations(caseId, [
  { name: '06-optimization.html', text: 'posted workload costs of EUR 410 and EUR 328', sourceId: 'src-001' },
  { name: '08-terraform.html', text: 'revised plan at EUR 240', sourceId: 'src-002' },
  { name: '09-ai.html', text: 'EUR 61.76 billed inference. EUR 11.60 billed inference. Shared overhead of EUR 6.64. EUR 80.00 divided by 10,000 completed tasks.', sourceId: 'src-003' },
], new Set(['src-001', 'src-002', 'src-003']), {
  B: new Set(['src-001']),
  D: new Set(['src-002']),
  A: new Set(['src-003']), // Admitted only to A, missing from expected Domain F!
}), [240, null, null, 82], 'sources missing from their target domain packet must not satisfy domain-scoped numeric checks');

const { attemptStatus, caseIds, repeatability, suiteStatus, summarizeMonitoringDashboard } = await loadTypescript('../src/monitoring/goldenStandardSuite.ts');
const passed = {
  state: 'completed', configuration: { build: 'a', routingHash: 'b', deepMode: false, packageVersion: 'v1' },
  attempts: caseIds.map(case_id => ({
    case_id, state: 'delivered', comparison: { referenceApproved: true, referenceSha256: case_id, kbHash: 'kb',
      assessed: 21,
      expectedDecisions: { evidenceSufficiency: 'PASS', qualityGate: 'WARN', planningDecision: 'CONDITIONAL GO' },
      observedDecisions: { evidenceSufficiency: 'PASS', qualityGate: 'WARN', planningDecision: 'CONDITIONAL GO', crawlWalkRun: 'Walk' },
      falseGoOnExpectedBlock: false,
      checks: [{ label: 'Quality Gate', expected: 'WARN', observed: 'WARN', matches: true }],
      checkIds: ['diagnosis'], usage: { models: ['primary'] } },
    review: { dispositions: { diagnosis: 'Supported' } },
  })),
};
assert.equal(suiteStatus(passed), 'Pass');
const singleCaseApproved = {
  ...passed,
  attempts: [passed.attempts[0]],
};
assert.equal(attemptStatus(singleCaseApproved.attempts[0]), 'Pass');
assert.equal(suiteStatus(singleCaseApproved), 'Review', 'a single approved case must not grant overall five-case suite Pass');
const dashboard = summarizeMonitoringDashboard(passed);
assert.deepEqual(dashboard.gateAccuracy, { matched: 5, evaluable: 5, delivered: 5 });
assert.deepEqual(dashboard.safetyCritical, { falseGoCount: 0, expectedBlockCount: 0 });
assert.deepEqual(dashboard.operations, { completed: 5, timedOut: 0, failed: 0, skipped: 0, total: 5 });
const pending = structuredClone(passed);
pending.attempts[0].comparison.referenceApproved = false;
assert.equal(suiteStatus(pending), 'Review');
const cancelled = structuredClone(passed);
cancelled.state = 'cancelled';
cancelled.attempts[0].state = 'incomplete';
assert.equal(suiteStatus(cancelled), 'Incomplete');
cancelled.attempts[1].comparison.checks[0].matches = false;
assert.equal(suiteStatus(cancelled), 'Fail');
const changedModels = structuredClone(passed);
changedModels.attempts[0].comparison.usage.models = ['fallback'];
const changedKnowledge = structuredClone(passed);
changedKnowledge.attempts[0].comparison.kbHash = 'other KB';
assert.deepEqual(repeatability([passed, changedModels, changedKnowledge], passed, passed.attempts[0]), { total: 1, matched: 1 });
console.log('Golden Standard suite comparison, privacy, cancellation and repeatability tests passed.');
