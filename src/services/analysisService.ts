
import {
  EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION,
  EVIDENCE_SYNTHESIS_USER_PROMPT,
  ROADMAP_SYNTHESIS_PROMPT_CAUTIOUS_APPENDIX,
  ROADMAP_SYNTHESIS_SYSTEM_INSTRUCTION,
  ROADMAP_SYNTHESIS_USER_PROMPT,
  STRATEGY_USER_PROMPT_FINDINGS
} from "../constants";
import { bracketFromValidation, explainBracket } from "./confidenceBracket";
import { runPhase1Audit } from "../orchestrator";
import { knowledgeBaseService, BATCH_DEFINITIONS, FINOPS_TACTICS_LOCAL, FINOPS_TACTIC_ACTIVITY_PLAYBOOK, FINOPS_TAXONOMY_REGISTRY, buildTacticIdTable, validTacticIdSet } from "../knowledge_base";
import { DiagnosticResult, Phase1AuditLogs, Phase2Validation, AuditItem, EvidenceQuote, EvidenceCategory, EVIDENCE_CATEGORIES, PersonaId, PERSONA_IDS, PipelineProgressStage, PipelineProgressUpdate, SourceRecord } from "../types";
import { validatePhase1Output, validatePhase3Grounding } from "./validatorService";
import { EVIDENCE_DENSITY_BLOCK, runQualityGate, runQualityGateExplanation } from "./qualityGateService";
import { applyQualityGateScoreCap, calculateMetrics } from "./metricsService";
import {
  buildRegenerateAppendix,
  buildRoadmapFactCheckPrompt,
  buildSummaryFactCheckPrompt,
  mergeRequiredFactChecks,
  parseFactCheckResponse,
  ROADMAP_FACT_CHECK_CONTRACT,
  SUMMARY_FACT_CHECK_CONTRACT
} from "./factCheckService";
import { FactCheckClaim, FactCheckResult, FactCheckPassSnapshot } from "../types";
import { StageId } from "../models";
import { getModelRoutingConfig, runStage, serverLog } from "./modelRouter";
import { createRun, failRun, getRun, readyRun, suspendRun } from "./runLifecycleService";
import { saveCheckpoint, type CheckpointKind } from "./checkpointService";
import { sanitizeRoadmapTacticGrounding, TacticGroundingAdjustment } from "./tacticGroundingService";
import { sanitizeBlockedStrategy, sanitizeEvidenceSummaryUncertainty, sanitizeStrategyAfterFactCheck } from "./strategySanitationService";
import {
  buildDomainPackets,
  buildSourceRegistry,
  renderPseudonymousSourceContext,
  scanRegistryDlp,
  sourceRegistryRuntimeStatus
} from "./sourceRegistryService";
import { buildRunTrace, clearStageTraces, consumeStageTraces, summarizeRunTrace } from "./runTraceService";
import { acquisitionQualityPersistence, buildAcquisitionQualitySnapshot, shadowTelemetryPersistence } from "./acquisitionQualityService";
import { analyzeStructuredSources, buildDataSignalCoverageReport } from "./structuredDataAnalysisService";
import { buildEvidenceLaneStagePackets } from "./evidenceStagePacketService";
import { applyBoundedRetrieval } from "./boundedRetrievalService";
import { expandWeakEvidencePacket } from "./semanticGapRetrievalService";
import { sanitizeEvidenceSources } from "./deterministicPrivacyService";
import { scrubDiagnosticResultForPrivacy } from "./privacyService";
import { parseGovernedJsonObject, validateFindingsModePayload } from "./jsonResponseService";
import { reconcileEvidenceProvenance } from "./evidenceCheckService";
// @ts-expect-error Pure JS contracts are also consumed by the server-side worker.
import { OUTPUT_CONTRACT_IDS, withOneOutputRegeneration } from "../../lib/outputContracts.js";
import {
  PipelineIntegrityError,
  validateEvidenceAcquisition,
  validateEvidenceContinuity,
  validateKnowledgeAcquisition,
  validatePreSynthesisIntegrity,
} from "./pipelineIntegrityService";

const FACT_CHECK_MAX_RETRIES = 2;
const ID_VALIDATION_MAX_REGENS = 2;
const ENGINE_VERSION = "finops-1.0.0";

// Pull every [TAC-XXX-NNN] (or [TAC-XXX-NNN-XXX]) reference out of the raw
// strategy JSON and check each against the verified DB. Returns the list of
// invalid IDs (deduplicated, sorted) — empty means everything checked out.
const findInvalidTacticIds = (strategyData: any, validIds: Set<string>): string[] => {
  const blob = JSON.stringify(strategyData ?? {});
  const found = new Set<string>();
  const RX = /\[(TAC-[A-Z]+-\d+(?:-[A-Z]+)?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = RX.exec(blob)) !== null) {
    const id = m[1];
    if (!validIds.has(id)) found.add(id);
  }
  return Array.from(found).sort();
};

const buildInvalidIdAppendix = (invalid: string[], validIds: Set<string>): string => `

### REGENERATE INSTRUCTIONS — your previous output cited tactic IDs that do not exist

The output contained these tactic IDs that are NOT in the Verified Tactics Database:
${invalid.map(id => `  - ${id}`).join('\n')}

These are not valid. You either invented them, abbreviated a real ID (e.g. TAC-CUL- vs TAC-CULT-, TAC-ARC- vs TAC-ARCH-), or appended a suffix (e.g. -COM) that does not exist.

The COMPLETE list of valid tactic IDs is in the TACTIC IDS — LOOKUP TABLE section above. Use ONLY those exact strings.

Regenerate the full output with the same shape. Replace every invalid ID with a valid one (matching the underlying mechanism you intended), or remove the bracketed ID entirely if no valid one fits. Do NOT introduce any new invalid IDs.
`;

const ALL_CRITERIA_IDS = Object.keys(BATCH_DEFINITIONS)
  .flatMap(batchId => [1, 2, 3, 4, 5].map(n => `${batchId}${n}`));

const DEFAULT_PERSONA: PersonaId = 'finops_lead';

const normalizePersonaSummaries = (rawStrategy: any): {
  executive_summaries: Record<PersonaId, string>;
  executive_summary: string;
  active_persona: PersonaId;
} => {
  const incoming = rawStrategy?.executive_summaries;
  const legacy = typeof rawStrategy?.executive_summary === 'string' ? rawStrategy.executive_summary : '';
  const result: Record<PersonaId, string> = { finops_lead: '', cfo: '', engineering_lead: '' };
  if (incoming && typeof incoming === 'object') {
    for (const p of PERSONA_IDS) {
      if (typeof incoming[p] === 'string' && incoming[p].length > 0) {
        result[p] = incoming[p];
      }
    }
  }
  const firstAvailable = PERSONA_IDS.find(p => result[p].length > 0);
  const fallback = firstAvailable ? result[firstAvailable] : legacy;
  for (const p of PERSONA_IDS) {
    if (!result[p]) result[p] = fallback;
  }
  return {
    executive_summaries: result,
    executive_summary: result[DEFAULT_PERSONA] || fallback,
    active_persona: DEFAULT_PERSONA
  };
};

const parseAiResponse = (text: string): any => {
  return parseGovernedJsonObject(text);
};

// Direct model calls now flow through modelRouter (`runStage`). The router
// resolves stage → primary+fallbacks from src/models.ts and dispatches to the
// right provider endpoint.

const validateAndSanitizeLogs = (rawData: any): Phase1AuditLogs => {
  const safeLog: Phase1AuditLogs = { maturity: {}, antipattern: {} };

  const validateItem = (item: any, isAntipattern: boolean): AuditItem => {
    if (!item || typeof item !== 'object') {
      return {
        count: -1, status: "NOK", evidence: "AI Analysis Failed",
        evidence_quotes: [], is_silent: true, reasoning: "Data missing."
      };
    }

    const safeItem: AuditItem = {
      count: 0, status: "NOK", evidence: "Evidence extracted.",
      evidence_quotes: [], is_silent: false, reasoning: "No reasoning provided."
    };

    if (typeof item.count === 'number') {
      safeItem.count = Math.min(Math.max(Math.round(item.count), 0), 3);
    }

    if (isAntipattern) {
      if (safeItem.count === 0) { safeItem.status = "OK"; safeItem.is_silent = true; safeItem.evidence = "Anti-pattern not detected. (Clean)"; }
      else if (safeItem.count === 3) { safeItem.status = "NOK"; safeItem.is_silent = false; }
      else { safeItem.status = "Partial"; safeItem.is_silent = false; }
    } else {
      if (safeItem.count === 3) { safeItem.status = "OK"; safeItem.is_silent = false; }
      else if (safeItem.count === 0) { safeItem.status = "NOK"; safeItem.is_silent = true; safeItem.evidence = "Capability missing."; }
      else { safeItem.status = "Partial"; safeItem.is_silent = false; }
    }

    if (typeof item.evidence === 'string' && item.evidence.length > 5) safeItem.evidence = item.evidence;
    if (typeof item.reasoning === 'string') safeItem.reasoning = item.reasoning;
    if (['supported', 'weak', 'unsupported', 'missing'].includes(item.evidence_check_status)) {
      safeItem.evidence_check_status = item.evidence_check_status;
    }
    if (typeof item.original_count === 'number') safeItem.original_count = Math.min(Math.max(Math.round(item.original_count), 0), 3);
    if (typeof item.verified_count === 'number') safeItem.verified_count = Math.min(Math.max(Math.round(item.verified_count), 0), 3);
    if (item.verification_unresolved === true && item.verified_count === null) {
      safeItem.verification_unresolved = true;
      safeItem.verified_count = null;
    }
    if (typeof item.adjustment_reason === 'string') safeItem.adjustment_reason = item.adjustment_reason;
    if (typeof item.rescan_attempted === 'boolean') safeItem.rescan_attempted = item.rescan_attempted;
    if (isAntipattern && ['confirmed_present', 'partially_present', 'tested_absent', 'unknown_absent'].includes(item.antipattern_absence_status)) {
      safeItem.antipattern_absence_status = item.antipattern_absence_status;
    }
    if (isAntipattern && typeof item.coverage_reason === 'string') safeItem.coverage_reason = item.coverage_reason;

    if (Array.isArray(item.evidence_quotes)) {
      safeItem.evidence_quotes = item.evidence_quotes
        .filter((q: any) => q && typeof q === 'object' && typeof q.quote === 'string')
        .map((q: any): EvidenceQuote => ({
          quote: q.quote,
          source_document: typeof q.source_document === 'string' ? q.source_document : undefined,
          section: typeof q.section === 'string' ? q.section : undefined,
          category: EVIDENCE_CATEGORIES.includes(q.category) ? q.category as EvidenceCategory : undefined,
          evidence_source: q.evidence_source === 'image' ? 'image' : q.evidence_source === 'derived' ? 'derived' : 'text',
          derived_evidence_id: typeof q.derived_evidence_id === 'string' ? q.derived_evidence_id : undefined,
          page_number: typeof q.page_number === 'number' && q.page_number > 0 ? q.page_number : undefined,
          source_id: typeof q.source_id === 'string' ? q.source_id : undefined,
          page_id: typeof q.page_id === 'string' ? q.page_id : undefined,
          chunk_id: typeof q.chunk_id === 'string' ? q.chunk_id : undefined,
          sheet_name: typeof q.sheet_name === 'string' ? q.sheet_name : undefined,
          row_number: typeof q.row_number === 'number' && q.row_number > 0 ? q.row_number : undefined
        }));
    }

    if (safeItem.evidence_quotes.length > 0) {
      const footprint: Partial<Record<EvidenceCategory, number>> = {};
      for (const q of safeItem.evidence_quotes) {
        if (q.category) footprint[q.category] = (footprint[q.category] || 0) + 1;
      }
      if (Object.keys(footprint).length > 0) safeItem.category_footprint = footprint;
    }

    return safeItem;
  };

  const rawMaturity = rawData?.phase_1_audit_logs?.maturity || {};
  ALL_CRITERIA_IDS.forEach(id => safeLog.maturity[id] = validateItem(rawMaturity[id], false));

  const rawAntipattern = rawData?.phase_1_audit_logs?.antipattern || {};
  ALL_CRITERIA_IDS.forEach(id => safeLog.antipattern[id] = validateItem(rawAntipattern[id], true));

  return safeLog;
};

export interface AnalyzeOptions {
  // User-controlled override: forces synthesis_escalation (Opus 4.7) even when
  // auto-rules wouldn't fire. Use for high-stakes / board-level assessments.
  deepMode?: boolean;
  onRunStarted?: (runId: string) => void;
}

export const analyzeDocument = async (
  sources: SourceRecord[],
  onProgress: (update: PipelineProgressUpdate) => void,
  options: AnalyzeOptions = {}
): Promise<DiagnosticResult> => {
  const images: never[] = [];
  const modelRouting = await getModelRoutingConfig();
  const modelRoutingMode = modelRouting.label;
  // This is deliberately the first content-processing action: PostgreSQL owns
  // the UUID and deadlines before source text is inspected or packetized.
  const authoritativeRun = await createRun();
  const runId = authoritativeRun.run_id;
  options.onRunStarted?.(runId);
  let completionIntent = false;
  let hasRecoverableCheckpoint = false;
  let checkpointParentHash: string | undefined;
  const checkpoint = async (kind: CheckpointKind, scope: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      const saved = await saveCheckpoint(runId, kind, scope, payload, checkpointParentHash);
      checkpointParentHash = saved.payload_hash;
      hasRecoverableCheckpoint = true;
      serverLog(runId, 'info', 'checkpoint_saved', { kind, scope, revision: saved.revision });
    } catch {
      serverLog(runId, 'warn', 'checkpoint_save_failed', { kind, scope, error_code: 'CHECKPOINT_UNAVAILABLE' });
    }
  };
  const activeProgressStages = new Set<PipelineProgressStage>();
  const emitProgress = (update: PipelineProgressUpdate): void => {
    if (update.status === 'in_progress') activeProgressStages.add(update.stage);
    else activeProgressStages.delete(update.stage);
    onProgress(update);
  };
  const pipelineStarted = Date.now();
  const actuals: Record<string, string> = {
    forensic_audit: modelRouting.routes.forensic_audit[0].id,
    targeted_rescan: modelRouting.routes.targeted_rescan[0].id,
    evidence_check: modelRouting.routes.evidence_check[0].id,
    evidence_adjudication: modelRouting.routes.evidence_adjudication[0].id,
    synthesis: modelRouting.routes.synthesis[0].id,
    roadmap_synthesis: modelRouting.routes.roadmap_synthesis[0].id,
    fact_check: modelRouting.routes.fact_check[0].id,
    fact_check_high: modelRouting.routes.fact_check_high[0].id,
  };

  console.log(`[FinOps] === Pipeline start === run=${runId} deepMode=${!!options.deepMode}`);
  serverLog(runId, 'info', 'pipeline_start', {
    source_chars: sources.reduce((n,s) => n + (s.text?.length || 0) + (s.pages?.reduce((m,p)=>m+p.text.length,0) || 0), 0),
    images: 0,
    model_mode: modelRoutingMode,
  });

  try {
    // Authoritative customer-content boundary. No model route is invoked until
    // the complete source population has passed this deterministic scan.
    const privacy = sanitizeEvidenceSources(sources);
    if (privacy.decision.decision === 'BLOCK') {
      throw new Error(`Deterministic privacy gate blocked the evidence set (${privacy.decision.blocking_codes.join(', ')}). Remove prohibited secrets before running the assessment.`);
    }
    const acquiredSources = privacy.sources;
    const extractionWarnings = acquiredSources.filter(source => source.extraction?.truncated || source.extraction?.quality === 'poor' || (source.parse_warnings?.length || 0) > 0).length;
    emitProgress({ stage: 'extraction', status: extractionWarnings > 0 ? 'completed_with_warnings' : 'completed' });
    emitProgress({ stage: 'packetization', status: 'in_progress' });
    const sourceRegistry = buildSourceRegistry(acquiredSources);
    const derivedAnalyticalEvidence = analyzeStructuredSources(acquiredSources);
    const tableInspections = acquiredSources.flatMap(source =>
      [...(source.structured_tables || []), ...(source.structured_table ? [source.structured_table] : [])]
        .flatMap(table => table.deterministic_inspection ? [{
          source_id: source.source_id,
          sheet_name: table.sheet_name,
          model_eligible: table.model_eligible !== false,
          inspection: table.deterministic_inspection
        }] : [])
    );
    const dataSignalCoverage = buildDataSignalCoverageReport();
    const text = renderPseudonymousSourceContext(sourceRegistry, 120000);
    const baselineSourcePackets = buildDomainPackets(sourceRegistry);
    const { packets: sourcePackets, trace: boundedRetrieval } = applyBoundedRetrieval(sourceRegistry, baselineSourcePackets);
    const weakDomainIds = Object.entries(sourcePackets)
      .filter(([, packet]) => packet.weak_coverage)
      .map(([domain]) => domain);
    const dlpScan = scanRegistryDlp(sourceRegistry);
    const packetWarnings = Object.values(sourcePackets).filter(packet => packet.weak_coverage).length;
    emitProgress({ stage: 'packetization', status: packetWarnings > 0 ? 'completed_with_warnings' : 'completed' });
    emitProgress({ stage: 'privacy', status: 'in_progress' });
    const sourceParseWarnings = [
      ...sourceRegistry.warnings,
      ...dlpScan.caution_hits.map(hit => `DLP caution: ${hit.kind} detected in ${hit.chunk_ids.length} chunk(s).`),
      ...Object.entries(sourcePackets)
        .filter(([, packet]) => packet.weak_coverage)
        .map(([domain, packet]) => `Source packet ${domain} has incomplete deterministic routing coverage (${packet.included_chunk_count}/${packet.total_candidate_chunks} relevant chunks); no broad-source fallback was used.`)
    ];
    serverLog(runId, 'info', 'source_registry_created', {
      sources: sourceRegistry.source_count,
      chunks: sourceRegistry.chunk_count,
      dlp_review_chunks: 0,
      images: 0,
      withheld_sheets: sourceRegistry.acquisition_limitations.withheld_sheet_count,
      withheld_rows: sourceRegistry.acquisition_limitations.withheld_row_count,
      withheld_columns: sourceRegistry.acquisition_limitations.withheld_column_count,
      active_filter_tables: sourceRegistry.acquisition_limitations.active_filter_table_count,
      merged_ranges: sourceRegistry.acquisition_limitations.merged_range_count,
      uninspected_workbook_image_sources: sourceRegistry.acquisition_limitations.uninspected_workbook_image_source_count,
      partial_native_charts: sourceRegistry.acquisition_limitations.partial_native_chart_count,
      unsupported_workbook_object_codes: sourceRegistry.acquisition_limitations.unsupported_object_codes.length,
    });
    for (const [domain, packet] of Object.entries(sourcePackets)) {
      serverLog(runId, packet.weak_coverage ? 'warn' : 'info', 'source_packet_created', {
        domain,
        chunks: packet.included_chunk_count,
        candidates: packet.total_candidate_chunks,
        weak_coverage: packet.weak_coverage ? 'yes' : 'no',
        chars: packet.char_count,
        images: packet.images.length,
      });
    }
    serverLog(runId, dlpScan.blocked ? 'error' : dlpScan.caution_hits.length > 0 ? 'warn' : 'info', 'dlp_full_source_scan', {
      chunks: dlpScan.scanned_chunk_count,
      high_risk_hits: dlpScan.high_risk_hits.reduce((sum, hit) => sum + hit.count, 0),
      caution_hits: dlpScan.caution_hits.reduce((sum, hit) => sum + hit.count, 0),
      blocked: dlpScan.blocked ? 'yes' : 'no',
    });
    if (dlpScan.blocked) {
      throw new Error(`Security Alert: high-risk secret material detected in source chunks (${dlpScan.high_risk_hits.map(hit => `${hit.kind}:${hit.count}`).join(', ')}). Remove or redact secrets before running the assessment.`);
    }
    const evidenceIntegrity = validateEvidenceAcquisition(acquiredSources, sourceRegistry, sourcePackets);
    const sourceRegistryStatus = sourceRegistryRuntimeStatus(
      sourceRegistry,
      sourcePackets,
      0,
      dlpScan,
      privacy.decision,
      evidenceIntegrity
    );
    const evidenceStagePackets = buildEvidenceLaneStagePackets({
      source_packets: sourcePackets,
      source_packet_hashes: evidenceIntegrity.packet_hashes,
      derived_evidence: derivedAnalyticalEvidence,
      acquisition_limitations: sourceRegistry.acquisition_limitations,
      privacy_decision: privacy.decision,
      acquisition_readiness: sourceRegistryStatus.acquisition_readiness
    });
    const semanticPackets = { ...sourcePackets };
    const expandWeakEvidence = (input: Parameters<NonNullable<import('../orchestrator').Phase1SourcePackets['expandWeakEvidence']>>[0]) => {
      const expanded = expandWeakEvidencePacket({
        registry: sourceRegistry,
        packet: semanticPackets[input.batchId],
        items: input.items,
        pass: input.pass,
        seenTerms: input.seenTerms
      });
      semanticPackets[input.batchId] = expanded.packet;
      const snapshot = { ...sourcePackets, [input.batchId]: expanded.packet };
      const integrity = validateEvidenceAcquisition(acquiredSources, sourceRegistry, snapshot);
      const status = sourceRegistryRuntimeStatus(sourceRegistry, snapshot, 0, dlpScan, privacy.decision, integrity);
      const rebuilt = buildEvidenceLaneStagePackets({
        source_packets: snapshot,
        source_packet_hashes: integrity.packet_hashes,
        derived_evidence: derivedAnalyticalEvidence,
        acquisition_limitations: sourceRegistry.acquisition_limitations,
        privacy_decision: privacy.decision,
        acquisition_readiness: status.acquisition_readiness
      })[input.batchId];
      return {
        packet: rebuilt,
        trace: {
          ...expanded.trace,
          packet_hash_before: input.packet.integrity_hash,
          packet_hash_after: rebuilt.integrity_hash
        }
      };
    };
    serverLog(runId, 'info', 'pipeline_integrity_passed', {
      gate: 'acquisition',
      sources: sourceRegistry.source_count,
      chunks: sourceRegistry.chunk_count,
      domains: Object.keys(sourcePackets).length,
      registry_hash: evidenceIntegrity.registry_hash,
      packet_manifest_hash: evidenceIntegrity.packet_manifest_hash,
    });
    await checkpoint('acquisition', 'accepted', {
      source_registry_status: sourceRegistryStatus,
      privacy_decision: privacy.decision,
      integrity: evidenceIntegrity,
      source_parse_warnings: sourceParseWarnings,
    });

    if (privacy.decision.redaction_count > 0) {
      sourceParseWarnings.push(`Deterministic privacy controls redacted ${privacy.decision.redaction_count} prohibited contact, identifier, or financial-value occurrence(s) before packet assembly.`);
    }
    console.log("[FinOps] Deterministic privacy scan passed. Phase 1 is the first generative stage.");
    const privacyWarnings = dlpScan.caution_hits.length > 0 || privacy.decision.redaction_count > 0;
    emitProgress({ stage: 'privacy', status: privacyWarnings ? 'completed_with_warnings' : 'completed' });

    console.log("[FinOps] Pre-fetching Tactics Database for Phase 3...");
    emitProgress({ stage: 'knowledge', status: 'in_progress' });
    const tacticsPromise = knowledgeBaseService.fetchStrategicPlaybook();
    const referenceKbPromise = knowledgeBaseService.fetchReferenceKnowledgeBaseIndex();
    const referenceKbIndex = await referenceKbPromise;
    const knowledgeIntegrity = validateKnowledgeAcquisition(referenceKbIndex);
    serverLog(runId, 'info', 'pipeline_integrity_passed', {
      gate: 'knowledge',
      knowledge_mode: knowledgeIntegrity.mode,
      knowledge_hash: knowledgeIntegrity.index_hash,
    });
    serverLog(runId, referenceKbIndex.status.source === 'remote_blob' ? 'info' : 'warn', referenceKbIndex.status.source === 'remote_blob' ? 'kb_index_loaded' : 'kb_index_fallback', {
      documents: referenceKbIndex.status.document_count,
      failures: referenceKbIndex.status.failure_count,
      source: referenceKbIndex.status.source,
    });
    const knowledgeWarnings = referenceKbIndex.status.failure_count > 0
      || referenceKbIndex.status.source !== 'remote_blob'
      || referenceKbIndex.status.document_count === 0;
    emitProgress({ stage: 'knowledge', status: knowledgeWarnings ? 'completed_with_warnings' : 'completed' });

    console.log(`[FinOps] [${runId}] Running Phase 1 Parallel Audit (${Object.keys(BATCH_DEFINITIONS).length} batches)...`);
    emitProgress({ stage: 'analysis', status: 'in_progress', completed: 0, total: Object.keys(BATCH_DEFINITIONS).length });
    emitProgress({ stage: 'evidence', status: 'in_progress', completed: 0, total: Object.keys(BATCH_DEFINITIONS).length });
    const phase1Started = Date.now();
    let aggregatedRawData = await runPhase1Audit(text, images, (completed, total, batchId) => {
      emitProgress({ stage: 'analysis', status: 'in_progress', completed, total, domain_id: batchId });
      emitProgress({ stage: 'evidence', status: 'in_progress', completed, total, domain_id: batchId });
    }, { runId }, { packets: evidenceStagePackets, expandWeakEvidence });
    if (aggregatedRawData.models_used.length > 0) {
      actuals.forensic_audit = aggregatedRawData.models_used.join(',');
    }
    if (aggregatedRawData.targeted_rescan_models_used.length > 0) {
      actuals.targeted_rescan = aggregatedRawData.targeted_rescan_models_used.join(',');
    }
    if (aggregatedRawData.evidence_check_models_used.length > 0) {
      actuals.evidence_check = aggregatedRawData.evidence_check_models_used.join(',');
    }
    if (aggregatedRawData.evidence_adjudication_models_used.length > 0) {
      actuals.evidence_adjudication = aggregatedRawData.evidence_adjudication_models_used.join(',');
    }
    validateEvidenceContinuity(evidenceIntegrity, sourceRegistry, sourcePackets);
    const provenanceReconciliation = reconcileEvidenceProvenance(aggregatedRawData, sourceRegistry, sourcePackets, derivedAnalyticalEvidence);
    aggregatedRawData = provenanceReconciliation.result;
    if (provenanceReconciliation.adjustedCriteria.length > 0) {
      serverLog(runId, 'warn', 'finding_provenance_adjusted', {
        domains: [...new Set(provenanceReconciliation.adjustedCriteria.map(id => id.charAt(0)))].join(','),
        criteria_count: provenanceReconciliation.adjustedCriteria.length,
        removed_quotes: provenanceReconciliation.removedQuoteCount,
      });
    }
    serverLog(runId, 'info', 'stage_complete', {
      stage: 'forensic_audit',
      model: aggregatedRawData.models_used.join(',') || actuals.forensic_audit,
      targeted_rescan_model: aggregatedRawData.targeted_rescan_models_used.join(',') || 'n/a',
      evidence_check_model: aggregatedRawData.evidence_check_models_used.join(',') || actuals.evidence_check,
      evidence_adjudication_model: aggregatedRawData.evidence_adjudication_models_used.join(',') || 'n/a',
      duration_ms: Date.now() - phase1Started,
      failed_batches: aggregatedRawData.failed_batches.join(',') || 'none',
      evidence_downgrades: aggregatedRawData.evidence_check.downgraded_count,
      evidence_rescans: aggregatedRawData.evidence_check.rescan_count,
    });

    validatePreSynthesisIntegrity(
      evidenceIntegrity,
      knowledgeIntegrity,
      sourceRegistry,
      sourcePackets,
      referenceKbIndex,
      aggregatedRawData,
      derivedAnalyticalEvidence,
    );
    serverLog(runId, 'info', 'pipeline_integrity_passed', {
      gate: 'pre_synthesis',
      domains: Object.keys(sourcePackets).length,
      criteria: aggregatedRawData.evidence_check.items.length,
      registry_hash: evidenceIntegrity.registry_hash,
      packet_manifest_hash: evidenceIntegrity.packet_manifest_hash,
      knowledge_hash: knowledgeIntegrity.index_hash,
    });

    const auditLogs = validateAndSanitizeLogs(aggregatedRawData);
    const phase1Validation = validatePhase1Output({ phase_1_audit_logs: auditLogs });
    if (!phase1Validation.valid) {
      throw new PipelineIntegrityError('ANALYSIS_OUTPUT_INCOMPLETE', 'pre_synthesis');
    }
    if (phase1Validation.warnings.length > 0) {
      console.warn(`[FinOps] Phase 1 validation produced ${phase1Validation.warnings.length} warning(s); content omitted by logging policy.`);
    }
    await checkpoint('phase1', 'accepted', {
      phase_1_audit_logs: auditLogs,
      evidence_check: aggregatedRawData.evidence_check,
      validation: phase1Validation,
    });

    const phase1Status = aggregatedRawData.evidence_check.failed || !phase1Validation.valid ? 'completed_with_warnings' : 'completed';
    emitProgress({ stage: 'analysis', status: phase1Status, completed: Object.keys(BATCH_DEFINITIONS).length, total: Object.keys(BATCH_DEFINITIONS).length });
    emitProgress({ stage: 'evidence', status: phase1Status, completed: Object.keys(BATCH_DEFINITIONS).length, total: Object.keys(BATCH_DEFINITIONS).length });

    emitProgress({ stage: 'calculation', status: 'in_progress' });
    await new Promise(r => setTimeout(r, 600));
    const validationData = calculateMetrics(auditLogs);
    const unresolvedDomainIds = new Set(validationData.verification_unresolved.map(item => item.charAt(1)));
    const overallScoreAvailable = validationData.verification_unresolved.length === 0;
    await checkpoint('phase2', 'accepted', { phase_2_validation: validationData });
    emitProgress({ stage: 'calculation', status: 'completed' });

    console.log(`[FinOps] Phase 2 Complete. Readiness: ${Math.round(validationData.metrics.finops_readiness)}%, Classification: ${validationData.crawl_walk_run}`);

    // Confidence bracket: drives which synthesis prompt runs.
    // LOW   → findings (no roadmap, no case studies)
    // MEDIUM → cautious (per-phase confidence + assumptions, hedged verbs)
    // HIGH  → directive (current behavior — full tactics, case studies)
    const confidenceBracket = aggregatedRawData.evidence_check.failed
      ? 'LOW'
      : bracketFromValidation(validationData);
    const bracketDetail = explainBracket(confidenceBracket, {
      evidence_density: validationData.metrics.evidence_density,
      delivery_integrity: validationData.metrics.delivery_integrity,
      silent_areas_count: validationData.silent_areas.length,
    });
    console.log(`[FinOps] [${runId}] Synthesis confidence: ${bracketDetail}`);
    serverLog(runId, 'info', 'synthesis_confidence', {
      bracket: confidenceBracket,
      evidence_density: Math.round(validationData.metrics.evidence_density),
      delivery_integrity: Math.round(validationData.metrics.delivery_integrity),
      silent_areas: validationData.silent_areas.length,
    });

    // Synthesis escalation decision (rules + user override).
    // Rules are conservative: only escalate to Opus 4.7 when the org is messy
    // enough that a deeper roadmap is worth the cost premium.
    const autoEscalate =
      (validationData.crawl_walk_run === 'Crawl' && validationData.antipattern_findings.length >= 5)
      || validationData.metrics.finops_readiness < 30
      || validationData.maturity_gaps.length >= 15
      || validationData.metrics.antipattern_burden > 70;
    const useEscalation = options.deepMode || autoEscalate;
    const synthesisStage = useEscalation ? 'synthesis_escalation' : 'synthesis';
    const escalationReason = options.deepMode
      ? 'user_deep_mode'
      : autoEscalate
        ? `auto:readiness=${Math.round(validationData.metrics.finops_readiness)},burden=${Math.round(validationData.metrics.antipattern_burden)},antipatterns=${validationData.antipattern_findings.length},gaps=${validationData.maturity_gaps.length},class=${validationData.crawl_walk_run}`
        : 'none';
    console.log(`[FinOps] [${runId}] Synthesis stage: ${synthesisStage} (${escalationReason})`);
    serverLog(runId, 'info', 'synthesis_routing', {
      stage: synthesisStage,
      reason_code: options.deepMode ? 'USER_DEEP_MODE' : autoEscalate ? 'AUTO_ESCALATION' : 'STANDARD',
      readiness: Math.round(validationData.metrics.finops_readiness),
      burden: Math.round(validationData.metrics.antipattern_burden),
      antipatterns: validationData.antipattern_findings.length,
      gaps: validationData.maturity_gaps.length,
      class: validationData.crawl_walk_run,
    });

    // Note: the previous "skip strategy on low evidence density" early-exit
    // is gone. Low-evidence runs are now handled by FINDINGS-mode synthesis
    // (bracket=LOW above), which produces an honest evidence + validation
    // report instead of a placeholder. The deterministic QG below still
    // emits BLOCK if evidence_density crosses the threshold, but the report
    // ships with real findings content.

    emitProgress({ stage: 'synthesis', status: 'in_progress' });
    const tacticsContext = await tacticsPromise;
    const referenceKbContext = await knowledgeBaseService.fetchReferenceKnowledgeBaseContext({
      maxDocChars: 650,
      label: 'phase3_strategy',
    });

    const definitionsContext = JSON.stringify(BATCH_DEFINITIONS, null, 2);
    const taxonomyContext = JSON.stringify(FINOPS_TAXONOMY_REGISTRY, null, 2);
    // Hard ID lookup at the TOP — prevents the model from confusing which
    // company goes with which tactic ID. See knowledge_base/index.ts for
    // the rationale. The prose case studies still follow below.
    const tacticIdTable = buildTacticIdTable();
    const fullSSOT = `=== TACTIC IDS — LOOKUP TABLE (use ONLY these IDs; never invent, abbreviate, or modify) ===
${tacticIdTable}

=== PART 1: TAXONOMY REGISTRY (INDEXING + KB USAGE BOUNDARIES) ===
${taxonomyContext}

=== PART 2: THE CRITERIA (DEFINITIONS) ===
${definitionsContext}

=== PART 3: REFERENCE KNOWLEDGE BASE (PDF RUBRICS + USAGE BOUNDARIES) ===
${referenceKbContext}

=== PART 4: THE PLAYBOOK (SOLUTIONS) ===
${tacticsContext}`;


    const handoffSummary = `
FINOPS DIAGNOSTIC REPORT SUMMARY (Computed by System):
-------------------------------------------------------
FinOps Maturity Score: ${overallScoreAvailable ? `${Math.round(validationData.metrics.finops_readiness)}/100` : 'UNAVAILABLE — required criterion verification is unresolved'}
Capability Attainment: ${Math.round(validationData.metrics.capability_attainment)}%
Anti-Pattern Control: ${Math.round(validationData.metrics.antipattern_control)}%
Maturity Classification: ${validationData.crawl_walk_run}
Maturity Depth Index: ${Math.round(validationData.metrics.maturity_depth)}%
Anti-Pattern Burden: ${Math.round(validationData.metrics.antipattern_burden)}%
Anti-Pattern Burden Confidence: ${validationData.metrics.antipattern_burden_confidence || 'unknown'}
Anti-Pattern Clearance: ${Math.round(validationData.metrics.antipattern_clearance)}%
Anti-Pattern Coverage: ${Math.round(validationData.metrics.antipattern_coverage)}%
Delivery Integrity: ${validationData.metrics.delivery_integrity}% (criteria the audit returned data for)
Evidence Density: ${validationData.metrics.evidence_density}% (criteria with verified source coverage, including quote-backed gaps)
${validationData.metrics.readiness_cap_reason ? `Readiness Cap: ${validationData.metrics.readiness_cap_reason}` : ''}
Anti-Pattern Findings: ${validationData.antipattern_findings.length}
Verified Anti-Pattern Absences: ${validationData.verified_antipattern_absences.length}
Unknown / Not-Assessable Anti-Pattern Absences: ${validationData.unknown_antipattern_absences.length}
Maturity Gaps: ${validationData.maturity_gaps.length}
Silent Areas: ${validationData.silent_areas.length}

UNRESOLVED REQUIRED VERIFICATION:
${validationData.verification_unresolved.join('\n') || 'None'}

SCORE EVIDENCE GAPS (zero score contribution; not proof a capability is absent):
${validationData.score_evidence_gaps.join('\n') || 'None'}

DOMAINS WITH INCOMPLETE SOURCE COVERAGE:
${weakDomainIds.join(', ') || 'None'}
Do not prescribe remediation for these domains. Limit them to evidence-collection steps under Safe To Act On.

CATEGORY BREAKDOWN:
${Object.entries(validationData.category_scores).map(([cat, score]) => unresolvedDomainIds.has(cat) ? `  ${cat}: verification unavailable (no validated domain score)` : `  ${cat}: ${score}/15`).join('\n')}
`;

    const compactLockedFindings = (strategy: any): string => JSON.stringify({
      executive_summaries: strategy?.executive_summaries || {},
      evidence_summary: strategy?.evidence_summary || null,
      diagnosis: strategy?.diagnosis || null,
      visual_scorecard: strategy?.visual_scorecard || null,
    }, null, 2);

    const buildSummaryCheckText = (strategy: any): string => {
      const summaries = strategy.executive_summaries && typeof strategy.executive_summaries === 'object'
        ? strategy.executive_summaries
        : { [DEFAULT_PERSONA]: strategy.executive_summary || '' };
      const summary = PERSONA_IDS
        .map(p => {
          const text = typeof summaries[p] === 'string' ? summaries[p] : '';
          return text ? `[Persona: ${p}]\n${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n---\n\n');
      const evidenceText = strategy.evidence_summary ? `\n\n[Evidence Summary]\n${JSON.stringify(strategy.evidence_summary)}` : '';
      const diagnosisText = strategy.diagnosis ? `\n\n[Diagnosis]\n${JSON.stringify(strategy.diagnosis)}` : '';
      return `${summary}${evidenceText}${diagnosisText}`;
    };

    const buildRoadmapCheckText = (strategy: any): string => {
      const planningText = strategy.planning_decision ? `\n\n[Planning Decision]\n${JSON.stringify(strategy.planning_decision)}` : '';
      return planningText.trim();
    };

    const buildRoadmapGroundingText = (roadmap: any[]): string => roadmap.map((phase: any) => {
      const actions = Array.isArray(phase?.actions) ? phase.actions : [];
      return [
        `[Phase] ${phase?.phase || 'Unnamed phase'}`,
        phase?.why ? `[WHY]\n${phase.why}` : '',
        phase?.what ? `[WHAT]\n${phase.what}` : '',
        actions.length > 0 ? `[HOW]\n${actions.map((action: string) => `- ${action}`).join('\n')}` : '[HOW]\n(no actions)'
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    const callStructuredSynthesis = async ({
      stage,
      substage,
      outputContract,
      systemInstruction,
      buildUserText,
      recordModel,
      validate,
      regenerated,
    }: {
      stage: Extract<StageId, 'synthesis' | 'synthesis_escalation' | 'roadmap_synthesis'>;
      substage: 'evidence_summary' | 'roadmap' | 'findings_mode';
      outputContract: string;
      systemInstruction: string;
      buildUserText: (formatRetry: boolean) => string;
      recordModel: (model: string) => void;
      validate?: (value: any) => boolean;
      regenerated: boolean;
    }): Promise<any> => {
      return withOneOutputRegeneration(async (formatRetry: boolean) => {
        const synthStarted = Date.now();
        const resp = await runStage(stage, {
          userText: buildUserText(formatRetry),
          systemInstruction,
          outputContract,
        }, { runId });
        const parsed = parseAiResponse(resp.text);
        if (validate && !validate(parsed)) throw Object.assign(new Error('INVALID_OUTPUT_CONTRACT'), { code: 'INVALID_OUTPUT_CONTRACT' });
        recordModel(resp.modelUsed.id);
        serverLog(runId, 'info', 'stage_complete', {
          stage,
          model: resp.modelUsed.id,
          substage,
          bracket: confidenceBracket,
          duration_ms: Date.now() - synthStarted,
          regen: regenerated || formatRetry ? 'yes' : 'no',
        });
        return parsed;
      }, () => serverLog(runId, 'warn', 'synthesis_output_retry', {
        stage,
        substage,
        reason_code: 'INVALID_OUTPUT_CONTRACT',
        retry: 1,
      }));
    };

    const callEvidenceSynthesis = async (correctionAppendix?: string): Promise<any> => {
      return callStructuredSynthesis({
        stage: synthesisStage,
        substage: 'evidence_summary',
        outputContract: OUTPUT_CONTRACT_IDS.evidenceSynthesis,
        systemInstruction: EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION,
        regenerated: Boolean(correctionAppendix),
        recordModel: model => { actuals.synthesis = model; },
        buildUserText: formatRetry => [
          EVIDENCE_SYNTHESIS_USER_PROMPT,
          `\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\nUse only these findings and the source document for summary and diagnosis:\n${handoffSummary}`,
          `\n\n### ORIGINAL SOURCE CONTEXT\n<SOURCE_DOCUMENT_TO_AUDIT>\n${text.substring(0, 50000)}\n</SOURCE_DOCUMENT_TO_AUDIT>`,
          confidenceBracket === 'LOW' ? '\n\n### LOW-CONFIDENCE OVERRIDE\nEvidence is LOW confidence. Keep diagnosis provisional, return low diagnostic confidence, and emphasize missing evidence rather than root-cause certainty.' : '',
          correctionAppendix || '',
          formatRetry ? '\n\n### OUTPUT CONTRACT CORRECTION\nThe previous provider chain did not return the required JSON object. Return only the schema-compliant evidence synthesis object without commentary.' : '',
        ].join(''),
      });
    };

    const callRoadmapSynthesis = async (lockedStrategy: any, correctionAppendix?: string): Promise<any> => {
      return callStructuredSynthesis({
        stage: 'roadmap_synthesis',
        substage: 'roadmap',
        outputContract: OUTPUT_CONTRACT_IDS.roadmapSynthesis,
        systemInstruction: ROADMAP_SYNTHESIS_SYSTEM_INSTRUCTION,
        regenerated: Boolean(correctionAppendix),
        recordModel: model => { actuals.roadmap_synthesis = model; },
        buildUserText: formatRetry => [
          ROADMAP_SYNTHESIS_USER_PROMPT,
          confidenceBracket === 'MEDIUM' ? ROADMAP_SYNTHESIS_PROMPT_CAUTIOUS_APPENDIX : '',
          confidenceBracket !== 'LOW' ? `\n\n### THE GOLDEN STANDARD (SSOT)\nYou may ONLY prescribe solutions found in this Knowledge Base. Use it for roadmap actions only; never alter locked findings from it:\n\n${fullSSOT}` : '',
          `\n\n### LOCKED FINDINGS JSON (IMMUTABLE)\n${compactLockedFindings(lockedStrategy)}`,
          `\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\n${handoffSummary}`,
          correctionAppendix || '',
          formatRetry ? '\n\n### OUTPUT CONTRACT CORRECTION\nThe previous provider chain did not return the required JSON object. Return only the schema-compliant roadmap object without commentary.' : '',
        ].join(''),
      });
    };

    const callFindingsSynthesis = async (correctionAppendix?: string): Promise<any> => {
      return callStructuredSynthesis({
        stage: synthesisStage,
        substage: 'findings_mode',
        outputContract: OUTPUT_CONTRACT_IDS.findingsSynthesis,
        systemInstruction: EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION,
        regenerated: Boolean(correctionAppendix),
        recordModel: model => { actuals.synthesis = model; },
        validate: value => validateFindingsModePayload(value).length === 0,
        buildUserText: formatRetry => [
          STRATEGY_USER_PROMPT_FINDINGS,
          `\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\nUse these findings to produce the findings-mode report:\n${handoffSummary}`,
          `\n\n### ORIGINAL SOURCE CONTEXT\n<SOURCE_DOCUMENT_TO_AUDIT>\n${text.substring(0, 50000)}\n</SOURCE_DOCUMENT_TO_AUDIT>`,
          correctionAppendix || '',
          formatRetry ? '\n\n### OUTPUT CONTRACT CORRECTION\nThe previous provider chain did not return the required findings-mode object. Return only the schema-compliant JSON object without commentary or invented evidence.' : '',
        ].join(''),
      });
    };

    const mergePhase3Outputs = (summary: any, roadmapData: any): any => {
      const roadmap = roadmapData?.phase_3_strategy || {};
      return {
        phase_3_strategy: {
          ...summary,
          planning_decision: roadmap.planning_decision,
          remediation_roadmap: Array.isArray(roadmap.remediation_roadmap) ? roadmap.remediation_roadmap : [],
          findings_mode: summary.findings_mode || roadmap.findings_mode,
        }
      };
    };

    const callPhase3 = async (correctionAppendix?: string): Promise<any> => {
      if (confidenceBracket === 'LOW') {
        return callFindingsSynthesis(correctionAppendix);
      }
      const summaryData = await callEvidenceSynthesis(correctionAppendix);
      const normalizedSummary = normalizeStrategy(summaryData)?.phase_3_strategy || summaryData?.phase_3_strategy || {};
      const roadmapData = await callRoadmapSynthesis(normalizedSummary, correctionAppendix);
      return mergePhase3Outputs(normalizedSummary, roadmapData);
    };

    const runFactCheck = async (data: any, attemptNumber: number, stage: Extract<StageId, 'fact_check' | 'fact_check_high'> = 'fact_check'): Promise<FactCheckResult> => {
      const strategy = data?.phase_3_strategy || {};
      const roadmap = strategy.remediation_roadmap || [];
      const roadmapText = buildRoadmapGroundingText(roadmap);
      try {
        const summaryPrompt = buildSummaryFactCheckPrompt({
          contentToCheck: buildSummaryCheckText(strategy),
          remediationRoadmapText: '',
          sourceDocument: text,
          phase1: auditLogs,
          phase2: validationData,
          imageCount: images.length,
        });
        const summaryStarted = Date.now();
        const summaryResp = await runStage(stage, {
          userText: summaryPrompt,
          images,
        }, { runId });
        actuals[stage] = summaryResp.modelUsed.id;
        serverLog(runId, 'info', 'stage_complete', {
          stage,
          model: summaryResp.modelUsed.id,
          substage: 'summary',
          duration_ms: Date.now() - summaryStarted,
          attempt: attemptNumber,
        });
        const summaryCheck = parseFactCheckResponse(summaryResp.text, attemptNumber, SUMMARY_FACT_CHECK_CONTRACT);

        const roadmapPrompt = buildRoadmapFactCheckPrompt({
          contentToCheck: buildRoadmapCheckText(strategy),
          remediationRoadmapText: roadmapText,
          lockedFindingsText: compactLockedFindings(strategy),
          sourceDocument: text,
          phase1: auditLogs,
          phase2: validationData,
          imageCount: images.length,
          tactics: FINOPS_TACTICS_LOCAL,
          tacticActivityPlaybook: FINOPS_TACTIC_ACTIVITY_PLAYBOOK,
        });
        const roadmapStarted = Date.now();
        const roadmapResp = await runStage(stage, {
          userText: roadmapPrompt,
          images,
        }, { runId });
        actuals[stage] = roadmapResp.modelUsed.id;
        serverLog(runId, 'info', 'stage_complete', {
          stage,
          model: roadmapResp.modelUsed.id,
          substage: 'roadmap',
          duration_ms: Date.now() - roadmapStarted,
          attempt: attemptNumber,
        });
        const roadmapCheck = parseFactCheckResponse(roadmapResp.text, attemptNumber, ROADMAP_FACT_CHECK_CONTRACT);
        return mergeRequiredFactChecks(summaryCheck, roadmapCheck, attemptNumber);
      } catch (e: any) {
        return {
          attempts: attemptNumber,
          total_claims: 0,
          supported_count: 0,
          unsupported_claims: [],
          failed: true,
          failure_reason: `Fact-check call failed: ${e?.message || e}`
        };
      }
    };

    const buildFallbackEvidenceSummary = () => ({
      headline: overallScoreAvailable
        ? `${validationData.crawl_walk_run} FinOps maturity with a ${Math.round(validationData.metrics.finops_readiness)}/100 evidence-sensitive score`
        : 'Overall FinOps maturity score unavailable because required verification is unresolved',
      maturity_classification: validationData.crawl_walk_run,
      key_metrics: [
        overallScoreAvailable
          ? `FinOps Maturity Score: ${Math.round(validationData.metrics.finops_readiness)}/100`
          : 'FinOps Maturity Score: unavailable — required verification is unresolved',
        `Capability attainment: ${Math.round(validationData.metrics.capability_attainment)}%`,
        `Anti-pattern control: ${Math.round(validationData.metrics.antipattern_control)}%`,
        `Maturity depth: ${Math.round(validationData.metrics.maturity_depth)}%`,
        `Anti-pattern burden: ${Math.round(validationData.metrics.antipattern_burden)}% (${validationData.metrics.antipattern_burden_confidence || 'unknown'} confidence)`,
        `Anti-pattern clearance: ${Math.round(validationData.metrics.antipattern_clearance)}%`,
        `Anti-pattern coverage: ${Math.round(validationData.metrics.antipattern_coverage)}%`,
        `Delivery integrity: ${Math.round(validationData.metrics.delivery_integrity)}%`,
        `Evidence density: ${Math.round(validationData.metrics.evidence_density)}%`,
        ...(validationData.metrics.readiness_cap_reason ? [validationData.metrics.readiness_cap_reason] : [])
      ],
      confirmed_strengths: Object.entries(validationData.category_scores)
        .filter(([cat, score]) => !unresolvedDomainIds.has(cat) && score >= 10)
        .map(([cat, score]) => `Domain ${cat} shows relatively strong maturity signal (${score}/15).`),
      confirmed_gaps: validationData.maturity_gaps.slice(0, 8),
      confirmed_antipatterns: validationData.antipattern_findings.slice(0, 8),
      silent_or_missing_evidence: [
        ...validationData.verification_unresolved,
        ...validationData.silent_areas,
        ...validationData.unknown_antipattern_absences
      ].slice(0, 8)
    });

    const buildFallbackDiagnosis = () => ({
      primary_bottleneck: validationData.maturity_gaps[0] || validationData.antipattern_findings[0] || 'No single bottleneck dominated the validated audit output.',
      root_causes: [
        ...validationData.maturity_gaps.slice(0, 3),
        ...validationData.antipattern_findings.slice(0, 3)
      ].slice(0, 5),
      domain_diagnosis: Object.fromEntries(
        Object.entries(validationData.category_scores).map(([cat, score]) => [cat, unresolvedDomainIds.has(cat)
          ? `Verification was unavailable in domain ${cat}; scanner candidates were excluded and no validated domain score is reported.`
          : `Maturity signal ${score}/15 in domain ${cat}.`])
      ),
      confidence: confidenceBracket === 'HIGH' ? 'high' : confidenceBracket === 'MEDIUM' ? 'medium' : 'low',
      confidence_rationale: bracketDetail
    });

    const buildFallbackPlanningDecision = () => ({
      decision: confidenceBracket === 'LOW' ? 'NO_GO' : confidenceBracket === 'MEDIUM' ? 'CONDITIONAL_GO' : 'GO',
      rationale: confidenceBracket === 'LOW'
        ? 'Evidence is not strong enough for a directive roadmap; gather missing source material first.'
        : confidenceBracket === 'MEDIUM'
          ? 'Use high-confidence actions first and validate assumptions before scaling later phases.'
          : 'Evidence supports a directive roadmap subject to the Quality Gate result.',
      safe_to_act_on: confidenceBracket === 'LOW'
        ? ['Collect missing evidence listed in the findings report.', 'Validate candidate remediation themes before execution.']
        : ['Act on roadmap phases that cite validated findings and valid tactic IDs.'],
      evidence_needed_before_action: validationData.silent_areas.slice(0, 6)
    });

    const buildFallbackFindingsMode = () => ({
      evidence_backed_findings: [
        ...validationData.maturity_gaps.slice(0, 4),
        ...validationData.antipattern_findings.slice(0, 2),
        ...validationData.verified_antipattern_absences.slice(0, 2)
      ].slice(0, 8),
      candidate_themes: validationData.silent_areas.length > 0
        ? validationData.silent_areas.slice(0, 6)
        : validationData.maturity_gaps.slice(0, 6),
      missing_evidence: [
        ...validationData.silent_areas,
        ...validationData.unknown_antipattern_absences
      ].slice(0, 8),
      validation_plan: [
        'Provide source material that documents current FinOps ownership, cadence, and decision rights.',
        'Attach evidence of tagging, allocation, budget, and forecasting practices.',
        'Include recent cost review outputs or optimization decision records before rerunning the assessment.'
      ]
    });

    const buildDeterministicLowConfidenceStrategy = () => {
      const outcome = `The assessment completed deterministic acquisition and analysis, but evidence density was ${Math.round(validationData.metrics.evidence_density)}% and ${validationData.silent_areas.length} criteria remained silent. This supports a blocking decision, not a directive summary or roadmap.`;
      const boundary = 'Decision: NO_GO. No remediation roadmap is issued. Gather the missing evidence identified below, validate the candidate themes, and rerun the assessment before authorizing implementation.';
      return {
        phase_3_strategy: {
          executive_summaries: {
            finops_lead: `${outcome}\n\n${boundary}`,
            cfo: `${outcome}\n\nThe available evidence is insufficient to support investment prioritization or claimed financial outcomes. ${boundary}`,
            engineering_lead: `${outcome}\n\nThe available evidence is insufficient to prescribe engineering controls or operating changes. ${boundary}`,
          },
          executive_summary: `${outcome}\n\n${boundary}`,
          active_persona: DEFAULT_PERSONA,
          evidence_summary: buildFallbackEvidenceSummary(),
          diagnosis: buildFallbackDiagnosis(),
          planning_decision: buildFallbackPlanningDecision(),
          visual_scorecard: {
            headline: 'Insufficient Evidence — Findings Only',
            maturity_score: overallScoreAvailable
              ? `${Math.round(validationData.metrics.finops_readiness)}/100 evidence-sensitive maturity`
              : 'Unavailable — required verification is unresolved',
            burden_score: `${Math.round(validationData.metrics.antipattern_burden)}% anti-pattern burden`,
          },
          remediation_roadmap: [],
          findings_mode: buildFallbackFindingsMode(),
          confidence_bracket: 'LOW',
        },
      };
    };

    const normalizeStrategy = (raw: any): any => {
      if (!raw?.phase_3_strategy) return raw;
      const normalized = normalizePersonaSummaries(raw.phase_3_strategy);
      const incomingPlanningDecision = raw.phase_3_strategy.planning_decision;
      const incomingDiagnosis = raw.phase_3_strategy.diagnosis;
      const normalizedPlanningDecision = confidenceBracket === 'LOW'
        ? incomingPlanningDecision?.decision === 'NO_GO'
          ? incomingPlanningDecision
          : buildFallbackPlanningDecision()
        : incomingPlanningDecision || buildFallbackPlanningDecision();
      raw.phase_3_strategy = {
        ...raw.phase_3_strategy,
        executive_summaries: normalized.executive_summaries,
        executive_summary: normalized.executive_summary,
        active_persona: normalized.active_persona,
        evidence_summary: raw.phase_3_strategy.evidence_summary?.headline ? raw.phase_3_strategy.evidence_summary : buildFallbackEvidenceSummary(),
        diagnosis: typeof incomingDiagnosis?.primary_bottleneck === 'string' && incomingDiagnosis.primary_bottleneck.trim().length > 0
          ? { ...incomingDiagnosis, primary_bottleneck: incomingDiagnosis.primary_bottleneck.trim() }
          : buildFallbackDiagnosis(),
        planning_decision: normalizedPlanningDecision,
        remediation_roadmap: confidenceBracket === 'LOW' ? [] : (raw.phase_3_strategy.remediation_roadmap || []),
        confidence_bracket: confidenceBracket,
        findings_mode: confidenceBracket === 'LOW'
          ? raw.phase_3_strategy.findings_mode || buildFallbackFindingsMode()
          : raw.phase_3_strategy.findings_mode
      };
      return sanitizeEvidenceSummaryUncertainty(raw);
    };

    // Wrap callPhase3 with a deterministic ID-validity gate. Before any
    // fact-check spend, we extract all [TAC-...] references and verify each
    // exists in the DB. Invalid IDs trigger a targeted regen with the full
    // valid-ID list. Catches structural failures the LLM-based fact-check
    // sometimes misses, and avoids burning fact-check tokens on output with
    // obvious tactic-ID errors.
    const validIds = validTacticIdSet();
    let tacticGroundingWarnings: string[] = [];
    let tacticGroundingAdjustments: TacticGroundingAdjustment[] = [];
    const callPhase3Validated = async (correctionAppendix?: string): Promise<any> => {
      let data = normalizeStrategy(await callPhase3(correctionAppendix));
      let invalid = findInvalidTacticIds(data, validIds);
      let regen = 0;
      while (invalid.length > 0 && regen < ID_VALIDATION_MAX_REGENS) {
        regen++;
        console.warn(`[FinOps] [${runId}] Strategy cites ${invalid.length} invalid tactic ID(s); regen ${regen}/${ID_VALIDATION_MAX_REGENS}.`);
        serverLog(runId, 'warn', 'invalid_tactic_ids', {
          invalid_count: invalid.length,
          regen,
        });
        const idAppendix = buildInvalidIdAppendix(invalid, validIds);
        const combined = correctionAppendix ? `${correctionAppendix}\n\n${idAppendix}` : idAppendix;
        data = normalizeStrategy(await callPhase3(combined));
        invalid = findInvalidTacticIds(data, validIds);
      }
      if (invalid.length > 0) {
        console.error(`[FinOps] [${runId}] Strategy still contains ${invalid.length} invalid tactic ID(s) after ${ID_VALIDATION_MAX_REGENS} regens.`);
        serverLog(runId, 'error', 'invalid_tactic_ids_persisted', {
          invalid_count: invalid.length,
        });
      }
      const grounding = sanitizeRoadmapTacticGrounding(data, validationData, weakDomainIds);
      tacticGroundingWarnings = grounding.warnings;
      tacticGroundingAdjustments = grounding.adjustments;
      if (grounding.adjustments.length > 0) {
        console.warn(`[FinOps] [${runId}] Roadmap tactic grounding adjusted ${grounding.adjustments.length} tactic reference(s) before fact-check.`);
        serverLog(runId, 'warn', 'roadmap_tactic_grounding_adjusted', {
          adjustments: grounding.adjustments.length,
          tactic_ids: grounding.adjustments.map(a => a.tactic_id).join(','),
        });
      }
      return grounding.strategyData;
    };

    const trajectory: FactCheckPassSnapshot[] = [];
    const snapshot = (fc: FactCheckResult): FactCheckPassSnapshot => ({
      attempt: fc.attempts,
      total_claims: fc.total_claims,
      supported_count: fc.supported_count,
      unsupported_count: fc.unsupported_claims.length,
      unsupported_signatures: fc.unsupported_claims.map(c => c.claim.substring(0, 80)),
    });

    let strategyData: any;
    let deterministicSynthesisFallback = false;
    if (validationData.metrics.evidence_density < EVIDENCE_DENSITY_BLOCK) {
      deterministicSynthesisFallback = true;
      strategyData = buildDeterministicLowConfidenceStrategy();
      serverLog(runId, 'warn', 'synthesis_deterministic_fallback', {
        stage: synthesisStage,
        reason_code: 'EVIDENCE_DENSITY_BELOW_FLOOR',
        evidence_density: Math.round(validationData.metrics.evidence_density),
        silent_areas: validationData.silent_areas.length,
      });
    } else {
      try {
        strategyData = await callPhase3Validated();
      } catch (error: any) {
        if (confidenceBracket !== 'LOW') throw error;
        deterministicSynthesisFallback = true;
        strategyData = buildDeterministicLowConfidenceStrategy();
        serverLog(runId, 'warn', 'synthesis_deterministic_fallback', {
          stage: synthesisStage,
          reason_code: typeof error?.code === 'string' ? error.code : 'SYNTHESIS_UNAVAILABLE',
          evidence_density: Math.round(validationData.metrics.evidence_density),
          silent_areas: validationData.silent_areas.length,
        });
      }
    }
    await checkpoint('synthesis', 'accepted', { phase_3_strategy: strategyData.phase_3_strategy });
    emitProgress({ stage: 'synthesis', status: deterministicSynthesisFallback ? 'completed_with_warnings' : 'completed' });
    emitProgress({ stage: 'verification', status: 'in_progress' });
    let factCheck = await runFactCheck(strategyData, 1);
    await checkpoint('fact_check', 'pass_1', { fact_check: factCheck });
    let lastUnsupported: FactCheckClaim[] = factCheck.unsupported_claims;
    if (!factCheck.failed) trajectory.push(snapshot(factCheck));

    let attempt = 1;
    while (
      !factCheck.failed &&
      lastUnsupported.length > 0 &&
      attempt <= FACT_CHECK_MAX_RETRIES
    ) {
      console.log(`[FinOps] Fact-check pass ${attempt}: ${lastUnsupported.length} unsupported claims, regenerating...`);
      try {
        const candidateStrategy = await callPhase3Validated(buildRegenerateAppendix(lastUnsupported));
        const candidateAttempt = attempt + 1;
        const candidateFactCheck = await runFactCheck(candidateStrategy, candidateAttempt);
        await checkpoint('fact_check', `pass_${candidateAttempt}`, { fact_check: candidateFactCheck });
        attempt = candidateAttempt;
        if (candidateFactCheck.failed) {
          serverLog(runId, 'warn', 'synthesis_candidate_rejected', { attempt, reason_code: 'FACT_CHECK_FAILED' });
          break;
        }
        strategyData = candidateStrategy;
        factCheck = candidateFactCheck;
        lastUnsupported = factCheck.unsupported_claims;
        trajectory.push(snapshot(factCheck));
        await checkpoint('synthesis', 'accepted', { phase_3_strategy: strategyData.phase_3_strategy });
      } catch (error: any) {
        serverLog(runId, 'warn', 'synthesis_candidate_rejected', {
          attempt: attempt + 1,
          reason_code: typeof error?.code === 'string' ? error.code : 'SYNTHESIS_REGENERATION_FAILED',
        });
        break;
      }
    }

    factCheck.trajectory = trajectory;

    if (factCheck.failed) {
      console.warn('[FinOps] Fact-check unavailable; failure details retained in the governed result, not operational logs.');
    } else {
      console.log(`[FinOps] Fact-check complete after ${factCheck.attempts} pass(es): ${factCheck.supported_count}/${factCheck.total_claims} claims supported, ${lastUnsupported.length} unsupported.`);
      if (trajectory.length > 1) {
        const traj = trajectory.map(p => `pass${p.attempt}:${p.supported_count}/${p.total_claims}supp,${p.unsupported_count}unsupp`).join(' → ');
        console.log(`[FinOps] [${runId}] Fact-check trajectory: ${traj}`);
        serverLog(runId, 'info', 'fact_check_trajectory', { trajectory: traj, passes: trajectory.length });
      }
    }

    const applySanitation = (data: any, fc: FactCheckResult, event: string = 'strategy_sanitized') => {
      const sanitation = sanitizeStrategyAfterFactCheck(data, fc);
      if (sanitation.sanitized.length > 0) {
        const removed = sanitation.sanitized.filter(i => i.action === 'removed').length;
        const rewritten = sanitation.sanitized.filter(i => i.action === 'rewritten').length;
        const quarantined = sanitation.sanitized.filter(i => i.action === 'quarantined').length;
        console.warn(`[FinOps] [${runId}] Strategy sanitation handled ${sanitation.sanitized.length} unsupported item(s): removed=${removed}, rewritten=${rewritten}, quarantined=${quarantined}.`);
        serverLog(runId, 'warn', event, {
          total: sanitation.sanitized.length,
          removed,
          rewritten,
          quarantined,
          remaining_unsupported: sanitation.factCheck.unsupported_claims.length,
        });
      }
      return sanitation;
    };

    let sanitation = applySanitation(strategyData, factCheck, 'claims_sanitized');
    strategyData = sanitation.strategyData;
    factCheck = sanitation.factCheck;


    let groundingValidation = validatePhase3Grounding(strategyData, validationData, text);
    groundingValidation.warnings.push(...tacticGroundingWarnings);
    if (groundingValidation.errors.length > 0) {
      console.error(`[FinOps] Phase 3 grounding produced ${groundingValidation.errors.length} error(s); content omitted by logging policy.`);
    }
    if (groundingValidation.warnings.length > 0) {
      console.warn(`[FinOps] Phase 3 grounding produced ${groundingValidation.warnings.length} warning(s); content omitted by logging policy.`);
    }

    let qualityGate = runQualityGate(auditLogs, validationData, phase1Validation, groundingValidation, aggregatedRawData.evidence_check, factCheck, sourceRegistryStatus);
    const factCheckOnlyBlock = qualityGate.decision === 'BLOCK'
      && qualityGate.blocking_reasons.length > 0
      && qualityGate.blocking_reasons.every(reason => reason.startsWith('Fact-check:'));
    if (factCheckOnlyBlock && !factCheck.failed) {
      serverLog(runId, 'warn', 'fact_check_escalated', {
        from_stage: 'fact_check',
        to_stage: 'fact_check_high',
        medium_attempts: factCheck.attempts,
        blocking_reasons: qualityGate.blocking_reasons.length,
      });
      const highFactCheck = await runFactCheck(strategyData, factCheck.attempts + 1, 'fact_check_high');
      await checkpoint('fact_check', 'escalated', { fact_check: highFactCheck });
      if (!highFactCheck.failed) {
        highFactCheck.trajectory = [...(factCheck.trajectory || []), snapshot(highFactCheck)];
        sanitation = applySanitation(strategyData, highFactCheck, 'claims_quarantined');
        strategyData = sanitation.strategyData;
        factCheck = sanitation.factCheck;
        groundingValidation = validatePhase3Grounding(strategyData, validationData, text);
        groundingValidation.warnings.push(...tacticGroundingWarnings);
        qualityGate = runQualityGate(auditLogs, validationData, phase1Validation, groundingValidation, aggregatedRawData.evidence_check, factCheck, sourceRegistryStatus);
      }
      serverLog(runId, highFactCheck.failed ? 'warn' : 'info', 'fact_check_escalation_result', {
        ok: !highFactCheck.failed,
        decision: qualityGate.decision,
        model: actuals.fact_check_high,
        supported: highFactCheck.supported_count,
        total: highFactCheck.total_claims,
        unsupported: highFactCheck.unsupported_claims.length,
        ...(highFactCheck.failed ? { error_code: 'FACT_CHECK_FAILED' } : {}),
      });
    }
    console.log(`[FinOps] [${runId}] Quality Gate decision: ${qualityGate.decision}`);
    if (qualityGate.decision === 'WARN' && strategyData?.phase_3_strategy?.planning_decision?.decision === 'GO') {
      const decision = strategyData.phase_3_strategy.planning_decision;
      decision.decision = 'CONDITIONAL_GO';
      decision.rationale = `${decision.rationale || 'The grounded roadmap may proceed with review.'} Quality Gate warnings must be resolved or explicitly accepted before scaling implementation.`;
      decision.evidence_needed_before_action = Array.from(new Set([
        ...(decision.evidence_needed_before_action || []),
        ...qualityGate.warnings.filter(warning => warning.startsWith('Source routing coverage')),
      ]));
    }
    applyQualityGateScoreCap(validationData, qualityGate.decision);
    await checkpoint('phase2', 'accepted', { phase_2_validation: validationData });

    // LLM-augmented explanation only when the deterministic gate flagged
    // something. GO results don't need narrative — the metrics speak for them.
    if (qualityGate.decision !== 'GO') {
      const qgExplainStarted = Date.now();
      const explanation = await runQualityGateExplanation(qualityGate, text, { runId });
      qualityGate.llm_explanation = explanation;
      serverLog(runId, explanation.failed ? 'warn' : 'info', 'qg_explanation', {
        decision: qualityGate.decision,
        model: explanation.model_used || 'n/a',
        duration_ms: Date.now() - qgExplainStarted,
        ok: !explanation.failed,
        ...(explanation.failed ? { error_code: 'QUALITY_GATE_EXPLANATION_FAILED' } : {}),
      });
    }

    // Stamp the strategy with the bracket synthesis ran in, plus the effective
    // bracket the UI should render against. A post-fact-check QG=BLOCK downgrades
    // any directive/cautious run to LOW for display purposes — case studies and
    // directive language stay hidden when confidence collapsed after generation.
    const effectiveBracket = qualityGate.decision === 'BLOCK' ? 'LOW' : confidenceBracket;
    if (strategyData?.phase_3_strategy && typeof strategyData.phase_3_strategy === 'object') {
      strategyData.phase_3_strategy.confidence_bracket = confidenceBracket;
      strategyData.phase_3_strategy.effective_bracket = effectiveBracket;
    }
    if (qualityGate.decision === 'BLOCK') {
      strategyData = sanitizeBlockedStrategy(strategyData, qualityGate.blocking_reasons, {
        evidenceDensity: validationData.metrics.evidence_density,
        evidenceCheckCompleted: !aggregatedRawData.evidence_check.failed,
        scoreEvidenceGaps: validationData.score_evidence_gaps,
      });
    }
    if (strategyData?.phase_3_strategy?.visual_scorecard) {
      strategyData.phase_3_strategy.visual_scorecard.maturity_score =
        overallScoreAvailable
          ? `${Math.round(validationData.metrics.finops_readiness)}/100 evidence-sensitive maturity`
          : 'Unavailable — required verification is unresolved';
    }
    if (qualityGate.decision === 'BLOCK' && strategyData?.phase_3_strategy?.evidence_summary) {
      const summary = strategyData.phase_3_strategy.evidence_summary;
      summary.headline = overallScoreAvailable
        ? `BLOCKED assessment · FinOps Maturity Score ${Math.round(validationData.metrics.finops_readiness)}/100`
        : 'BLOCKED assessment · Overall FinOps Maturity Score unavailable because required verification is unresolved';
      summary.key_metrics = [
        overallScoreAvailable
          ? `FinOps Maturity Score: ${Math.round(validationData.metrics.finops_readiness)}/100`
          : 'FinOps Maturity Score: unavailable — required verification is unresolved',
        `Capability attainment: ${Math.round(validationData.metrics.capability_attainment)}%`,
        `Anti-pattern control: ${Math.round(validationData.metrics.antipattern_control)}%`,
        ...(validationData.metrics.quality_gate_score_cap_reason ? [validationData.metrics.quality_gate_score_cap_reason] : []),
        ...((summary.key_metrics || []).filter((metric: string) => !/maturity score|readiness|capability attainment|anti-pattern control/i.test(metric))),
      ];
    }
    if (effectiveBracket !== confidenceBracket) {
      console.warn(`[FinOps] [${runId}] Strategy downgraded by QG: ${confidenceBracket} → ${effectiveBracket} (decision=${qualityGate.decision})`);
      serverLog(runId, 'warn', 'strategy_downgraded', {
        from: confidenceBracket,
        to: effectiveBracket,
        decision: qualityGate.decision,
      });
    }
    await checkpoint('quality_gate', 'accepted', {
      quality_gate: qualityGate,
      phase_3_strategy: strategyData.phase_3_strategy,
    });

    emitProgress({ stage: 'verification', status: qualityGate.decision === 'GO' ? 'completed' : 'completed_with_warnings' });
    emitProgress({ stage: 'finalization', status: 'in_progress' });

    const fallbackStrategy = {
      executive_summary: "Strategy incomplete.",
      executive_summaries: {
        finops_lead: "Strategy incomplete.",
        cfo: "Strategy incomplete.",
        engineering_lead: "Strategy incomplete."
      },
      active_persona: DEFAULT_PERSONA,
      evidence_summary: buildFallbackEvidenceSummary(),
      diagnosis: buildFallbackDiagnosis(),
      planning_decision: buildFallbackPlanningDecision(),
      visual_scorecard: { headline: "Error", maturity_score: "N/A", burden_score: "N/A" },
      remediation_roadmap: []
    };
    const resolvedStrategy = strategyData.phase_3_strategy || fallbackStrategy;
    const finalStrategy = qualityGate.decision === 'BLOCK'
      ? sanitizeBlockedStrategy({ phase_3_strategy: resolvedStrategy }, qualityGate.blocking_reasons, {
        evidenceDensity: validationData.metrics.evidence_density,
        evidenceCheckCompleted: !aggregatedRawData.evidence_check.failed,
        scoreEvidenceGaps: validationData.score_evidence_gaps,
      }).phase_3_strategy
      : resolvedStrategy;

    let finalResult: DiagnosticResult = {
      meta: {
        run_id: runId,
        document_analyzed: "Uploaded Text",
        timestamp: new Date().toISOString(),
        engine_version: ENGINE_VERSION,
        source_parse_warnings: sourceParseWarnings.length > 0 ? sourceParseWarnings : undefined,
        source_registry: sourceRegistryStatus,
        knowledge_base: referenceKbIndex.status,
        evidence_privacy: privacy.decision,
        model_mode: modelRoutingMode,
        model_routing_policy_version: modelRouting.policy_version,
        primary_model_provider: modelRouting.primary_provider,
        fallback_model_provider: modelRouting.fallback_provider,
        model_config: {
          forensic_audit: actuals.forensic_audit,
          targeted_rescan: actuals.targeted_rescan,
          evidence_check: actuals.evidence_check,
          evidence_adjudication: actuals.evidence_adjudication,
          synthesis: actuals.synthesis,
          roadmap_synthesis: actuals.roadmap_synthesis,
          fact_check: actuals.fact_check,
          fact_check_high: actuals.fact_check_high,
          validators: "deterministic"
        }
      },
      phase_1_audit_logs: auditLogs,
      evidence_check: aggregatedRawData.evidence_check,
      phase_2_validation: validationData,
      phase_3_strategy: finalStrategy,
      quality_gate: qualityGate
    };
    const runTrace = buildRunTrace({
      runId,
      engineVersion: ENGINE_VERSION,
      sourceRegistry,
      sourcePackets,
      evidenceStagePackets,
      dlpScan,
      dlpReviewChunkCount: 0,
      referenceKbIndex,
      stageTraces: consumeStageTraces(runId),
      auditLogs,
      evidenceCheck: aggregatedRawData.evidence_check,
      phase2: validationData,
      strategy: finalResult.phase_3_strategy,
      qualityGate,
      tacticGroundingAdjustments,
      derivedAnalyticalEvidence,
      tableInspections,
      dataSignalCoverage,
      boundedRetrieval,
      semanticGapRetrieval: aggregatedRawData.semantic_gap_retrieval
    });
    finalResult.meta.run_trace = runTrace;
    finalResult.meta.run_trace_summary = summarizeRunTrace(runTrace);
    const acquisitionQuality = buildAcquisitionQualitySnapshot({
      logs: auditLogs,
      phase2: validationData,
      sourceRegistry: sourceRegistryStatus,
      knowledgeBase: referenceKbIndex.status,
      runTrace
    });
    finalResult.meta.acquisition_quality = acquisitionQuality;
    finalResult = scrubDiagnosticResultForPrivacy(finalResult, { redactPersonNames: true }).result;
    await checkpoint('final_report', 'ready_for_delivery', { result: finalResult });
    completionIntent = true;
    await readyRun(
      runId,
      acquisitionQualityPersistence(acquisitionQuality, sourceRegistryStatus),
      shadowTelemetryPersistence(boundedRetrieval, derivedAnalyticalEvidence, dataSignalCoverage)
    );
    const totalDuration = Date.now() - pipelineStarted;
    console.log(`[FinOps] [${runId}] === Pipeline complete === duration_ms=${totalDuration} quality_gate=${qualityGate.decision} bracket=${effectiveBracket}`);
    serverLog(runId, 'info', 'pipeline_complete', {
      outcome: 'ok',
      duration_ms: totalDuration,
      quality_gate: qualityGate.decision,
      bracket: effectiveBracket,
      synthesis_bracket: confidenceBracket,
      fact_check_supported: factCheck.supported_count,
      fact_check_total: factCheck.total_claims,
      models: actuals,
      model_mode: modelRoutingMode,
    });
    emitProgress({ stage: 'finalization', status: 'completed' });
    return finalResult;

  } catch (error: any) {
    for (const stage of activeProgressStages) onProgress({ stage, status: 'failed' });
    clearStageTraces(runId);
    const integrityError = error instanceof PipelineIntegrityError ? error : null;
    const errorCode = integrityError?.code || (error?.code === 'SYNTHESIS_OUTPUT_INVALID' ? error.code : 'PIPELINE_FAILED');
    if (!completionIntent) {
      if (hasRecoverableCheckpoint) await suspendRun(runId, errorCode).catch(() => undefined);
      else await failRun(runId, errorCode).catch(() => undefined);
    }
    else {
      const authoritative = await getRun(runId).catch(() => null);
      if (authoritative?.state === 'active') await suspendRun(runId, errorCode).catch(() => undefined);
    }
    const duration = Date.now() - pipelineStarted;
    if (integrityError) {
      serverLog(runId, 'error', 'pipeline_integrity_failed', {
        gate: integrityError.gate,
        error_code: integrityError.code,
        domains: integrityError.domains.join(',') || 'none',
      });
    }
    console.error(`[FinOps] [${runId}] === Pipeline FAILED === duration_ms=${duration} error_code=${errorCode}`);
    serverLog(runId, 'error', 'pipeline_failed', {
      duration_ms: duration,
      error_code: errorCode,
      models: actuals,
      model_mode: modelRoutingMode,
    });
    throw error;
  }
};
