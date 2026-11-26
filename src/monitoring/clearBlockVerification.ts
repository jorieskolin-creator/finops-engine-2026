import { analyzeDocument } from '../services/analysisService';
import { mimeTypeForEvidenceFileName, parseEvidenceFile, toEvidenceSourceRecords, type ParsedEvidenceFile } from '../services/evidenceIntakeService';
import { generateReportHtml, generateSummaryReportHtml } from '../services/exportService';
import type { DiagnosticResult, SourceRecord } from '../types';
import { buildReportViewModel } from '../services/reportViewModel';
import { acknowledgeRun, getRun } from '../services/runLifecycleService';
import { collectRenderedNarrative, type Comparison, type NarrativeReview, type RenderedNarrative } from './clearBlockNarrativeReview';

const endpoint = '/api/golden-standard-clear-block';

interface FrozenInput { name: string; bytes: number; sha256: string }
export interface ClearBlockResult {
  comparison?: Comparison;
  narrative?: RenderedNarrative;
  review?: NarrativeReview;
  summary: string;
  runId: string;
  completedAt: string;
  cleanupVerified: boolean;
}
export interface ClearBlockSession {
  runId?: string;
  result?: ClearBlockResult;
}

export interface MonitoringObservation {
  crawlWalkRun: DiagnosticResult['phase_2_validation']['crawl_walk_run'];
  corroboratedMaturity: number | null;
  observedMaturity: number | null;
  adjustedMaturity: number | null;
  assessmentResolution: number;
  criterionEvidenceDensity: number;
  antipatternBurden: number;
  assessedCriteria: string[];
  admittedCustomerSources: number;
  expectedCustomerSources: number;
  factCheck: {
    totalClaims: number;
    supportedClaims: number;
    unsupportedClaims: number;
    sanitizedClaims: number;
    byCategory: {
      evidence: number;
      inference: number;
      scope: number;
      other: number;
    };
  };
}

export interface DurableAttemptSummary {
  headline: string;
  bottleneck: string;
  planningRationale: string;
  keyMetrics: string[];
  narrative: RenderedNarrative;
}

export const isDistractorFileName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return name === 'Systems-Thinking-and-the-Cynefin-Framework-Final.3.pdf'
    || (lower.includes('cynefin') && lower.endsWith('.pdf'));
};

export function findTableWithColumn(files: readonly ParsedEvidenceFile[], column: string): ParsedEvidenceFile | undefined {
  const target = column.trim().toLowerCase();
  return files.find(file => file.structuredTable?.headers.some(header => header.trim().toLowerCase() === target));
}

export function totalCents(file: ParsedEvidenceFile | undefined, column: string) {
  const table = file?.structuredTable;
  const target = column.trim().toLowerCase();
  const field = table?.headers.findIndex(header => header.trim().toLowerCase() === target) ?? -1;
  const rows = table?.analysis_rows;
  if (!table?.analysis_complete || !rows || field < 0) throw new Error('GOLDEN_STANDARD_INTEGRITY');
  const cents = rows.reduce((sum, row) => {
    const value = String(row[field] ?? '').trim();
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
    if (data.byteLength !== file.bytes) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    const type = mimeTypeForEvidenceFileName(file.name);
    const source = await parseEvidenceFile(new File([data], file.name, type ? { type } : undefined));
    if (source.acquisition?.original_sha256 !== `sha256_${file.sha256}`) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    return source;
  }));

  const billed = totalCents(findTableWithColumn(parsed, 'BilledCost') ?? parsed[0], 'BilledCost');
  const backlog = totalCents(findTableWithColumn(parsed, 'EstimatedSavingsEUR') ?? parsed[1], 'EstimatedSavingsEUR');
  const sources = toEvidenceSourceRecords(parsed);
  const distractorIndex = parsed.findIndex(file => isDistractorFileName(file.name));
  const excludedId = sources[distractorIndex >= 0 ? distractorIndex : 2]?.source_id;
  const result = await analyzeDocument(sources, () => {}, { deepMode, onRunStarted });
  const runId = result.meta.run_id;
  if (!runId) throw new Error('GOLDEN_STANDARD_RUN_INCOMPLETE');
  const { observation, narrative, summary } = prepareReport(result, sources, excludedId);
  const observed = { ...observation, billingRows: billed.rows, billingCents: billed.cents,
    backlogRows: backlog.rows, backlogCents: backlog.cents };
  const comparison = await caseRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(observed) })
    .then(response => response.json() as Promise<Comparison>).catch(() => undefined);
  const delivered = { comparison, narrative, summary, runId, completedAt: new Date().toISOString(), cleanupVerified: false };
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

const roundPercent = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value * 10) / 10))
    : null;

const clipText = (value: string | undefined, maxLength: number): string => {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
};

export function collectAdmittedSourceIds(result: DiagnosticResult): Set<string> {
  return new Set(
    result.meta.run_trace?.context_packets.flatMap(packet => packet.manifest.map(item => item.source_id)) ?? [],
  );
}

export function collectAdmittedSourcesByDomain(result: DiagnosticResult): Record<string, Set<string>> {
  const byDomain: Record<string, Set<string>> = {};
  for (const packet of result.meta.run_trace?.context_packets ?? []) {
    byDomain[packet.domain_id] = new Set(packet.manifest.map(item => item.source_id));
  }
  return byDomain;
}

export function buildMonitoringObservation(
  result: DiagnosticResult,
  sources: readonly SourceRecord[],
  excludedId: string | undefined,
): MonitoringObservation {
  const metrics = result.phase_2_validation.metrics;
  const sufficiency = result.phase_2_validation.assessment_sufficiency;
  const resolutions = result.phase_2_validation.resolution_maturity?.criterion_resolutions ?? [];
  const assessedCriteria = resolutions
    .filter(record => record.state === 'RESOLVED')
    .map(record => `${record.stream}.${record.criterion_id}`)
    .sort();
  const admitted = collectAdmittedSourceIds(result);
  const customerSources = sources.filter(source => source.source_id !== excludedId);
  const factCheck = result.quality_gate.fact_check;
  const unsupported = factCheck?.unsupported_claims ?? [];
  const byCategory = { evidence: 0, inference: 0, scope: 0, other: 0 };
  for (const claim of unsupported) {
    if (claim.failure_type === 'fabricated_number' || claim.failure_type === 'unverifiable_entity') {
      byCategory.evidence++;
    } else if (claim.failure_type === 'unsupported_org_claim') {
      byCategory.inference++;
    } else if (claim.failure_type === 'out_of_scope') {
      byCategory.scope++;
    } else {
      byCategory.other++;
    }
  }
  return {
    crawlWalkRun: result.phase_2_validation.crawl_walk_run,
    corroboratedMaturity: roundPercent(metrics.corroborated_maturity),
    observedMaturity: roundPercent(metrics.observed_maturity),
    adjustedMaturity: roundPercent(metrics.adjusted_maturity),
    assessmentResolution: roundPercent(metrics.assessment_resolution) ?? 0,
    criterionEvidenceDensity: roundPercent(sufficiency.criterion_evidence_density) ?? 0,
    antipatternBurden: roundPercent(metrics.antipattern_burden) ?? 0,
    assessedCriteria,
    admittedCustomerSources: customerSources.filter(source => admitted.has(source.source_id)).length,
    expectedCustomerSources: customerSources.length,
    factCheck: {
      totalClaims: factCheck?.total_claims ?? 0,
      supportedClaims: factCheck?.supported_count ?? 0,
      unsupportedClaims: unsupported.length,
      sanitizedClaims: factCheck?.sanitized_claims?.length ?? 0,
      byCategory,
    },
  };
}

export function buildDurableSummary(result: DiagnosticResult, narrative: RenderedNarrative): DurableAttemptSummary {
  const strategy = result.phase_3_strategy;
  const firstExecutiveSentence = strategy.executive_summary?.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  const headline = clipText(
    strategy.evidence_summary?.headline || strategy.visual_scorecard?.headline || firstExecutiveSentence,
    580,
  );
  const bottleneck = clipText(
    strategy.diagnosis?.primary_bottleneck || strategy.findings_mode?.evidence_backed_findings?.[0] || '',
    480,
  );
  const planningRationale = clipText(strategy.planning_decision?.rationale || '', 480);
  const keyMetrics = (strategy.evidence_summary?.key_metrics ?? [])
    .map(item => clipText(item, 240))
    .filter(Boolean)
    .slice(0, 6);
  return {
    headline,
    bottleneck,
    planningRationale,
    keyMetrics,
    narrative: {
      diagnosis: narrative.diagnosis.map(line => clipText(line, 580)).filter(Boolean).slice(0, 24),
      planning: narrative.planning.map(line => clipText(line, 580)).filter(Boolean).slice(0, 24),
      masterData: narrative.masterData.map(line => clipText(line, 580)).filter(Boolean).slice(0, 40),
    },
  };
}

export function prepareReport(result: DiagnosticResult, sources: SourceRecord[], excludedId: string | undefined) {
  const summary = generateSummaryReportHtml(result);
  const report = buildReportViewModel(result);
  const parser = new DOMParser();
  const rendered = parser.parseFromString(summary, 'text/html');
  const trace = result.meta.run_trace;
  const excludedChunkIds = new Set(trace?.input_manifest.find(entry => entry.source_id === excludedId)?.chunk_ids);
  const observation = {
    evidenceSufficiency: report.sufficiency.decision,
    qualityGate: report.actionability.gate,
    planningDecision: report.actionability.planningDecision.replace(/_/g, ' '),
    loadedInputsInTrace: sources.every(source => trace?.input_manifest.some(entry =>
      entry.source_id === source.source_id && entry.source_hash === source.acquisition?.original_sha256)),
    excludedDocument: !!excludedId && !!trace?.input_manifest.some(entry => entry.source_id === excludedId)
      && trace.context_packets.length === 6
      && trace.context_packets.every(packet => packet.manifest.every(item => item.source_id !== excludedId))
      && trace.evidence_paths.every(path => path.source_id !== excludedId
        && (!path.chunk_id || !excludedChunkIds.has(path.chunk_id))),
    directiveRoadmapWithheld: !!rendered.querySelector('.withheld-card, .findings-mode') && !rendered.querySelector('.summary-roadmap-phase'),
    maturityClassificationWithheld: Array.from(rendered.querySelectorAll('.hero .pill'))
      .some(pill => /^(?:Observed maturity band )?Insufficient evidence$/i.test(pill.textContent?.trim() ?? '')),
  };
  const masterData = parser.parseFromString(generateReportHtml(result), 'text/html');
  const narrative = collectRenderedNarrative(rendered, masterData);
  return { observation, summary, narrative };
}
