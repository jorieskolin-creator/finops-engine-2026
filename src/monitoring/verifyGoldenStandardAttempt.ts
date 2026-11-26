import { analyzeDocument } from '../services/analysisService';
import { mimeTypeForEvidenceFileName, parseEvidenceFile, toEvidenceSourceRecords, type ParsedEvidenceFile } from '../services/evidenceIntakeService';
import { numericObservations } from './goldenStandardCalculations';
import {
  buildDurableSummary,
  buildMonitoringObservation,
  collectAdmittedSourceIds,
  collectAdmittedSourcesByDomain,
  findTableWithColumn,
  isDistractorFileName,
  prepareReport,
  totalCents,
} from './clearBlockVerification';
import {
  digest,
  GoldenStandardClientError,
  suiteCommand,
  type AttemptFailure,
  type CaseId,
  type Suite,
  type SuiteAttempt,
  type SuiteDelivery,
  type SuiteReport,
} from './goldenStandardSuite';

type FrozenInput = { name: string; bytes: number; sha256: string };
const emptyAmount = { rows: 0, cents: 0 };
const pendingFinishStorageKey = 'finops:golden-standard:pending-finish:v1';

export class GoldenStandardAttemptError extends Error {
  constructor(
    public readonly stage: AttemptFailure['stage'],
    public readonly code: string,
    public readonly timedOut: boolean = false,
  ) {
    super(code);
  }
}

const isTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

const safeStageCode = (error: unknown, fallback: string): string => {
  if (error instanceof GoldenStandardClientError && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.reason)) {
    return error.reason;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const matched = message.match(/\b([A-Z][A-Z0-9_]{2,63})\b/)?.[1];
  return matched ?? fallback;
};

function savePendingDelivery(runId: string, entry: unknown) {
  try {
    const current = JSON.parse(sessionStorage.getItem(pendingFinishStorageKey) ?? '{}');
    current[runId] = entry;
    const keys = Object.keys(current);
    while (keys.length > 5) delete current[keys.shift()!];
    sessionStorage.setItem(pendingFinishStorageKey, JSON.stringify(current));
  } catch {
    // Ignore browser sessionStorage quota errors; durable summary is also sent to PostgreSQL.
  }
}

function clearPendingDelivery(runId: string) {
  try {
    const current = JSON.parse(sessionStorage.getItem(pendingFinishStorageKey) ?? '{}');
    delete current[runId];
    sessionStorage.setItem(pendingFinishStorageKey, JSON.stringify(current));
  } catch {
    // Ignore storage cleanup errors.
  }
}

export async function flushPendingGoldenStandardDeliveries(): Promise<void> {
  let pending: Record<string, { suiteId: string; finishBody: Record<string, unknown> }>;
  try {
    pending = JSON.parse(sessionStorage.getItem(pendingFinishStorageKey) ?? '{}');
  } catch {
    return;
  }
  for (const [runId, entry] of Object.entries(pending)) {
    if (!entry?.suiteId || !entry?.finishBody) {
      clearPendingDelivery(runId);
      continue;
    }
    try {
      await suiteCommand<SuiteDelivery>('finish', entry.suiteId, entry.finishBody);
      clearPendingDelivery(runId);
    } catch (error) {
      if (error instanceof GoldenStandardClientError && error.httpStatus && [400, 404, 409].includes(error.httpStatus)) {
        clearPendingDelivery(runId);
      }
    }
  }
}

async function inputRequest(caseId: CaseId, input: number | undefined, signal: AbortSignal) {
  const query = new URLSearchParams({ caseId });
  if (input !== undefined) query.set('input', String(input));
  let response: Response;
  try {
    response = await fetch('/api/golden-standard-suite?' + query, { cache: 'no-store', signal });
  } catch (error) {
    if (signal.aborted && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    throw new GoldenStandardAttemptError('input_download', 'GOLDEN_STANDARD_FETCH_TIMEOUT', true);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const reason = typeof body?.reason === 'string'
      ? body.reason
      : typeof body?.error === 'string' ? body.error : 'GOLDEN_STANDARD_INPUT_UNAVAILABLE';
    throw new GoldenStandardAttemptError('input_download', reason, false);
  }
  return response;
}

export async function verifyGoldenStandardAttempt(suite: Suite, attempt: SuiteAttempt, signal: AbortSignal) {
  const runId = attempt.run_id;
  if (!runId) throw new GoldenStandardAttemptError('input_download', 'GOLDEN_STANDARD_RUN_INCOMPLETE', false);
  const caseId = attempt.case_id;
  const inputSignal = () => AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const metadata = await inputRequest(caseId, undefined, inputSignal());
  const { files }: { files: FrozenInput[] } = await metadata.json();
  const parsed: ParsedEvidenceFile[] = [];
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    const data = await (await inputRequest(caseId, index, inputSignal())).arrayBuffer();
    if (data.byteLength !== file.bytes) {
      throw new GoldenStandardAttemptError('input_parse', 'GOLDEN_STANDARD_INTEGRITY', false);
    }
    let source: ParsedEvidenceFile;
    try {
      const type = mimeTypeForEvidenceFileName(file.name);
      source = await parseEvidenceFile(new File([data], file.name, type ? { type } : undefined));
    } catch (error) {
      throw new GoldenStandardAttemptError('input_parse', safeStageCode(error, 'GOLDEN_STANDARD_PARSE_FAILED'), false);
    }
    if (source.acquisition?.original_sha256 !== `sha256_${file.sha256}`) {
      throw new GoldenStandardAttemptError('input_parse', 'GOLDEN_STANDARD_INTEGRITY', false);
    }
    parsed.push(source);
  }

  let billed = emptyAmount;
  let backlog = emptyAmount;
  if (caseId === 'clear-block') {
    try {
      billed = totalCents(findTableWithColumn(parsed, 'BilledCost') ?? parsed[0], 'BilledCost');
      backlog = totalCents(findTableWithColumn(parsed, 'EstimatedSavingsEUR') ?? parsed[1], 'EstimatedSavingsEUR');
    } catch (error) {
      throw new GoldenStandardAttemptError('input_parse', safeStageCode(error, 'GOLDEN_STANDARD_INTEGRITY'), false);
    }
  }

  const sources = toEvidenceSourceRecords(parsed);
  signal.throwIfAborted();
  let knowledge: [string, string] | undefined;
  let result;
  try {
    result = await analyzeDocument(sources, () => {}, {
      deepMode: suite.configuration.deepMode,
      goldenStandard: { runId, onKnowledgeLoaded: (indexHash, playbook) => { knowledge = [indexHash, playbook]; } },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const timedOut = isTimeoutError(error) || /\bTIMEOUT\b/i.test(error instanceof Error ? error.message : '');
    throw new GoldenStandardAttemptError('pipeline', safeStageCode(error, 'PIPELINE_FAILED'), timedOut);
  }
  signal.throwIfAborted();

  const distractorIndex = parsed.findIndex(file => isDistractorFileName(file.name));
  const excludedId = distractorIndex >= 0 ? sources[distractorIndex]?.source_id : undefined;
  const { observation, summary, narrative } = prepareReport(result, sources, excludedId);
  const monitoring = buildMonitoringObservation(result, sources, excludedId);
  const durableSummary = buildDurableSummary(result, narrative);
  const admittedSourceIds = collectAdmittedSourceIds(result);
  const admittedByDomain = collectAdmittedSourcesByDomain(result);
  const filesWithSourceIds = parsed.map((file, index) => ({
    name: file.name,
    text: file.text,
    sourceId: sources[index]?.source_id,
  }));
  const kbHash = knowledge ? await digest(knowledge) : null;
  const metrics = result.phase_2_validation.metrics;
  const finishBody = {
    ordinal: attempt.ordinal,
    runId,
    observation: {
      ...observation,
      billingRows: billed.rows,
      billingCents: billed.cents,
      backlogRows: backlog.rows,
      backlogCents: backlog.cents,
      numbers: numericObservations(caseId, filesWithSourceIds, admittedSourceIds, admittedByDomain),
      kbHash,
      assessed: (metrics.maturity_assessed_count ?? 0) + (metrics.antipattern_assessed_count ?? 0),
      monitoring,
    },
    summary: durableSummary,
  };

  // Persist the rendered report and finish payload locally before server finalization
  // and cleanup so a transient network drop cannot lose a completed assessment.
  const completedAt = new Date().toISOString();
  savePendingDelivery(runId, { suiteId: suite.suite_id, finishBody, completedAt });
  signal.throwIfAborted();

  let delivered: SuiteDelivery;
  try {
    delivered = await suiteCommand<SuiteDelivery>('finish', suite.suite_id, finishBody);
  } catch (firstError) {
    if (signal.aborted) throw firstError;
    try {
      delivered = await suiteCommand<SuiteDelivery>('finish', suite.suite_id, finishBody);
    } catch (secondError) {
      throw new GoldenStandardAttemptError(
        'delivery',
        safeStageCode(secondError, 'GOLDEN_STANDARD_DELIVERY_FAILED'),
        isTimeoutError(secondError),
      );
    }
  }
  clearPendingDelivery(runId);
  const { headline, bottleneck, planningRationale, keyMetrics } = durableSummary;
  const report: SuiteReport = {
    comparison: delivered.comparison,
    summary,
    narrative,
    shortSummary: { headline, bottleneck, planningRationale, keyMetrics },
    completedAt,
  };
  return { updated: delivered.suite, report };
}
