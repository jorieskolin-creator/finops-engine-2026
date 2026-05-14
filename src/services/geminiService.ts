
import { STRATEGY_SYSTEM_INSTRUCTION, STRATEGY_USER_PROMPT } from "../constants";
import { runPhase1Audit } from "../orchestrator";
import { knowledgeBaseService, BATCH_DEFINITIONS } from "../knowledge_base";
import { DiagnosticResult, Phase1AuditLogs, Phase2Validation, AuditItem, EvidenceQuote, EvidenceCategory, EVIDENCE_CATEGORIES, PersonaId, PERSONA_IDS, ImageInput } from "../types";
import { generateSafetyAuditPrompt } from "./securityService";
import { validatePhase1Output, validatePhase3Grounding } from "./validatorService";
import { buildEvidenceDensityBlock, runQualityGate, EVIDENCE_DENSITY_BLOCK } from "./qualityGateService";
import { buildFactCheckPrompt, buildRegenerateAppendix, parseFactCheckResponse } from "./factCheckService";
import { FactCheckClaim, FactCheckResult } from "../types";
import { MODEL_PHASE1, MODEL_PHASE3, GeminiThinkingConfig } from "../models";

const FACT_CHECK_MAX_RETRIES = 2;

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

const callGeminiGenerate = async (
  model: string,
  contents: any[],
  systemInstruction?: string,
  thinkingConfig?: GeminiThinkingConfig
) => {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, contents, systemInstruction, thinkingConfig })
  });

  if (!response.ok) {
    throw new Error(`Proxy Error: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
};

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

const calculateMetrics = (logs: Phase1AuditLogs): Phase2Validation => {
  let maturityCount = 0; let maturitySum = 0; const maturityGaps: string[] = [];
  let antipatternCount = 0; let antipatternSum = 0; const antipatternFindings: string[] = [];
  let deliveredItems = 0;
  let itemsWithEvidence = 0;
  const silentAreas: string[] = [];
  const categoryScores: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const evidenceCategoryTotals: Partial<Record<EvidenceCategory, number>> = {};

  const tally = (item: AuditItem) => {
    if (item.count !== -1) deliveredItems++;
    if (item.evidence_quotes && item.evidence_quotes.length > 0) itemsWithEvidence++;
    if (item.category_footprint) {
      for (const [cat, n] of Object.entries(item.category_footprint)) {
        const c = cat as EvidenceCategory;
        evidenceCategoryTotals[c] = (evidenceCategoryTotals[c] || 0) + (n as number);
      }
    }
  };

  Object.entries(logs.maturity).forEach(([key, rawItem]) => {
    const item = rawItem as AuditItem;
    tally(item);
    maturitySum += Math.max(item.count, 0);
    if (item.status === 'OK') maturityCount++;
    const catPrefix = key.charAt(0);
    if (categoryScores[catPrefix] !== undefined) categoryScores[catPrefix] += Math.max(item.count, 0);
    if (item.count === 0) {
      silentAreas.push(`Missing Capability: ${key}`);
      maturityGaps.push(`[${key}] Missing: ${item.reasoning}`);
    }
  });

  Object.entries(logs.antipattern).forEach(([key, rawItem]) => {
    const item = rawItem as AuditItem;
    tally(item);
    antipatternSum += Math.max(item.count, 0);
    if (item.status === 'NOK') antipatternCount++;
    if (item.count > 0) {
      antipatternFindings.push(`[${key}] Finding: ${item.evidence.substring(0, 100)}...`);
    }
  });

  const delivery_integrity = Math.round((deliveredItems / 50) * 100);
  const evidence_density = Math.round((itemsWithEvidence / 50) * 100);

  const maturity_ratio = (maturityCount / 25) * 100;
  const maturity_depth = (maturitySum / 75) * 100;
  const antipattern_ratio = (antipatternCount / 25) * 100;
  const antipattern_burden = (antipatternSum / 75) * 100;
  const finops_readiness = ((maturitySum + (75 - antipatternSum)) / 150) * 100;

  let crawl_walk_run: Phase2Validation['crawl_walk_run'];
  if (finops_readiness < 33) {
    crawl_walk_run = 'Crawl';
  } else if (finops_readiness < 66) {
    crawl_walk_run = antipattern_burden > 50 ? 'Walk with significant friction' : 'Walk';
  } else {
    crawl_walk_run = 'Run';
  }

  return {
    metrics: {
      maturity_ratio,
      antipattern_ratio,
      maturity_depth,
      antipattern_burden,
      finops_readiness,
      delivery_integrity,
      evidence_density
    },
    raw_counts: {
      maturity_sub_criteria_met: maturitySum,
      antipattern_sub_criteria_met: antipatternSum
    },
    maturity_gaps: maturityGaps,
    antipattern_findings: antipatternFindings,
    silent_areas: silentAreas,
    category_scores: categoryScores,
    evidence_category_totals: evidenceCategoryTotals,
    crawl_walk_run
  };
};

export const analyzeDocument = async (
  text: string,
  images: ImageInput[],
  onProgress: (stage: 'audit' | 'calc' | 'strategy', progress?: number) => void
): Promise<DiagnosticResult> => {
  try {
    const imagePayloadBytes = images.reduce((sum, img) => sum + img.data.length, 0);
    if (images.length > 0) {
      console.log(`[FinOps] Multimodal: ${images.length} image(s), ~${Math.round(imagePayloadBytes / 1024)} KB base64 payload.`);
    }

    console.log("[FinOps] Running Security Pre-Flight (DLP)...");
    onProgress('audit', 1);
    const dlpPrompt = generateSafetyAuditPrompt(text, images);

    const dlpParts: any[] = [{ text: dlpPrompt }];
    for (const img of images) {
      const label = img.page_number !== undefined
        ? `[Image: ${img.source_name} — page ${img.page_number}]`
        : `[Image: ${img.source_name}]`;
      dlpParts.push({ text: `\n${label}\n` });
      dlpParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    const dlpResponse = await callGeminiGenerate(
      MODEL_PHASE1.id,
      [{ role: 'user', parts: dlpParts }],
      undefined,
      MODEL_PHASE1.thinkingConfig
    );
    const dlpResult = parseAiResponse(dlpResponse.text);

    if (dlpResult && dlpResult.safe === false) {
      throw new Error(`Security Alert: Document rejected due to ${dlpResult.risk_detected} content. (${dlpResult.reason})`);
    }
    console.log("[FinOps] DLP Scan Passed.");

    console.log("[FinOps] Pre-fetching Tactics Database for Phase 3...");
    const tacticsPromise = knowledgeBaseService.fetchStrategicPlaybook();

    onProgress('audit', 5);
    console.log("[FinOps] Running Phase 1 Parallel Audit (5 batches)...");
    const aggregatedRawData = await runPhase1Audit(text, images, (completed, total) => {
      onProgress('audit', Math.round((completed / total) * 100));
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

    if (validationData.metrics.evidence_density < EVIDENCE_DENSITY_BLOCK) {
      onProgress('strategy', 100);
      return {
        meta: {
          document_analyzed: "Uploaded Text",
          timestamp: new Date().toISOString(),
          engine_version: "finops-1.0.0",
          model_config: {
            phase0_phase1: MODEL_PHASE1.id,
            phase3: MODEL_PHASE3.id,
            validators: "deterministic"
          }
        },
        phase_1_audit_logs: auditLogs,
        phase_2_validation: validationData,
        phase_3_strategy: {
          executive_summary: `_Strategy generation skipped — see Quality Gate above._`,
          executive_summaries: {
            finops_lead: `_Strategy generation skipped — see Quality Gate above._`,
            cfo: `_Strategy generation skipped — see Quality Gate above._`,
            engineering_lead: `_Strategy generation skipped — see Quality Gate above._`
          },
          active_persona: DEFAULT_PERSONA,
          visual_scorecard: { headline: "Audit Inconclusive", maturity_score: "N/A", burden_score: "N/A" },
          remediation_roadmap: []
        },
        quality_gate: buildEvidenceDensityBlock(validationData.metrics.evidence_density)
      };
    }

    onProgress('strategy', 20);
    const tacticsContext = await tacticsPromise;

    const definitionsContext = JSON.stringify(BATCH_DEFINITIONS, null, 2);
    const fullSSOT = `=== PART 1: THE CRITERIA (DEFINITIONS) ===\n${definitionsContext}\n\n=== PART 2: THE PLAYBOOK (SOLUTIONS) ===\n${tacticsContext}`;

    onProgress('strategy', 50);

    const handoffSummary = `
FINOPS DIAGNOSTIC REPORT SUMMARY (Computed by System):
-------------------------------------------------------
FinOps Readiness Score: ${Math.round(validationData.metrics.finops_readiness)}/100
Maturity Classification: ${validationData.crawl_walk_run}
Maturity Depth Index: ${Math.round(validationData.metrics.maturity_depth)}%
Anti-Pattern Burden: ${Math.round(validationData.metrics.antipattern_burden)}%
Delivery Integrity: ${validationData.metrics.delivery_integrity}% (criteria the audit returned data for)
Evidence Density: ${validationData.metrics.evidence_density}% (criteria with quotable evidence from source)
Anti-Pattern Findings: ${validationData.antipattern_findings.length}
Maturity Gaps: ${validationData.maturity_gaps.length}
Silent Areas: ${validationData.silent_areas.length}

CATEGORY BREAKDOWN:
${Object.entries(validationData.category_scores).map(([cat, score]) => `  ${cat}: ${score}/15`).join('\n')}
`;

    const callPhase3 = async (correctionAppendix?: string): Promise<any> => {
      const parts: Array<{ text: string }> = [
        { text: STRATEGY_USER_PROMPT },
        { text: `\n\n### THE GOLDEN STANDARD (SSOT)\nYou must ignore generic internet advice. You may ONLY prescribe solutions found in this Knowledge Base:\n\n${fullSSOT}` },
        { text: `\n\n### DIAGNOSTIC FINDINGS (Phase 1 & 2)\nUse these specific gaps and anti-patterns to trigger the strategies above:\n${handoffSummary}` },
        { text: `\n\n### ORIGINAL SOURCE CONTEXT\n<SOURCE_DOCUMENT_TO_AUDIT>\n${text.substring(0, 50000)}\n</SOURCE_DOCUMENT_TO_AUDIT>` }
      ];
      if (correctionAppendix) parts.push({ text: correctionAppendix });
      const resp = await callGeminiGenerate(
        MODEL_PHASE3.id,
        [{ role: 'user', parts }],
        STRATEGY_SYSTEM_INSTRUCTION,
        MODEL_PHASE3.thinkingConfig
      );
      return parseAiResponse(resp.text);
    };

    const runFactCheck = async (data: any, attemptNumber: number): Promise<FactCheckResult> => {
      const strategy = data?.phase_3_strategy || {};
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
      const roadmap = strategy.remediation_roadmap || [];
      const roadmapText = roadmap.flatMap((p: any) => Array.isArray(p.actions) ? p.actions : []).join('\n');
      try {
        const fcPrompt = buildFactCheckPrompt({
          executiveSummary: summary,
          remediationRoadmapText: roadmapText,
          sourceDocument: text,
          phase1: auditLogs,
          phase2: validationData,
          imageCount: images.length
        });
        const fcParts: any[] = [{ text: fcPrompt }];
        for (const img of images) {
          const label = img.page_number !== undefined
            ? `[Image: ${img.source_name} — page ${img.page_number}]`
            : `[Image: ${img.source_name}]`;
          fcParts.push({ text: `\n${label}\n` });
          fcParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        }
        const fcResp = await callGeminiGenerate(
          MODEL_PHASE1.id,
          [{ role: 'user', parts: fcParts }],
          undefined,
          MODEL_PHASE1.thinkingConfig
        );
        return parseFactCheckResponse(fcResp.text, attemptNumber);
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

    const normalizeStrategy = (raw: any): any => {
      if (!raw?.phase_3_strategy) return raw;
      const normalized = normalizePersonaSummaries(raw.phase_3_strategy);
      raw.phase_3_strategy = {
        ...raw.phase_3_strategy,
        executive_summaries: normalized.executive_summaries,
        executive_summary: normalized.executive_summary,
        active_persona: normalized.active_persona
      };
      return raw;
    };

    let strategyData: any = normalizeStrategy(await callPhase3());
    onProgress('strategy', 70);
    let factCheck = await runFactCheck(strategyData, 1);
    let lastUnsupported: FactCheckClaim[] = factCheck.unsupported_claims;

    let attempt = 1;
    while (
      !factCheck.failed &&
      lastUnsupported.length > 0 &&
      attempt <= FACT_CHECK_MAX_RETRIES
    ) {
      console.log(`[FinOps] Fact-check pass ${attempt}: ${lastUnsupported.length} unsupported claims, regenerating...`);
      strategyData = normalizeStrategy(await callPhase3(buildRegenerateAppendix(lastUnsupported)));
      attempt++;
      factCheck = await runFactCheck(strategyData, attempt);
      lastUnsupported = factCheck.unsupported_claims;
    }

    if (factCheck.failed) {
      console.warn(`[FinOps] Fact-check unavailable: ${factCheck.failure_reason}`);
    } else {
      console.log(`[FinOps] Fact-check complete after ${factCheck.attempts} pass(es): ${factCheck.supported_count}/${factCheck.total_claims} claims supported, ${lastUnsupported.length} unsupported.`);
    }

    onProgress('strategy', 90);

    const groundingValidation = validatePhase3Grounding(strategyData, validationData);
    if (groundingValidation.errors.length > 0) {
      console.error("[FinOps] Phase 3 grounding errors:", groundingValidation.errors);
    }
    if (groundingValidation.warnings.length > 0) {
      console.warn("[FinOps] Phase 3 grounding warnings:", groundingValidation.warnings);
    }

    const qualityGate = runQualityGate(auditLogs, validationData, phase1Validation, groundingValidation, factCheck);
    console.log(`[FinOps] Quality Gate decision: ${qualityGate.decision}`);

    onProgress('strategy', 100);

    return {
      meta: {
        document_analyzed: "Uploaded Text",
        timestamp: new Date().toISOString(),
        engine_version: "finops-1.0.0",
        model_config: {
          phase0_phase1: MODEL_PHASE1.id,
          phase3: MODEL_PHASE3.id,
          validators: "deterministic"
        }
      },
      phase_1_audit_logs: auditLogs,
      phase_2_validation: validationData,
      phase_3_strategy: strategyData.phase_3_strategy || {
        executive_summary: "Strategy incomplete.",
        executive_summaries: {
          finops_lead: "Strategy incomplete.",
          cfo: "Strategy incomplete.",
          engineering_lead: "Strategy incomplete."
        },
        active_persona: DEFAULT_PERSONA,
        visual_scorecard: { headline: "Error", maturity_score: "N/A", burden_score: "N/A" },
        remediation_roadmap: []
      },
      quality_gate: qualityGate
    };

  } catch (error) {
    console.error("[FinOps Pipeline] Error:", error);
    throw error;
  }
};
