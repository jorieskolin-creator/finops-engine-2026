import {
  AuditItem,
  DiagnosticResult,
  DlpScanResult,
  DerivedAnalyticalEvidence,
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
  TacticPathTrace
} from '../types';
import {
  FINOPS_TACTIC_ACTIVITY_PLAYBOOK,
  FINOPS_TACTICS_LOCAL,
  FINOPS_TAXONOMY_REGISTRY
} from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';
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
  const bySource = new Map<string, SourceChunk[]>();
  for (const chunk of registry.chunks) {
    const list = bySource.get(chunk.source_id) || [];
    list.push(chunk);
    bySource.set(chunk.source_id, list);
  }
  return Array.from(bySource.entries()).map(([sourceId, chunks]) => {
    const pages = new Set(chunks.map(c => c.page_number).filter((p): p is number => typeof p === 'number'));
    const sheets = new Set(chunks.map(c => c.sheet_name).filter((s): s is string => typeof s === 'string'));
    const rows = chunks.map(c => c.row_number).filter((r): r is number => typeof r === 'number');
    const types = Array.from(new Set(chunks.map(c => c.type)));
    return {
      source_id: sourceId,
      source_name: chunks[0]?.source_name || sourceId,
      source_hash: hashString(chunks.map(c => `${c.chunk_id}:${c.text}`).join('\n')),
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
  if (stream === 'maturity') {
    if (item.count > 0) return 'positive_evidence_contributes_to_maturity_depth';
    return item.evidence_quotes.length > 0 ? 'quote_backed_gap_counts_as_source_coverage' : 'silent_or_unassessed_gap';
  }
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'confirmed_present') return 'confirmed_antipattern_increases_burden';
  if (status === 'partially_present') return 'partial_antipattern_increases_burden_moderately';
  if (status === 'tested_absent') return 'verified_absence_increases_clearance';
  return 'unknown_absence_neutral';
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
    antipattern_absence_status: stream === 'antipattern' ? inferAntiPatternAbsenceStatus(item) : undefined,
    source_id: quote.source_id,
    page_id: quote.page_id,
    chunk_id: quote.chunk_id,
    source_document: quote.source_document,
    page_number: quote.page_number,
    sheet_name: quote.sheet_name,
    row_number: quote.row_number,
    evidence_category: quote.category,
    quote_snippet: safeSnippet(quote.quote, 500),
    original_count: item.original_count,
    verified_count: item.verified_count,
    final_count: item.count,
    score_effect: evidencePathEffect(stream, item)
  }))
);

const scorePathsFor = (
  stream: 'maturity' | 'antipattern',
  logs: Record<string, AuditItem>
): ScorePathTrace[] => Object.entries(logs).map(([criterionId, item]) => ({
  stream,
  criterion_id: criterionId,
  final_count: item.count,
  status: item.status,
  evidence_check_status: item.evidence_check_status,
  antipattern_absence_status: stream === 'antipattern' ? inferAntiPatternAbsenceStatus(item) : undefined,
  has_quote_backed_coverage: (item.evidence_quotes || []).length > 0,
  metric_effect: evidencePathEffect(stream, item)
}));

const TACTIC_RX = /\[(TAC-[A-Z]+-\d+(?:-[A-Z]+)?)\]/g;

const tacticPathsFor = (
  strategy: DiagnosticResult['phase_3_strategy'],
  phase2: Phase2Validation,
  adjustments: TacticGroundingTraceAdjustment[],
  qualityGate: QualityGateResult
): TacticPathTrace[] => {
  const findings = [
    ...phase2.maturity_gaps,
    ...phase2.antipattern_findings,
    ...phase2.silent_areas
  ].map(safe => safeSnippet(safe, 180));
  const paths: TacticPathTrace[] = [];
  const roadmap = strategy.remediation_roadmap || [];
  roadmap.forEach((phase, phaseIndex) => {
    (phase.actions || []).forEach((action, actionIndex) => {
      const tacticIds = Array.from(String(action).matchAll(TACTIC_RX)).map(m => m[1]);
      if (tacticIds.length === 0 && !action) return;
      paths.push({
        phase: phase.phase || `Phase ${phaseIndex + 1}`,
        action_index: actionIndex,
        action_snippet: safeSnippet(String(action), 520),
        tactic_ids: tacticIds,
        linked_findings: findings.slice(0, 8),
        reference_kind: tacticIds.length > 0 ? 'tactic_reference' : 'playbook_reference',
        grounding_status: 'grounded',
        notes: tacticIds.length === 0 ? ['No tactic ID was forced where no exact tactic reference was present.'] : undefined
      });
    });
  });
  for (const adjustment of adjustments) {
    paths.push({
      phase: 'Tactic grounding',
      action_index: -1,
      action_snippet: safeSnippet(adjustment.action_before, 520),
      tactic_ids: [adjustment.tactic_id],
      linked_findings: findings.slice(0, 8),
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
      linked_findings: findings.slice(0, 8),
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
    playbook_hash: hashString(JSON.stringify(FINOPS_TACTIC_ACTIVITY_PLAYBOOK)),
    created_at: new Date().toISOString(),
    input_manifest: sourceManifest(input.sourceRegistry),
    context_packets: contextPackets,
    derived_analytical_evidence: input.derivedAnalyticalEvidence,
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
    tactic_paths: tacticPathsFor(input.strategy, input.phase2, input.tacticGroundingAdjustments, qualityGate),
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
