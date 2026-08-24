import {
  AuditItem,
  BoundedRetrievalTrace,
  DataSignalCoverageReport,
  SemanticGapRetrievalTrace,
  GapRetrievalPlan,
  DiagnosticResult,
  DlpScanResult,
  DerivedAnalyticalEvidence,
  EvidenceLaneStagePacket,
  EvidenceQuote,
  Phase1AuditLogs,
  Phase2Validation,
  QualityGateResult,
  RemoteKnowledgeBaseIndex,
  RoutedSourcePacket,
  RunTrace,
  RunTraceSummary,
  ScorePathTrace,
  SourceChunk,
  SourceManifestTrace,
  SourceRegistry,
  StageTrace,
  TableInspectionTrace,
  TacticPathTrace
} from '../types';
import {
  FINOPS_TACTIC_PLAYBOOK_URL,
  FINOPS_TACTIC_PLAYBOOK_VERSION,
  FINOPS_TACTIC_ACTIVITY_PLAYBOOK,
  FINOPS_ANTIPATTERNS,
  FINOPS_CRITERIA,
  FINOPS_TACTICS_LOCAL,
  FINOPS_TAXONOMY_REGISTRY
} from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';
import { hasVerifiedSourceCoverage } from './metricsService';
import { scrubGeneratedText } from './privacyService';

interface TacticGroundingTraceAdjustment {
  action_before: string;
  action_after: string;
  tactic_id: string;
  replacement_id?: string;
  reason: string;
}

interface BuildRunTraceInput {
  runId: string;
  engineVersion: string;
  sourceRegistry: SourceRegistry;
  sourcePackets: Record<string, RoutedSourcePacket>;
  evidenceStagePackets?: Record<string, EvidenceLaneStagePacket>;
  baselineEvidenceStagePackets?: Record<string, EvidenceLaneStagePacket>;
  dlpScan: DlpScanResult;
  dlpReviewChunkCount: number;
  referenceKbIndex: RemoteKnowledgeBaseIndex;
  stageTraces: StageTrace[];
  auditLogs: Phase1AuditLogs;
  evidenceCheck: DiagnosticResult['evidence_check'];
  phase2: Phase2Validation;
  strategy: DiagnosticResult['phase_3_strategy'];
  qualityGate: QualityGateResult;
  tacticGroundingAdjustments: TacticGroundingTraceAdjustment[];
  derivedAnalyticalEvidence?: DerivedAnalyticalEvidence[];
  tableInspections?: TableInspectionTrace[];
  dataSignalCoverage?: DataSignalCoverageReport;
  boundedRetrieval?: BoundedRetrievalTrace;
  semanticGapRetrieval?: SemanticGapRetrievalTrace;
  gapRetrieval?: GapRetrievalPlan;
}

const stageTraceBuffer = new Map<string, StageTrace[]>();

export const hashString = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a_${(h >>> 0).toString(16).padStart(8, '0')}`;
};

export const estimateTokens = (chars: number): number => Math.max(0, Math.ceil(chars / 4));

export const recordStageTrace = (runId: string, trace: StageTrace): void => {
  const traces = stageTraceBuffer.get(runId) || [];
  traces.push(trace);
  stageTraceBuffer.set(runId, traces);
};

export const consumeStageTraces = (runId: string): StageTrace[] => {
  const traces = stageTraceBuffer.get(runId) || [];
  stageTraceBuffer.delete(runId);
  return traces;
};

export const clearStageTraces = (runId: string): void => {
  stageTraceBuffer.delete(runId);
};

const safeSnippet = (value: string, max = 520): string => {
  const scrubbed = scrubGeneratedText(value || '', { redactPersonNames: true });
  return scrubbed.text.replace(/\s+/g, ' ').trim().slice(0, max);
};

const sourceManifest = (registry: SourceRegistry): SourceManifestTrace[] => {
  const acquisitionBySource = new Map((registry.source_acquisition || []).map(source => [source.source_id, source]));
  const bySource = new Map<string, SourceChunk[]>();
  for (const chunk of registry.chunks) {
    const list = bySource.get(chunk.source_id) || [];
    list.push(chunk);
    bySource.set(chunk.source_id, list);
  }
  return Array.from(bySource.entries()).map(([sourceId, chunks]) => {
    const acquisition = acquisitionBySource.get(sourceId);
    const pages = new Set(chunks.map(c => c.page_number).filter((p): p is number => typeof p === 'number'));
    const sheets = new Set(chunks.map(c => c.sheet_name).filter((s): s is string => typeof s === 'string'));
    const rows = chunks.map(c => c.row_number).filter((r): r is number => typeof r === 'number');
    const types = Array.from(new Set(chunks.map(c => c.type)));
    return {
      source_id: sourceId,
      source_hash: acquisition?.original_sha256 || hashString(chunks.map(c => `${c.chunk_id}:${c.text}`).join('\n')),
      chunk_count: chunks.length,
      chunk_ids: chunks.map(c => c.chunk_id),
      page_count: pages.size || undefined,
      sheet_count: sheets.size || undefined,
      row_count: rows.length > 0 ? rows.length : undefined,
      types,
      parse_warnings: Array.from(new Set(chunks.flatMap(c => c.parse_warnings || []))).slice(0, 12)
    };
  });
};

const evidencePathEffect = (stream: 'maturity' | 'antipattern', item: AuditItem): string => {
  if (item.verification_unresolved) return 'scanner_candidate_excluded_because_verification_was_unavailable';
  if (item.assessment_status === 'not_assessed') return 'unknown_not_assessed_adds_zero';
  if (stream === 'maturity') {
    if (item.count === 3) return 'verified_full_capability_adds_one_maturity_point';
    if (item.count === 2) return 'verified_partial_capability_adds_half_maturity_point';
    return item.evidence_quotes.length > 0
      ? 'verified_low_or_absent_capability_adds_zero_maturity_points'
      : 'not_demonstrated_adds_zero_without_proving_capability_absence';
  }
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'tested_absent') return 'verified_absence_adds_one_control_point';
  if (status === 'confirmed_present' || status === 'partially_present') return 'verified_antipattern_adds_burden_and_zero_control_points';
  return 'unknown_absence_adds_zero_without_proving_control';
};

const evidencePathsFor = (
  stream: 'maturity' | 'antipattern',
  logs: Record<string, AuditItem>
) => Object.entries(logs).flatMap(([criterionId, item]) =>
  (item.evidence_quotes || []).map((quote: EvidenceQuote, index) => ({
    path_id: `${stream}.${criterionId}.${index + 1}`,
    stream,
    criterion_id: criterionId,
    evidence_check_status: item.evidence_check_status,
    assessment_status: item.assessment_status,
    antipattern_absence_status: stream === 'antipattern' && !item.verification_unresolved ? inferAntiPatternAbsenceStatus(item) : undefined,
    source_id: quote.source_id,
    evidence_source: quote.evidence_source,
    derived_evidence_id: quote.derived_evidence_id,
    page_id: quote.page_id,
    chunk_id: quote.chunk_id,
    page_number: quote.page_number,
    sheet_name: quote.sheet_name,
    row_number: quote.row_number,
    evidence_category: quote.category,
    quote_snippet: safeSnippet(quote.quote, 500),
    original_count: item.original_count,
    verified_count: item.verified_count,
    final_count: item.verification_unresolved ? null : item.count,
    score_effect: evidencePathEffect(stream, item)
  }))
);

const scorePathsFor = (
  stream: 'maturity' | 'antipattern',
  logs: Record<string, AuditItem>
): ScorePathTrace[] => Object.entries(logs).map(([criterionId, item]) => ({
  stream,
  criterion_id: criterionId,
  final_count: item.verification_unresolved ? null : item.count,
  status: item.verification_unresolved ? 'verification_unresolved' : item.status,
  evidence_check_status: item.evidence_check_status,
  assessment_status: item.assessment_status,
  antipattern_absence_status: stream === 'antipattern' && !item.verification_unresolved ? inferAntiPatternAbsenceStatus(item) : undefined,
  has_quote_backed_coverage: !item.verification_unresolved
    && item.assessment_status !== 'not_assessed'
    && (item.evidence_quotes || []).length > 0,
  metric_effect: evidencePathEffect(stream, item)
}));

const TACTIC_RX = /\[(TAC-[A-Z]+-\d+(?:-[A-Z]+)?)\]/g;

const playbookById = new Map(FINOPS_TACTIC_ACTIVITY_PLAYBOOK.map(entry => [entry.tactic_id, entry]));
const maturityDefinitionById = new Map(FINOPS_CRITERIA.map(criterion => [criterion.id, criterion]));
const antipatternDefinitionById = new Map(FINOPS_ANTIPATTERNS.map(criterion => [criterion.id, criterion]));
const TRACE_STOP_WORDS = new Set([
  'about', 'acceptance', 'action', 'against', 'approved', 'based', 'control', 'define', 'evidence', 'finops',
  'current', 'defined', 'existing', 'from', 'implementation', 'implement', 'into', 'material', 'owner', 'phase',
  'process', 'record', 'roadmap', 'target', 'through', 'using', 'with'
]);

interface TraceFinding {
  criterionId: string;
  snippet: string;
  searchText: string;
  evidenceGrounded: boolean;
}

interface TraceLinkResult {
  linkedFindings: string[];
  evidenceGrounded: boolean;
}

const traceTokens = (value: string): Set<string> => new Set(
  value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)
    ?.filter(token => !TRACE_STOP_WORDS.has(token)) || []
);

const traceFindings = (auditLogs: Phase1AuditLogs): TraceFinding[] => {
  const findings: TraceFinding[] = [];
  for (const [criterionId, item] of Object.entries(auditLogs.maturity)) {
    const definition = maturityDefinitionById.get(criterionId);
    const evidenceGrounded = hasVerifiedSourceCoverage(item, 'maturity');
    if (!evidenceGrounded && item.assessment_status !== 'not_assessed' && !item.verification_unresolved) continue;
    findings.push({
      criterionId,
      snippet: safeSnippet(`[${criterionId}] ${evidenceGrounded ? item.reasoning || item.evidence : `Assessment gap: ${item.reasoning || item.evidence || 'not assessed'}`}`, 220),
      searchText: [definition?.title, definition?.description, item.reasoning, item.evidence].filter(Boolean).join(' '),
      evidenceGrounded,
    });
  }
  for (const [criterionId, item] of Object.entries(auditLogs.antipattern)) {
    const absence = inferAntiPatternAbsenceStatus(item);
    const evidenceGrounded = ['confirmed_present', 'partially_present'].includes(absence)
      && hasVerifiedSourceCoverage(item, 'antipattern');
    if (!evidenceGrounded && item.assessment_status !== 'not_assessed' && !item.verification_unresolved) continue;
    const definition = antipatternDefinitionById.get(criterionId);
    findings.push({
      criterionId: `AP-${criterionId}`,
      snippet: safeSnippet(`[AP-${criterionId}] ${evidenceGrounded ? item.reasoning || item.evidence : `Assessment gap: ${item.reasoning || item.evidence || 'not assessed'}`}`, 220),
      searchText: [definition?.title, definition?.description, item.reasoning, item.evidence].filter(Boolean).join(' '),
      evidenceGrounded,
    });
  }
  return findings;
};

const criterionIdsInAction = (action: string): Set<string> => {
  const ids = new Set<string>();
  const criterionRx = /\b(AP-)?([A-F])([1-5])(?:\s*-\s*(?:\2)?([1-5]))?\b/g;
  for (const match of action.matchAll(criterionRx)) {
    const prefix = match[1] || '';
    const category = match[2];
    const start = Number(match[3]);
    const end = Number(match[4] || match[3]);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let index = low; index <= high; index++) ids.add(`${prefix}${category}${index}`);
  }
  return ids;
};

const linkedFindingsForAction = (action: string, tacticIds: string[], auditLogs: Phase1AuditLogs): TraceLinkResult => {
  const allFindings = traceFindings(auditLogs);
  const explicitCriteria = criterionIdsInAction(action);
  if (explicitCriteria.size > 0) {
    const direct = allFindings.filter(finding => explicitCriteria.has(finding.criterionId));
    return {
      linkedFindings: direct.map(finding => finding.snippet),
      evidenceGrounded: direct.some(finding => finding.evidenceGrounded),
    };
  }
  const mappedCriteria = new Set<string>();
  for (const tacticId of tacticIds) {
    const entry = playbookById.get(tacticId);
    if (!entry) continue;
    for (const binding of [...entry.maturity_bindings, ...entry.antipattern_bindings]) mappedCriteria.add(binding.criterion_id);
  }
  const candidates = (tacticIds.length > 0
    ? allFindings.filter(finding => mappedCriteria.has(finding.criterionId))
    : allFindings).filter(finding => finding.evidenceGrounded);
  const actionTokens = traceTokens(action.replace(TACTIC_RX, ' '));
  const ranked = candidates.map(finding => ({
    finding,
    score: Array.from(traceTokens(finding.searchText)).filter(token => actionTokens.has(token)).length,
  })).sort((a, b) => b.score - a.score || a.finding.criterionId.localeCompare(b.finding.criterionId));
  const threshold = tacticIds.length > 0 ? 2 : 3;
  const bestScore = ranked[0]?.score || 0;
  const meaningful = bestScore >= threshold
    ? ranked.filter(candidate => candidate.score === bestScore).slice(0, 2)
    : [];
  return {
    linkedFindings: meaningful.map(candidate => candidate.finding.snippet),
    evidenceGrounded: meaningful.length > 0,
  };
};

const tacticPathsFor = (
  strategy: DiagnosticResult['phase_3_strategy'],
  auditLogs: Phase1AuditLogs,
  adjustments: TacticGroundingTraceAdjustment[],
  qualityGate: QualityGateResult
): TacticPathTrace[] => {
  const paths: TacticPathTrace[] = [];
  const roadmap = strategy.remediation_roadmap || [];
  roadmap.forEach((phase, phaseIndex) => {
    (phase.actions || []).forEach((action, actionIndex) => {
      const tacticIds = Array.from(String(action).matchAll(TACTIC_RX)).map(m => m[1]);
      if (tacticIds.length === 0 && !action) return;
      const links = linkedFindingsForAction(String(action), tacticIds, auditLogs);
      const linkedFindings = links.linkedFindings;
      paths.push({
        phase: phase.phase || `Phase ${phaseIndex + 1}`,
        action_index: actionIndex,
        action_snippet: safeSnippet(String(action), 520),
        tactic_ids: tacticIds,
        linked_findings: linkedFindings,
        reference_kind: tacticIds.length > 0 ? 'tactic_reference' : 'custom_action',
        grounding_status: tacticIds.length > 0
          ? links.evidenceGrounded ? 'grounded' : 'unknown'
          : links.evidenceGrounded
            ? 'evidence_grounded_no_tactic_match'
            : linkedFindings.length > 0 ? 'assessment_gap_linked_no_tactic_match' : 'unknown',
        notes: tacticIds.length === 0
          ? [linkedFindings.length > 0
            ? links.evidenceGrounded
              ? 'Supplemental action has action-specific customer-finding overlap but no approved tactic ID; semantic support remains subject to roadmap fact-check.'
              : 'Supplemental evidence-collection action explicitly references assessment gaps but has no approved tactic ID; it is not evidence of a customer control deficiency.'
            : 'Supplemental action has no deterministic action-specific finding match or approved tactic ID; semantic support remains subject to roadmap fact-check.']
          : [
            ...tacticIds.map(id => `Playbook reference: ${FINOPS_TACTIC_PLAYBOOK_URL}#${id.toLowerCase()}`),
            ...(linkedFindings.length === 0 ? ['No action-specific actionable customer finding was resolved for this tactic reference.'] : []),
            ...(linkedFindings.length > 0 && !links.evidenceGrounded
              ? ['The action explicitly references an assessment gap, not an evidence-grounded customer control deficiency.']
              : []),
          ]
      });
    });
  });
  for (const adjustment of adjustments) {
    paths.push({
      phase: 'Tactic grounding',
      action_index: -1,
      action_snippet: safeSnippet(adjustment.action_before, 520),
      tactic_ids: [adjustment.tactic_id],
      linked_findings: linkedFindingsForAction(adjustment.action_before, [adjustment.tactic_id], auditLogs).linkedFindings,
      reference_kind: 'tactic_reference',
      grounding_status: adjustment.action_after ? 'grounded' : 'withheld',
      notes: [
        adjustment.reason,
        adjustment.replacement_id ? `Replacement tactic: ${adjustment.replacement_id}` : 'Tactic reference withheld.'
      ].filter(Boolean)
    });
  }
  for (const claim of qualityGate.fact_check?.sanitized_claims || []) {
    if (claim.source_location !== 'roadmap') continue;
    paths.push({
      phase: 'Strategy sanitation',
      action_index: -1,
      action_snippet: safeSnippet(claim.claim, 520),
      tactic_ids: Array.from(claim.claim.matchAll(TACTIC_RX)).map(m => m[1]),
      linked_findings: linkedFindingsForAction(claim.claim, Array.from(claim.claim.matchAll(TACTIC_RX)).map(m => m[1]), auditLogs).linkedFindings,
      reference_kind: 'playbook_reference',
      grounding_status: claim.action === 'quarantined' ? 'quarantined' : 'withheld',
      notes: [claim.rationale]
    });
  }
  return paths;
};

const sanitationSummary = (gate: QualityGateResult) => {
  const sanitized = gate.fact_check?.sanitized_claims || [];
  return {
    removed: sanitized.filter(i => i.action === 'removed').length,
    rewritten: sanitized.filter(i => i.action === 'rewritten').length,
    quarantined: sanitized.filter(i => i.action === 'quarantined').length,
    remaining_unsupported: gate.fact_check?.unsupported_claims.length || 0
  };
};

const usageSummary = (stages: StageTrace[]) => {
  const by_model: RunTrace['usage_summary']['by_model'] = {};
  for (const stage of stages) {
    const key = stage.model || 'unknown';
    const current = by_model[key] || {
      calls: 0,
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      output_chars: 0
    };
    current.calls += 1;
    current.estimated_input_tokens += stage.input_tokens || stage.input_token_estimate || 0;
    current.estimated_output_tokens += stage.output_tokens || stage.output_token_estimate || 0;
    current.output_chars += stage.output_char_count || 0;
    by_model[key] = current;
  }
  return {
    stage_calls: stages.length,
    estimated_input_tokens: stages.reduce((sum, s) => sum + (s.input_tokens || s.input_token_estimate || 0), 0),
    estimated_output_tokens: stages.reduce((sum, s) => sum + (s.output_tokens || s.output_token_estimate || 0), 0),
    by_model
  };
};

export const summarizeRunTrace = (trace: RunTrace): RunTraceSummary => ({
  stage_count: trace.stages.length,
  source_count: trace.input_manifest.length,
  chunk_count: trace.input_manifest.reduce((sum, source) => sum + source.chunk_count, 0),
  evidence_path_count: trace.evidence_paths.length,
  score_path_count: trace.score_paths.length,
  tactic_path_count: trace.tactic_paths.length,
  quality_gate_decision: trace.quality_gate.decision
});

export const buildRunTrace = (input: BuildRunTraceInput): RunTrace => {
  const kbDocs = input.referenceKbIndex.documents || [];
  const kbVersionHashes = Object.fromEntries(kbDocs.map(doc => [
    doc.pathname,
    doc.extracted_text_sha256 || doc.pdf_sha256 || hashString([
      doc.kb_id || '',
      doc.domain_id,
      doc.criterion_id,
      doc.stream,
      doc.title,
      doc.body_excerpt
    ].join('|'))
  ]));
  const contextPackets = Object.entries(input.sourcePackets).map(([domain, packet]) => ({
    packet_id: `packet-${domain}`,
    domain_id: domain,
    title: packet.title,
    context_packet_hash: hashString(packet.text),
    evidence_stage_packet_hash: input.evidenceStagePackets?.[domain]?.integrity_hash,
    baseline_evidence_stage_packet_hash: input.baselineEvidenceStagePackets?.[domain]?.integrity_hash,
    evidence_stage_packet_schema: input.evidenceStagePackets?.[domain]?.schema_version,
    acquisition_readiness: input.evidenceStagePackets?.[domain]?.acquisition_readiness,
    acquisition_readiness_reasons: input.evidenceStagePackets?.[domain]?.acquisition_readiness_reasons,
    privacy_decision: input.evidenceStagePackets?.[domain]?.privacy_decision,
    withheld_content: input.evidenceStagePackets?.[domain]?.withheld_content,
    derived_evidence_count: input.evidenceStagePackets?.[domain]?.derived_evidence?.length,
    acquisition_diagnostic_count: input.evidenceStagePackets?.[domain]?.acquisition_diagnostics?.length,
    included_chunk_ids: packet.manifest.map(item => item.chunk_id),
    included_chunk_count: packet.included_chunk_count,
    total_candidate_chunks: packet.total_candidate_chunks,
    char_count: packet.char_count,
    image_count: packet.images.length,
    weak_coverage: packet.weak_coverage,
    coverage_notes: packet.coverage_notes,
    manifest: packet.manifest
  }));
  const evidencePaths = [
    ...evidencePathsFor('maturity', input.auditLogs.maturity),
    ...evidencePathsFor('antipattern', input.auditLogs.antipattern)
  ];
  const scorePaths = [
    ...scorePathsFor('maturity', input.auditLogs.maturity),
    ...scorePathsFor('antipattern', input.auditLogs.antipattern)
  ];
  const qualityGate = input.qualityGate;
  return {
    run_id: input.runId,
    engine_version: input.engineVersion,
    taxonomy_version: FINOPS_TAXONOMY_REGISTRY.version,
    taxonomy_hash: hashString(JSON.stringify(FINOPS_TAXONOMY_REGISTRY)),
    kb_index_hash: hashString(JSON.stringify(kbDocs.map(doc => ({
      pathname: doc.pathname,
      pdf_sha256: doc.pdf_sha256,
      extracted_text_sha256: doc.extracted_text_sha256
    })))),
    kb_version_hashes: kbVersionHashes,
    tactic_db_version: 'local-tactics-v1',
    tactic_db_hash: hashString(JSON.stringify(FINOPS_TACTICS_LOCAL)),
    playbook_version: FINOPS_TACTIC_PLAYBOOK_VERSION,
    playbook_hash: hashString(JSON.stringify(FINOPS_TACTIC_ACTIVITY_PLAYBOOK)),
    created_at: new Date().toISOString(),
    input_manifest: sourceManifest(input.sourceRegistry),
    context_packets: contextPackets,
    table_inspections: input.tableInspections,
    derived_analytical_evidence: input.derivedAnalyticalEvidence,
    data_signal_coverage: input.dataSignalCoverage,
    semantic_gap_retrieval: input.semanticGapRetrieval,
    bounded_retrieval: input.boundedRetrieval,
    gap_retrieval: input.gapRetrieval,
    dlp: {
      scanned_chunk_count: input.dlpScan.scanned_chunk_count,
      model_review_chunk_count: input.dlpReviewChunkCount,
      high_risk_hit_count: input.dlpScan.high_risk_hits.reduce((sum, hit) => sum + hit.count, 0),
      caution_hit_count: input.dlpScan.caution_hits.reduce((sum, hit) => sum + hit.count, 0),
      blocked: input.dlpScan.blocked,
      warnings: input.dlpScan.warnings.slice(0, 20)
    },
    stages: input.stageTraces,
    evidence_paths: evidencePaths,
    score_paths: scorePaths,
    tactic_paths: tacticPathsFor(input.strategy, input.auditLogs, input.tacticGroundingAdjustments, qualityGate),
    quality_gate: {
      decision: qualityGate.decision,
      blocking_reasons: qualityGate.blocking_reasons,
      warnings: qualityGate.warnings,
      fact_check: qualityGate.fact_check ? {
        attempts: qualityGate.fact_check.attempts,
        supported_count: qualityGate.fact_check.supported_count,
        total_claims: qualityGate.fact_check.total_claims,
        unsupported_count: qualityGate.fact_check.unsupported_claims.length,
        failed: qualityGate.fact_check.failed,
        trajectory: qualityGate.fact_check.trajectory
      } : undefined,
      sanitation: sanitationSummary(qualityGate),
      final_export_status: 'available'
    },
    usage_summary: usageSummary(input.stageTraces),
    privacy: {
      raw_source_included: false,
      full_prompts_included: false,
      api_keys_included: false,
      note: 'RunTrace stores source/chunk references, hashes, and report-visible quote snippets only. KB/playbook references are guidance, not customer evidence.'
    }
  };
};
