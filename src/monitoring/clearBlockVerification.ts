import { analyzeDocument } from '../services/analysisService';
import { parseEvidenceFile, toEvidenceSourceRecords, type ParsedEvidenceFile } from '../services/evidenceIntakeService';
import { generateSummaryReportHtml } from '../services/exportService';
import { buildReportViewModel } from '../services/reportViewModel';
import { acknowledgeRun, getRun } from '../services/runLifecycleService';

const endpoint = '/api/golden-standard-clear-block';

interface FrozenInput { name: string; bytes: number; sha256: string }
interface Comparison {
  status: 'Review';
  referenceVersion: string;
  checks: Array<{ label: string; expected: string | number | boolean; observed: string | number | boolean; matches: boolean }>;
}
export interface ClearBlockResult {
  comparison?: Comparison;
  summary: string;
  runId: string;
  completedAt: string;
  cleanupVerified: boolean;
}
export interface ClearBlockSession {
  runId?: string;
  result?: ClearBlockResult;
}

function totalCents(file: ParsedEvidenceFile, column: string) {
  const table = file.structuredTable;
  const field = table?.headers.indexOf(column) ?? -1;
  const rows = table?.analysis_rows;
  if (!table?.analysis_complete || !rows || field < 0) throw new Error('GOLDEN_STANDARD_INTEGRITY');
  const cents = rows.reduce((sum, row) => {
    const value = row[field];
    if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    const [units, fractional = ''] = value.split('.');
    return sum + Number(units) * 100 + Number(fractional.padEnd(2, '0'));
  }, 0);
  if (!Number.isSafeInteger(cents)) throw new Error('GOLDEN_STANDARD_INTEGRITY');
  return { rows: rows.length, cents };
}

async function caseRequest(path = '', init?: RequestInit) {
  const response = await fetch(endpoint + path, { cache: 'no-store', signal: AbortSignal.timeout(30_000), ...init });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error === 'GOLDEN_STANDARD_INTEGRITY' ? 'GOLDEN_STANDARD_INTEGRITY' : 'GOLDEN_STANDARD_UNAVAILABLE');
  }
  return response;
}

export async function verifyClearBlock(
  deepMode: boolean,
  onRunStarted: (runId: string) => void,
  onDelivery: (result: ClearBlockResult) => void,
): Promise<ClearBlockResult> {
  const { files }: { files: FrozenInput[] } = await (await caseRequest()).json();
  if (files.length !== 3) throw new Error('GOLDEN_STANDARD_INTEGRITY');
  const parsed = await Promise.all(files.map(async (file, index) => {
    const data = await (await caseRequest(`?input=${index}`)).arrayBuffer();
    const type = index === 2 ? 'application/pdf' : 'text/csv';
    if (data.byteLength !== file.bytes) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    const source = await parseEvidenceFile(new File([data], file.name, { type }));
    if (source.acquisition?.original_sha256 !== `sha256_${file.sha256}`) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    return source;
  }));

  const billed = totalCents(parsed[0], 'BilledCost');
  const backlog = totalCents(parsed[1], 'EstimatedSavingsEUR');
  const sources = toEvidenceSourceRecords(parsed);
  const result = await analyzeDocument(sources, () => {}, { deepMode, onRunStarted });
  const runId = result.meta.run_id;
  if (!runId) throw new Error('GOLDEN_STANDARD_RUN_INCOMPLETE');
  const summary = generateSummaryReportHtml(result);
  const report = buildReportViewModel(result);
  const rendered = new DOMParser().parseFromString(summary, 'text/html');
  const trace = result.meta.run_trace;
  const excludedId = sources[2].source_id;
  const excludedChunkIds = new Set(trace?.input_manifest.find(entry => entry.source_id === excludedId)?.chunk_ids);
  const observation = {
    evidenceSufficiency: report.sufficiency.decision,
    qualityGate: report.actionability.gate,
    planningDecision: report.actionability.planningDecision.replace(/_/g, ' '),
    loadedInputsInTrace: sources.every(source => trace?.input_manifest.some(entry =>
      entry.source_id === source.source_id && entry.source_hash === source.acquisition?.original_sha256)),
    excludedDocument: !!trace?.input_manifest.some(entry => entry.source_id === excludedId)
      && trace.context_packets.length === 6
      && trace.context_packets.every(packet => packet.manifest.every(item => item.source_id !== excludedId))
      && trace.evidence_paths.every(path => path.source_id !== excludedId
        && (!path.chunk_id || !excludedChunkIds.has(path.chunk_id))),
    directiveRoadmapWithheld: !!rendered.querySelector('.withheld-card, .findings-mode') && !rendered.querySelector('.summary-roadmap-phase'),
    maturityClassificationWithheld: Array.from(rendered.querySelectorAll('.hero .pill'))
      .some(pill => /^(?:Observed maturity band )?Insufficient evidence$/i.test(pill.textContent?.trim() ?? '')),
    billingRows: billed.rows, billingCents: billed.cents,
    backlogRows: backlog.rows, backlogCents: backlog.cents,
  };
  const comparison = await caseRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(observation) })
    .then(response => response.json() as Promise<Comparison>).catch(() => undefined);
  const delivered = { comparison, summary, runId, completedAt: new Date().toISOString(), cleanupVerified: false };
  onDelivery(delivered);
  return { ...delivered, cleanupVerified: await verifyClearBlockCleanup(runId) };
}

export async function verifyClearBlockCleanup(runId: string): Promise<boolean> {
  const current = await getRun(runId).catch(() => null);
  if (current?.cleanup_status === 'verified') return true;
  if (current?.state === 'ready_for_delivery' || current?.state === 'completed') {
    const acknowledged = await acknowledgeRun(runId).catch(() => null);
    return acknowledged?.cleanup_status === 'verified';
  }
  return false;
}
