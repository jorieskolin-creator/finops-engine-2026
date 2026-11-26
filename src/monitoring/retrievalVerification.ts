import { acquireEvidence } from '../services/evidenceAcquisitionService';
import { PipelineIntegrityError } from '../services/pipelineIntegrityService';
import { clearStageTraces } from '../services/runTraceService';
import { createRetrievalRun, finishRetrievalRun, type RetrievalUsage } from '../services/runLifecycleService';
import { loadRetrievalFixture } from './retrievalFixture';
import { compareRetrievalReference, retrievalReference } from './retrievalReference';

type Checks = ReturnType<typeof compareRetrievalReference>;
export interface RetrievalVerificationResult {
  status: 'Pass' | 'Fail' | 'Review' | 'Incomplete';
  reason: 'Verified' | 'Fixture needs review' | 'Deterministic check failed' | 'AI Gap Analyzer unverified'
    | 'AI recovery failed' | 'Acquisition did not complete' | 'Cleanup unverified';
  durationMs: number;
  checks?: Checks;
  model?: string;
  usage?: RetrievalUsage;
}

type Evaluation = Omit<RetrievalVerificationResult, 'durationMs' | 'usage'>;

function evaluate(acquisition: Awaited<ReturnType<typeof acquireEvidence>>): Evaluation {
  const checks = compareRetrievalReference({
    sources: acquisition.acquiredSources,
    baselinePackets: acquisition.baselineSourcePackets,
    finalPackets: acquisition.sourcePackets,
    registry: acquisition.sourceRegistry,
  });
  const expected = retrievalReference.recovery;
  const gap = acquisition.acquisitionGap.passes.find(pass =>
    pass.domain_id === expected.domain && pass.criterion_ids.includes(expected.criterion),
  );
  if (!checks.fixtureHashes || !checks.gapPresentOnFirstPass) return { status: 'Review', reason: 'Fixture needs review', checks };
  if (!checks.directEvidence || !checks.calculation || !checks.irrelevantEvidenceExcluded
    || acquisition.sourceRegistryStatus.acquisition_readiness.status === 'BLOCKED') {
    return { status: 'Fail', reason: 'Deterministic check failed', checks };
  }
  if (!gap?.model_used) return { status: 'Incomplete', reason: 'AI Gap Analyzer unverified', checks };

  const recoveredByModel = gap.selected_chunk_ids.some(id =>
    acquisition.sourceRegistry.chunks.some(chunk => chunk.chunk_id === id && chunk.source_id === expected.sourceId),
  );
  return checks.recoveredEvidence && recoveredByModel
    ? { status: 'Pass', reason: 'Verified', checks, model: gap.model_used }
    : { status: 'Fail', reason: 'AI recovery failed', checks, model: gap.model_used };
}

async function verify(openingId: string): Promise<RetrievalVerificationResult> {
  const started = performance.now();
  const result = (evaluation: Evaluation, usage?: RetrievalUsage): RetrievalVerificationResult =>
    ({ ...evaluation, durationMs: Math.round(performance.now() - started), usage });
  let run;
  try {
    run = await createRetrievalRun(openingId).catch(() => createRetrievalRun(openingId));
  } catch {
    return result({ status: 'Incomplete', reason: 'Acquisition did not complete' });
  }
  if (run.state !== 'active' || !run.absolute_deadline_at) {
    return result({ status: 'Incomplete', reason: 'Acquisition did not complete' });
  }

  let evaluation: Evaluation;
  try {
    const signal = AbortSignal.timeout(Math.max(0, Date.parse(run.absolute_deadline_at) - Date.now()));
    const sources = await loadRetrievalFixture();
    evaluation = evaluate(await acquireEvidence(sources, { runId: run.run_id, retrievalSignal: signal }));
  } catch (error) {
    if (error instanceof PipelineIntegrityError) evaluation = { status: 'Fail', reason: 'Deterministic check failed' };
    else if (error instanceof Error && error.message === 'GOLDEN_STANDARD_FIXTURE_MISMATCH') {
      evaluation = { status: 'Review', reason: 'Fixture needs review' };
    } else evaluation = { status: 'Incomplete', reason: 'Acquisition did not complete' };
  } finally {
    clearStageTraces(run.run_id);
  }

  let finished = await finishRetrievalRun(run.run_id).catch(() => null);
  if (finished?.cleanup_status !== 'verified') finished = await finishRetrievalRun(run.run_id).catch(() => null);
  if (finished?.cleanup_status !== 'verified') {
    return result(evaluation.status === 'Fail' ? evaluation : { ...evaluation, status: 'Incomplete', reason: 'Cleanup unverified' });
  }
  if (finished.state !== 'completed' && evaluation.status === 'Pass') {
    return result({ ...evaluation, status: 'Incomplete', reason: 'Acquisition did not complete' }, finished.retrieval_usage);
  }
  return result(evaluation, finished.retrieval_usage);
}

const activeChecks = new Map<string, Promise<RetrievalVerificationResult>>();

export function runRetrievalVerification(openingId: string): Promise<RetrievalVerificationResult> {
  const active = activeChecks.get(openingId);
  if (active) return active;
  const verification = verify(openingId).finally(() => activeChecks.delete(openingId));
  activeChecks.set(openingId, verification);
  return verification;
}
