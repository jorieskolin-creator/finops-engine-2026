
import { AuditItem, EvidenceCheckResult, FactCheckResult, Phase1AuditLogs, Phase2Validation, QualityGateResult, QualityGateLlmExplanation, ValidationResult } from '../types';
import { runStage, RunContext } from './modelRouter';

export const EVIDENCE_DENSITY_BLOCK = 30;
export const EVIDENCE_DENSITY_WARN = 60;
export const SILENT_AREAS_WARN = 15;
export const UNSUPPORTED_CLAIMS_BLOCK = 3;

const THRESHOLDS = {
  evidence_density_block: EVIDENCE_DENSITY_BLOCK,
  evidence_density_warn: EVIDENCE_DENSITY_WARN,
  silent_areas_warn: SILENT_AREAS_WARN,
  unsupported_claims_block: UNSUPPORTED_CLAIMS_BLOCK
};

export const buildEvidenceDensityBlock = (density: number): QualityGateResult => ({
  decision: 'BLOCK',
  blocking_reasons: [
    `Evidence density ${density}% is below the ${EVIDENCE_DENSITY_BLOCK}% floor. Fewer than ${Math.ceil(EVIDENCE_DENSITY_BLOCK / 2)} of 50 criteria had quotable evidence in the source — the audit cannot ground a strategy on this material.`
  ],
  warnings: [],
  notes: ['Skipped Phase 3 (strategy) and fact-check to avoid building on unreliable signal.'],
  thresholds: THRESHOLDS,
  fact_check: undefined,
  evidence_check: undefined
});

export const runQualityGate = (
  phase1: Phase1AuditLogs,
  phase2: Phase2Validation,
  phase1Validation: ValidationResult,
  phase3Validation: ValidationResult,
  evidenceCheck?: EvidenceCheckResult,
  factCheck?: FactCheckResult
): QualityGateResult => {
  const blocking_reasons: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (phase2.metrics.evidence_density < EVIDENCE_DENSITY_BLOCK) {
    blocking_reasons.push(
      `Evidence density ${phase2.metrics.evidence_density}% < ${EVIDENCE_DENSITY_BLOCK}% floor.`
    );
  }

  for (const stream of ['maturity', 'antipattern'] as const) {
    for (const [id, item] of Object.entries(phase1[stream])) {
      const a = item as AuditItem;
      const hasUsableEvidence = a.evidence_quotes.length > 0 || (a.evidence && a.evidence.length >= 20);
      if (a.count > 0 && !hasUsableEvidence) {
        blocking_reasons.push(`${stream}.${id}: scored ${a.count} but no traceable evidence captured.`);
      }
    }
  }

  for (const err of phase3Validation.errors) {
    blocking_reasons.push(`Phase 3: ${err}`);
  }

  if (evidenceCheck?.failed) {
    warnings.push(
      `Evidence-check did not complete (${evidenceCheck.failure_reason}). Phase 2 may still include unverified scanner evidence.`
    );
  } else if (evidenceCheck) {
    if (evidenceCheck.downgraded_count > 0) {
      warnings.push(
        `Evidence-check downgraded ${evidenceCheck.downgraded_count} scored finding(s) before Phase 2 because raw material did not support the scanner score.`
      );
    }
    if (evidenceCheck.rescan_count > 0) {
      notes.push(
        `Evidence-check triggered ${evidenceCheck.rescan_count} targeted rescan(s) for weak or unsupported criteria.`
      );
    }
    if (evidenceCheck.unsupported_count > 0 || evidenceCheck.missing_count > 0) {
      warnings.push(
        `Evidence-check found ${evidenceCheck.unsupported_count} unsupported and ${evidenceCheck.missing_count} missing evidence item(s); affected scores were lowered before metrics were calculated.`
      );
    }
  }

  if (factCheck && !factCheck.failed) {
    if (factCheck.unsupported_claims.length >= UNSUPPORTED_CLAIMS_BLOCK) {
      blocking_reasons.push(
        `Fact-check: ${factCheck.unsupported_claims.length} unsupported claims survived ${factCheck.attempts} regenerate pass(es) (block threshold: ${UNSUPPORTED_CLAIMS_BLOCK}). Strategy is too disconnected from the source.`
      );
    } else if (factCheck.unsupported_claims.length > 0) {
      warnings.push(
        `Fact-check: ${factCheck.unsupported_claims.length} unsupported claim(s) remain after ${factCheck.attempts} pass(es). See Fact-Check Report for details.`
      );
    }
  }

  if (factCheck?.failed) {
    warnings.push(
      `Fact-check pass did not complete (${factCheck.failure_reason}). Strategy was not deeply verified — treat specific claims with caution.`
    );
  }

  if (
    phase2.metrics.evidence_density >= EVIDENCE_DENSITY_BLOCK &&
    phase2.metrics.evidence_density < EVIDENCE_DENSITY_WARN
  ) {
    warnings.push(
      `Evidence density ${phase2.metrics.evidence_density}% < ${EVIDENCE_DENSITY_WARN}% — many criteria scored without quotable source material.`
    );
  }

  if (phase2.metrics.antipattern_coverage < EVIDENCE_DENSITY_WARN) {
    warnings.push(
      `Anti-pattern coverage ${Math.round(phase2.metrics.antipattern_coverage)}% < ${EVIDENCE_DENSITY_WARN}% — low burden mostly means not assessable, not proven absence.`
    );
  }

  if (phase2.silent_areas.length > SILENT_AREAS_WARN) {
    warnings.push(
      `${phase2.silent_areas.length} of 25 maturity criteria are silent — strategy may over-extrapolate from sparse signal.`
    );
  }

  for (const w of phase1Validation.warnings) {
    warnings.push(`Phase 1: ${w}`);
  }
  for (const w of phase3Validation.warnings) {
    warnings.push(`Phase 3: ${w}`);
  }

  let decision: QualityGateResult['decision'] = 'GO';
  if (blocking_reasons.length > 0) decision = 'BLOCK';
  else if (warnings.length > 0) decision = 'WARN';

  if (decision === 'GO') {
    notes.push(
      factCheck && !factCheck.failed
        ? `All quality checks passed. Fact-check verified ${factCheck.supported_count} of ${factCheck.total_claims} claims against source evidence, audit metrics, or the approved tactics database.`
        : 'All quality checks passed. Strategy is grounded in validated findings.'
    );
  } else if (decision === 'WARN') {
    notes.push('Strategy can be used but the listed warnings reduce confidence in specific claims. Review affected items in the Forensic Audit section before acting.');
  } else {
    notes.push('Strategy is unsafe to act on. Re-run with stronger source material or after the listed issues are resolved.');
  }

  return { decision, blocking_reasons, warnings, notes, thresholds: THRESHOLDS, fact_check: factCheck, evidence_check: evidenceCheck };
};

// LLM-augmented reasoning. Only runs when the deterministic gate decided
// WARN or BLOCK — we use the model (default Gemini 3.1 Pro, see STAGE_MODELS)
// to write a plain-language explanation that grounds each reason in source
// quotes. This does NOT change the decision; it only annotates it.

const QG_PROMPT_PREAMBLE = `You are a senior FinOps reviewer. A deterministic Quality Gate has flagged issues with this assessment. Your job is to explain WHY each blocker / warning matters in plain English, and where possible, anchor the explanation in a direct quote from the source document.

Return STRICT JSON in this shape:
{
  "summary": "2-3 sentences in plain language: what's wrong with this assessment and what the reader should do.",
  "blocking_details": [
    { "reason": "<verbatim text of the blocking reason>", "explanation": "1-2 sentences why this matters for the FinOps maturity reading", "quote": "<short quote from source if relevant, else omit>", "source_location": "<section name / page / 'unknown'>" }
  ],
  "warning_details": [
    { "reason": "<verbatim text of the warning>", "explanation": "...", "quote": "...", "source_location": "..." }
  ]
}

Rules:
- Echo each reason VERBATIM in the matching "reason" field. Do not paraphrase or merge.
- "quote" must be a literal substring of the source document; omit it if no relevant evidence exists. Never invent quotes.
- Keep "explanation" terse. No marketing language, no apologies, no recommendations to "consider X".
- If a reason is purely structural (e.g. "scored 4 but no evidence captured"), omit "quote" and explain what the audit was unable to ground.
- Output JSON only. No prose before or after.`;

export const runQualityGateExplanation = async (
  gate: QualityGateResult,
  sourceDocument: string,
  ctx: RunContext
): Promise<QualityGateLlmExplanation> => {
  const sourceExcerpt = sourceDocument.length > 50000
    ? sourceDocument.substring(0, 50000) + '\n\n[...truncated]'
    : sourceDocument;

  const userText = [
    QG_PROMPT_PREAMBLE,
    `\n\n### DETERMINISTIC GATE OUTPUT`,
    `Decision: ${gate.decision}`,
    `Blocking reasons (${gate.blocking_reasons.length}):`,
    ...gate.blocking_reasons.map((r, i) => `  ${i + 1}. ${r}`),
    `Warnings (${gate.warnings.length}):`,
    ...gate.warnings.map((w, i) => `  ${i + 1}. ${w}`),
    `\n\n### SOURCE DOCUMENT\n<SOURCE_DOCUMENT>\n${sourceExcerpt}\n</SOURCE_DOCUMENT>`,
  ].join('\n');

  try {
    const resp = await runStage('quality_gate', { userText }, ctx);
    const text = resp.text || '';
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('QG explanation: response had no JSON');
    const parsed = JSON.parse(match[0]);

    const sanitizeItem = (raw: any) => ({
      reason: typeof raw?.reason === 'string' ? raw.reason : '',
      explanation: typeof raw?.explanation === 'string' ? raw.explanation : '',
      quote: typeof raw?.quote === 'string' && raw.quote.length > 0 ? raw.quote : undefined,
      source_location: typeof raw?.source_location === 'string' ? raw.source_location : undefined,
    });

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      blocking_details: Array.isArray(parsed.blocking_details) ? parsed.blocking_details.map(sanitizeItem) : [],
      warning_details: Array.isArray(parsed.warning_details) ? parsed.warning_details.map(sanitizeItem) : [],
      model_used: resp.modelUsed.id,
    };
  } catch (e: any) {
    return {
      summary: '',
      blocking_details: [],
      warning_details: [],
      failed: true,
      failure_reason: e?.message || String(e),
    };
  }
};
