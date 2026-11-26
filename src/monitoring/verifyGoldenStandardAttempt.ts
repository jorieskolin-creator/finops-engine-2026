import { analyzeDocument } from '../services/analysisService';
import { parseEvidenceFile, toEvidenceSourceRecords, type ParsedEvidenceFile } from '../services/evidenceIntakeService';
import { numericObservations } from './goldenStandardCalculations';
import { prepareReport, totalCents, verifyClearBlockCleanup } from './clearBlockVerification';
import { digest, suiteCommand, type CaseId, type Suite, type SuiteAttempt, type SuiteDelivery, type SuiteReport } from './goldenStandardSuite';

type FrozenInput = { name: string; bytes: number; sha256: string };
const emptyAmount = { rows: 0, cents: 0 };

async function inputRequest(caseId: CaseId, input: number | undefined, signal: AbortSignal) {
  const query = new URLSearchParams({ caseId });
  if (input !== undefined) query.set('input', String(input));
  const response = await fetch('/api/golden-standard-suite?' + query, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('GOLDEN_STANDARD_INPUT_UNAVAILABLE');
  return response;
}

export async function verifyGoldenStandardAttempt(suite: Suite, attempt: SuiteAttempt, signal: AbortSignal) {
  const runId = attempt.run_id;
  if (!runId) throw new Error('GOLDEN_STANDARD_RUN_INCOMPLETE');
  const caseId = attempt.case_id;
  const inputSignal = () => AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const metadata = await inputRequest(caseId, undefined, inputSignal());
  const { files }: { files: FrozenInput[] } = await metadata.json();
  const parsed: ParsedEvidenceFile[] = [];
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    const data = await (await inputRequest(caseId, index, inputSignal())).arrayBuffer();
    if (data.byteLength !== file.bytes) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    const type = file.name.endsWith('.pdf') ? 'application/pdf' : file.name.endsWith('.csv') ? 'text/csv' : 'text/html';
    const source = await parseEvidenceFile(new File([data], file.name, { type }));
    if (source.acquisition?.original_sha256 !== `sha256_${file.sha256}`) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    parsed.push(source);
  }

  const billed = caseId === 'clear-block' ? totalCents(parsed[0], 'BilledCost') : emptyAmount;
  const backlog = caseId === 'clear-block' ? totalCents(parsed[1], 'EstimatedSavingsEUR') : emptyAmount;
  const sources = toEvidenceSourceRecords(parsed);
  signal.throwIfAborted();
  let knowledge: [string, string] | undefined;
  const result = await analyzeDocument(sources, () => {}, {
    deepMode: suite.configuration.deepMode,
    goldenStandard: { runId, onKnowledgeLoaded: (indexHash, playbook) => { knowledge = [indexHash, playbook]; } },
  });
  signal.throwIfAborted();
  const distractor = parsed.findIndex(file => file.name === 'Systems-Thinking-and-the-Cynefin-Framework-Final.3.pdf');
  const { observation, summary, narrative } = prepareReport(result, sources, sources[distractor]?.source_id);
  const kbHash = knowledge ? await digest(knowledge) : null;
  const metrics = result.phase_2_validation.metrics;
  if (!await verifyClearBlockCleanup(runId)) throw new Error('GOLDEN_STANDARD_CLEANUP_PENDING');
  signal.throwIfAborted();
  const { comparison, suite: updated } = await suiteCommand<SuiteDelivery>('finish', suite.suite_id, {
    ordinal: attempt.ordinal, runId,
    observation: {
      ...observation,
      billingRows: billed.rows, billingCents: billed.cents,
      backlogRows: backlog.rows, backlogCents: backlog.cents,
      numbers: numericObservations(caseId, parsed), kbHash,
      assessed: (metrics.maturity_assessed_count ?? 0) + (metrics.antipattern_assessed_count ?? 0),
    },
  });
  const report: SuiteReport = { comparison, summary, narrative, completedAt: new Date().toISOString() };
  return { updated, report };
}
