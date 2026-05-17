
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
import { knowledgeBaseService, BATCH_DEFINITIONS, FINOPS_TACTICS_LOCAL, FINOPS_TAXONOMY_REGISTRY, buildTacticIdTable, validTacticIdSet } from "../knowledge_base";
import { DiagnosticResult, Phase1AuditLogs, Phase2Validation, AuditItem, EvidenceQuote, EvidenceCategory, EVIDENCE_CATEGORIES, PersonaId, PERSONA_IDS, ImageInput } from "../types";
import { generateSafetyAuditPrompt } from "./securityService";
import { validatePhase1Output, validatePhase3Grounding } from "./validatorService";
import { runQualityGate, runQualityGateExplanation } from "./qualityGateService";
import { calculateMetrics } from "./metricsService";
import {
  buildRegenerateAppendix,
  buildRoadmapFactCheckPrompt,
  buildSummaryFactCheckPrompt,
  parseFactCheckResponse
} from "./factCheckService";
import { FactCheckClaim, FactCheckResult, FactCheckPassSnapshot } from "../types";
import { STAGE_MODELS } from "../models";
import { runStage, serverLog, newRunId } from "./modelRouter";
import { sanitizeRoadmapTacticGrounding } from "./tacticGroundingService";

const FACT_CHECK_MAX_RETRIES = 2;
const ID_VALIDATION_MAX_REGENS = 2;

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

const ALL_CRITERIA_IDS = [
  'A1', 'A2', 'A3', 'A4', 'A5',
  'B1', 'B2', 'B3', 'B4', 'B5',
  'C1', 'C2', 'C3', 'C4', 'C5',
  'D1', 'D2', 'D3', 'D4', 'D5',
  'E1', 'E2', 'E3', 'E4', 'E5'
];

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
  if (!text) return {};
  let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[FinOps Pipeline] AI Response contained no JSON braces.");
    return {};
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("[FinOps Pipeline] JSON Parse Error:", text.substring(0, 500));
    throw new Error("AI response was malformed and could not be repaired safely.");
  }
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

    if (Array.isArray(item.evidence_quotes)) {
      safeItem.evidence_quotes = item.evidence_quotes
        .filter((q: any) => q && typeof q === 'object' && typeof q.quote === 'string')
        .map((q: any): EvidenceQuote => ({
          quote: q.quote,
          source_document: typeof q.source_document === 'string' ? q.source_document : undefined,
          section: typeof q.section === 'string' ? q.section : undefined,
          category: EVIDENCE_CATEGORIES.includes(q.category) ? q.category as EvidenceCategory : undefined,
          evidence_source: q.evidence_source === 'image' ? 'image' : 'text',
          page_number: typeof q.page_number === 'number' && q.page_number > 0 ? q.page_number : undefined
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
}

export const analyzeDocument = async (
  text: string,
  images: ImageInput[],
  onProgress: (stage: 'audit' | 'calc' | 'strategy', progress?: number) => void,
  options: AnalyzeOptions = {}
): Promise<DiagnosticResult> => {
  const runId = newRunId();
  const pipelineStarted = Date.now();
  const actuals: Record<string, string> = {
    preflight: STAGE_MODELS.preflight.id,
    forensic_audit: STAGE_MODELS.forensic_audit.id,
    evidence_check: STAGE_MODELS.evidence_check.id,
    synthesis: STAGE_MODELS.synthesis.id,
    fact_check: STAGE_MODELS.fact_check.id,
  };

  console.log(`[FinOps] === Pipeline start === run=${runId} deepMode=${!!options.deepMode}`);
  serverLog(runId, 'info', 'pipeline_start', {
    text_chars: text.length,
    image_count: images.length,
    image_kb: Math.round(images.reduce((s, i) => s + i.data.length, 0) / 1024),
    deep_mode: !!options.deepMode,
    preflight: STAGE_MODELS.preflight.id,
    forensic_audit: STAGE_MODELS.forensic_audit.id,
    evidence_check: STAGE_MODELS.evidence_check.id,
    synthesis: STAGE_MODELS.synthesis.id,
    fact_check: STAGE_MODELS.fact_check.id,
  });

  try {
    const imagePayloadBytes = images.reduce((sum, img) => sum + img.data.length, 0);
    if (images.length > 0) {
      console.log(`[FinOps] Multimodal: ${images.length} image(s), ~${Math.round(imagePayloadBytes / 1024)} KB base64 payload.`);
    }

    console.log(`[FinOps] [${runId}] Running Security Pre-Flight (DLP)...`);
    onProgress('audit', 1);
    const dlpPrompt = generateSafetyAuditPrompt(text, images);

    const dlpStarted = Date.now();
    const dlpResponse = await runStage('preflight', {
      userText: dlpPrompt,
      images,
    }, { runId });
    actuals.preflight = dlpResponse.modelUsed.id;
    serverLog(runId, 'info', 'stage_complete', {
      stage: 'preflight',
      model: dlpResponse.modelUsed.id,
      duration_ms: Date.now() - dlpStarted,
    });
    const dlpResult = parseAiResponse(dlpResponse.text);

    if (dlpResult && dlpResult.safe === false) {
      throw new Error(`Security Alert: Document rejected due to ${dlpResult.risk_detected} content. (${dlpResult.reason})`);
    }
    console.log("[FinOps] DLP Scan Passed.");

    console.log("[FinOps] Pre-fetching Tactics Database for Phase 3...");
    const tacticsPromise = knowledgeBaseService.fetchStrategicPlaybook();

    onProgress('audit', 5);
    console.log(`[FinOps] [${runId}] Running Phase 1 Parallel Audit (5 batches)...`);
    const phase1Started = Date.now();
    const aggregatedRawData = await runPhase1Audit(text, images, (completed, total) => {
      onProgress('audit', Math.round((completed / total) * 100));
    }, { runId });
    if (aggregatedRawData.models_used.length > 0) {
      actuals.forensic_audit = aggregatedRawData.models_used.join(',');
    }
    if (aggregatedRawData.evidence_check_models_used.length > 0) {
      actuals.evidence_check = aggregatedRawData.evidence_check_models_used.join(',');
    }
    serverLog(runId, 'info', 'stage_complete', {
      stage: 'forensic_audit',
      model: aggregatedRawData.models_used.join(',') || STAGE_MODELS.forensic_audit.id,
      evidence_check_model: aggregatedRawData.evidence_check_models_used.join(',') || STAGE_MODELS.evidence_check.id,
      duration_ms: Date.now() - phase1Started,
      failed_batches: aggregatedRawData.failed_batches.join(',') || 'none',
      evidence_downgrades: aggregatedRawData.evidence_check.downgraded_count,
      evidence_rescans: aggregatedRawData.evidence_check.rescan_count,
    });

    if (aggregatedRawData.failed_batches.length > 0) {
      throw new Error(
        `Phase 1 audit incomplete: ${aggregatedRawData.failed_batches.length} of 5 batches (${aggregatedRawData.failed_batches.join(', ')}) failed after retry. ` +
        `${aggregatedRawData.failed_batches.length * 10} criteria are missing data. ` +
        `Re-run the assessment, or check the audit model's availability.`
      );
    }

    const phase1Validation = validatePhase1Output(aggregatedRawData);
    if (!phase1Validation.valid) {
      throw new Error(
        `Phase 1 validation failed:\n  - ${phase1Validation.errors.join('\n  - ')}\n` +
        `Re-run the assessment.`
      );
    }
    if (phase1Validation.warnings.length > 0) {
      console.warn("[FinOps] Phase 1 validation warnings:", phase1Validation.warnings);
    }

    const auditLogs = validateAndSanitizeLogs(aggregatedRawData);

    onProgress('calc', 0);
    await new Promise(r => setTimeout(r, 600));
    onProgress('calc', 100);
    const validationData = calculateMetrics(auditLogs);

    console.log(`[FinOps] Phase 2 Complete. Readiness: ${Math.round(validationData.metrics.finops_readiness)}%, Classification: ${validationData.crawl_walk_run}`);

    // Confidence bracket: drives which synthesis prompt runs.
    // LOW   → findings (no roadmap, no case studies)
    // MEDIUM → cautious (per-phase confidence + assumptions, hedged verbs)
    // HIGH  → directive (current behavior — full tactics, case studies)
    const confidenceBracket = bracketFromValidation(validationData);
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
      reason: escalationReason,
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

    onProgress('strategy', 20);
    const tacticsContext = await tacticsPromise;

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

=== PART 3: THE PLAYBOOK (SOLUTIONS) ===
${tacticsContext}`;

    onProgress('strategy', 50);

    const handoffSummary = `
FINOPS DIAGNOSTIC REPORT SUMMARY (Computed by System):
-------------------------------------------------------
Evidence-Gated FinOps Readiness Score: ${Math.round(validationData.metrics.finops_readiness)}/100
Maturity Classification: ${validationData.crawl_walk_run}
Maturity Depth Index: ${Math.round(validationData.metrics.maturity_depth)}%
Anti-Pattern Burden: ${Math.round(validationData.metrics.antipattern_burden)}%
Anti-Pattern Burden Confidence: ${validationData.metrics.antipattern_burden_confidence || 'unknown'}
Anti-Pattern Clearance: ${Math.round(validationData.metrics.antipattern_clearance)}%
Anti-Pattern Coverage: ${Math.round(validationData.metrics.antipattern_coverage)}%
Delivery Integrity: ${validationData.metrics.delivery_integrity}% (criteria the audit returned data for)
Evidence Density: ${validationData.metrics.evidence_density}% (criteria with quotable evidence from source)
${validationData.metrics.readiness_cap_reason ? `Readiness Cap: ${validationData.metrics.readiness_cap_reason}` : ''}
Anti-Pattern Findings: ${validationData.antipattern_findings.length}
Verified Anti-Pattern Absences: ${validationData.verified_antipattern_absences.length}
Unknown / Not-Assessable Anti-Pattern Absences: ${validationData.unknown_antipattern_absences.length}
Maturity Gaps: ${validationData.maturity_gaps.length}
Silent Areas: ${validationData.silent_areas.length}

CATEGORY BREAKDOWN:
${Object.entries(validationData.category_scores).map(([cat, score]) => `  ${cat}: ${score}/15`).join('\n')}
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

    const callEvidenceSynthesis = async (correctionAppendix?: string): Promise<any> => {
      const textParts: string[] = [EVIDENCE_SYNTHESIS_USER_PROMPT];
      textParts.push(`\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\nUse only these findings and the source document for summary and diagnosis:\n${handoffSummary}`);
      textParts.push(`\n\n### ORIGINAL SOURCE CONTEXT\n<SOURCE_DOCUMENT_TO_AUDIT>\n${text.substring(0, 50000)}\n</SOURCE_DOCUMENT_TO_AUDIT>`);
      if (confidenceBracket === 'LOW') {
        textParts.push(`\n\n### LOW-CONFIDENCE OVERRIDE\nEvidence is LOW confidence. Keep diagnosis provisional, return low diagnostic confidence, and emphasize missing evidence rather than root-cause certainty.`);
      }
      if (correctionAppendix) textParts.push(correctionAppendix);
      const synthStarted = Date.now();
      const resp = await runStage(synthesisStage, {
        userText: textParts.join(''),
        systemInstruction: EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION,
      }, { runId });
      actuals.synthesis = resp.modelUsed.id;
      serverLog(runId, 'info', 'stage_complete', {
        stage: synthesisStage,
        model: resp.modelUsed.id,
        substage: 'evidence_summary',
        bracket: confidenceBracket,
        duration_ms: Date.now() - synthStarted,
        regen: correctionAppendix ? 'yes' : 'no',
      });
      return parseAiResponse(resp.text);
    };

    const callRoadmapSynthesis = async (lockedStrategy: any, correctionAppendix?: string): Promise<any> => {
      const textParts: string[] = [ROADMAP_SYNTHESIS_USER_PROMPT];
      if (confidenceBracket === 'MEDIUM') textParts.push(ROADMAP_SYNTHESIS_PROMPT_CAUTIOUS_APPENDIX);
      if (confidenceBracket !== 'LOW') {
        textParts.push(`\n\n### THE GOLDEN STANDARD (SSOT)\nYou may ONLY prescribe solutions found in this Knowledge Base. Use it for roadmap actions only; never alter locked findings from it:\n\n${fullSSOT}`);
      }
      textParts.push(`\n\n### LOCKED FINDINGS JSON (IMMUTABLE)\n${compactLockedFindings(lockedStrategy)}`);
      textParts.push(`\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\n${handoffSummary}`);
      if (correctionAppendix) textParts.push(correctionAppendix);
      const synthStarted = Date.now();
      const resp = await runStage(synthesisStage, {
        userText: textParts.join(''),
        systemInstruction: ROADMAP_SYNTHESIS_SYSTEM_INSTRUCTION,
      }, { runId });
      actuals.synthesis = resp.modelUsed.id;
      serverLog(runId, 'info', 'stage_complete', {
        stage: synthesisStage,
        model: resp.modelUsed.id,
        substage: 'roadmap',
        bracket: confidenceBracket,
        duration_ms: Date.now() - synthStarted,
        regen: correctionAppendix ? 'yes' : 'no',
      });
      return parseAiResponse(resp.text);
    };

    const callFindingsSynthesis = async (correctionAppendix?: string): Promise<any> => {
      const textParts: string[] = [STRATEGY_USER_PROMPT_FINDINGS];
      textParts.push(`\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\nUse these findings to produce the findings-mode report:\n${handoffSummary}`);
      textParts.push(`\n\n### ORIGINAL SOURCE CONTEXT\n<SOURCE_DOCUMENT_TO_AUDIT>\n${text.substring(0, 50000)}\n</SOURCE_DOCUMENT_TO_AUDIT>`);
      if (correctionAppendix) textParts.push(correctionAppendix);
      const synthStarted = Date.now();
      const resp = await runStage(synthesisStage, {
        userText: textParts.join(''),
        systemInstruction: EVIDENCE_SYNTHESIS_SYSTEM_INSTRUCTION,
      }, { runId });
      actuals.synthesis = resp.modelUsed.id;
      serverLog(runId, 'info', 'stage_complete', {
        stage: synthesisStage,
        model: resp.modelUsed.id,
        substage: 'findings_mode',
        bracket: confidenceBracket,
        duration_ms: Date.now() - synthStarted,
        regen: correctionAppendix ? 'yes' : 'no',
      });
      return parseAiResponse(resp.text);
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

    const mergeFactChecks = (summary: FactCheckResult, roadmap: FactCheckResult, attemptNumber: number): FactCheckResult => {
      if (summary.failed || roadmap.failed) {
        return {
          attempts: attemptNumber,
          total_claims: summary.total_claims + roadmap.total_claims,
          supported_count: summary.supported_count + roadmap.supported_count,
          unsupported_claims: [...summary.unsupported_claims, ...roadmap.unsupported_claims],
          failed: true,
          failure_reason: [summary.failed ? summary.failure_reason : '', roadmap.failed ? roadmap.failure_reason : ''].filter(Boolean).join(' | ')
        };
      }
      return {
        attempts: attemptNumber,
        total_claims: summary.total_claims + roadmap.total_claims,
        supported_count: summary.supported_count + roadmap.supported_count,
        unsupported_claims: [...summary.unsupported_claims, ...roadmap.unsupported_claims],
        failed: false
      };
    };

    const runFactCheck = async (data: any, attemptNumber: number): Promise<FactCheckResult> => {
      const strategy = data?.phase_3_strategy || {};
      const roadmap = strategy.remediation_roadmap || [];
      const roadmapText = roadmap.flatMap((p: any) => Array.isArray(p.actions) ? p.actions : []).join('\n');
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
        const summaryResp = await runStage('fact_check', {
          userText: summaryPrompt,
          images,
        }, { runId });
        actuals.fact_check = summaryResp.modelUsed.id;
        serverLog(runId, 'info', 'stage_complete', {
          stage: 'fact_check',
          model: summaryResp.modelUsed.id,
          substage: 'summary',
          duration_ms: Date.now() - summaryStarted,
          attempt: attemptNumber,
        });
        const summaryCheck = parseFactCheckResponse(summaryResp.text, attemptNumber);

        const roadmapPrompt = buildRoadmapFactCheckPrompt({
          contentToCheck: buildRoadmapCheckText(strategy),
          remediationRoadmapText: roadmapText,
          lockedFindingsText: compactLockedFindings(strategy),
          sourceDocument: text,
          phase1: auditLogs,
          phase2: validationData,
          imageCount: images.length,
          tactics: FINOPS_TACTICS_LOCAL,
        });
        const roadmapStarted = Date.now();
        const roadmapResp = await runStage('fact_check', {
          userText: roadmapPrompt,
          images,
        }, { runId });
        actuals.fact_check = roadmapResp.modelUsed.id;
        serverLog(runId, 'info', 'stage_complete', {
          stage: 'fact_check',
          model: roadmapResp.modelUsed.id,
          substage: 'roadmap',
          duration_ms: Date.now() - roadmapStarted,
          attempt: attemptNumber,
        });
        const roadmapCheck = parseFactCheckResponse(roadmapResp.text, attemptNumber);
        return mergeFactChecks(summaryCheck, roadmapCheck, attemptNumber);
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
      headline: `${validationData.crawl_walk_run} FinOps maturity with ${Math.round(validationData.metrics.finops_readiness)}/100 evidence-gated readiness`,
      maturity_classification: validationData.crawl_walk_run,
      key_metrics: [
        `Evidence-gated readiness: ${Math.round(validationData.metrics.finops_readiness)}/100`,
        `Maturity depth: ${Math.round(validationData.metrics.maturity_depth)}%`,
        `Anti-pattern burden: ${Math.round(validationData.metrics.antipattern_burden)}% (${validationData.metrics.antipattern_burden_confidence || 'unknown'} confidence)`,
        `Anti-pattern clearance: ${Math.round(validationData.metrics.antipattern_clearance)}%`,
        `Anti-pattern coverage: ${Math.round(validationData.metrics.antipattern_coverage)}%`,
        `Delivery integrity: ${Math.round(validationData.metrics.delivery_integrity)}%`,
        `Evidence density: ${Math.round(validationData.metrics.evidence_density)}%`,
        ...(validationData.metrics.readiness_cap_reason ? [validationData.metrics.readiness_cap_reason] : [])
      ],
      confirmed_strengths: Object.entries(validationData.category_scores)
        .filter(([, score]) => score >= 10)
        .map(([cat, score]) => `Domain ${cat} shows relatively strong maturity signal (${score}/15).`),
      confirmed_gaps: validationData.maturity_gaps.slice(0, 8),
      confirmed_antipatterns: validationData.antipattern_findings.slice(0, 8),
      silent_or_missing_evidence: [
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
        Object.entries(validationData.category_scores).map(([cat, score]) => [cat, `Maturity signal ${score}/15 in domain ${cat}.`])
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

    const normalizeStrategy = (raw: any): any => {
      if (!raw?.phase_3_strategy) return raw;
      const normalized = normalizePersonaSummaries(raw.phase_3_strategy);
      const incomingPlanningDecision = raw.phase_3_strategy.planning_decision;
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
        diagnosis: raw.phase_3_strategy.diagnosis?.primary_bottleneck ? raw.phase_3_strategy.diagnosis : buildFallbackDiagnosis(),
        planning_decision: normalizedPlanningDecision,
        remediation_roadmap: confidenceBracket === 'LOW' ? [] : (raw.phase_3_strategy.remediation_roadmap || []),
        confidence_bracket: confidenceBracket,
        findings_mode: confidenceBracket === 'LOW'
          ? raw.phase_3_strategy.findings_mode || buildFallbackFindingsMode()
          : raw.phase_3_strategy.findings_mode
      };
      return raw;
    };

    // Wrap callPhase3 with a deterministic ID-validity gate. Before any
    // fact-check spend, we extract all [TAC-...] references and verify each
    // exists in the DB. Invalid IDs trigger a targeted regen with the full
    // valid-ID list. Catches structural failures the LLM-based fact-check
    // sometimes misses, and avoids burning fact-check tokens on output with
    // obvious tactic-ID errors.
    const validIds = validTacticIdSet();
    let tacticGroundingWarnings: string[] = [];
    const callPhase3Validated = async (correctionAppendix?: string): Promise<any> => {
      let data = normalizeStrategy(await callPhase3(correctionAppendix));
      let invalid = findInvalidTacticIds(data, validIds);
      let regen = 0;
      while (invalid.length > 0 && regen < ID_VALIDATION_MAX_REGENS) {
        regen++;
        console.warn(`[FinOps] [${runId}] Strategy cites ${invalid.length} invalid tactic IDs (${invalid.join(', ')}); regen ${regen}/${ID_VALIDATION_MAX_REGENS}`);
        serverLog(runId, 'warn', 'invalid_tactic_ids', {
          invalid_ids: invalid.join(','),
          regen,
        });
        const idAppendix = buildInvalidIdAppendix(invalid, validIds);
        const combined = correctionAppendix ? `${correctionAppendix}\n\n${idAppendix}` : idAppendix;
        data = normalizeStrategy(await callPhase3(combined));
        invalid = findInvalidTacticIds(data, validIds);
      }
      if (invalid.length > 0) {
        console.error(`[FinOps] [${runId}] Strategy STILL contains invalid tactic IDs after ${ID_VALIDATION_MAX_REGENS} regens: ${invalid.join(', ')}`);
        serverLog(runId, 'error', 'invalid_tactic_ids_persisted', {
          invalid_ids: invalid.join(','),
        });
      }
      const grounding = sanitizeRoadmapTacticGrounding(data, validationData);
      tacticGroundingWarnings = grounding.warnings;
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

    let strategyData: any = await callPhase3Validated();
    onProgress('strategy', 70);
    let factCheck = await runFactCheck(strategyData, 1);
    let lastUnsupported: FactCheckClaim[] = factCheck.unsupported_claims;
    if (!factCheck.failed) trajectory.push(snapshot(factCheck));

    let attempt = 1;
    while (
      !factCheck.failed &&
      lastUnsupported.length > 0 &&
      attempt <= FACT_CHECK_MAX_RETRIES
    ) {
      console.log(`[FinOps] Fact-check pass ${attempt}: ${lastUnsupported.length} unsupported claims, regenerating...`);
      strategyData = await callPhase3Validated(buildRegenerateAppendix(lastUnsupported));
      attempt++;
      factCheck = await runFactCheck(strategyData, attempt);
      lastUnsupported = factCheck.unsupported_claims;
      if (!factCheck.failed) trajectory.push(snapshot(factCheck));
    }

    factCheck.trajectory = trajectory;

    if (factCheck.failed) {
      console.warn(`[FinOps] Fact-check unavailable: ${factCheck.failure_reason}`);
    } else {
      console.log(`[FinOps] Fact-check complete after ${factCheck.attempts} pass(es): ${factCheck.supported_count}/${factCheck.total_claims} claims supported, ${lastUnsupported.length} unsupported.`);
      if (trajectory.length > 1) {
        const traj = trajectory.map(p => `pass${p.attempt}:${p.supported_count}/${p.total_claims}supp,${p.unsupported_count}unsupp`).join(' → ');
        console.log(`[FinOps] [${runId}] Fact-check trajectory: ${traj}`);
        serverLog(runId, 'info', 'fact_check_trajectory', { trajectory: traj, passes: trajectory.length });
      }
    }

    onProgress('strategy', 90);

    const groundingValidation = validatePhase3Grounding(strategyData, validationData, text);
    groundingValidation.warnings.push(...tacticGroundingWarnings);
    if (groundingValidation.errors.length > 0) {
      console.error("[FinOps] Phase 3 grounding errors:", groundingValidation.errors);
    }
    if (groundingValidation.warnings.length > 0) {
      console.warn("[FinOps] Phase 3 grounding warnings:", groundingValidation.warnings);
    }

    const qualityGate = runQualityGate(auditLogs, validationData, phase1Validation, groundingValidation, aggregatedRawData.evidence_check, factCheck);
    console.log(`[FinOps] [${runId}] Quality Gate decision: ${qualityGate.decision}`);

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
        ...(explanation.failed ? { failure_reason: explanation.failure_reason } : {}),
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
    if (effectiveBracket !== confidenceBracket) {
      console.warn(`[FinOps] [${runId}] Strategy downgraded by QG: ${confidenceBracket} → ${effectiveBracket} (decision=${qualityGate.decision})`);
      serverLog(runId, 'warn', 'strategy_downgraded', {
        from: confidenceBracket,
        to: effectiveBracket,
        decision: qualityGate.decision,
      });
    }

    onProgress('strategy', 100);

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
    });

    return {
      meta: {
        document_analyzed: "Uploaded Text",
        timestamp: new Date().toISOString(),
        engine_version: "finops-1.0.0",
        model_config: {
          preflight: actuals.preflight,
          forensic_audit: actuals.forensic_audit,
          evidence_check: actuals.evidence_check,
          synthesis: actuals.synthesis,
          fact_check: actuals.fact_check,
          validators: "deterministic"
        }
      },
      phase_1_audit_logs: auditLogs,
      evidence_check: aggregatedRawData.evidence_check,
      phase_2_validation: validationData,
      phase_3_strategy: strategyData.phase_3_strategy || {
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
      },
      quality_gate: qualityGate
    };

  } catch (error: any) {
    const duration = Date.now() - pipelineStarted;
    console.error(`[FinOps] [${runId}] === Pipeline FAILED === duration_ms=${duration} error="${error?.message || error}"`);
    serverLog(runId, 'error', 'pipeline_failed', {
      duration_ms: duration,
      error: error?.message || String(error),
      models: actuals,
    });
    throw error;
  }
};
