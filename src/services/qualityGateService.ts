
import { AuditItem, FactCheckResult, Phase1AuditLogs, Phase2Validation, QualityGateResult, ValidationResult } from '../types';

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
  fact_check: undefined
});

export const runQualityGate = (
  phase1: Phase1AuditLogs,
  phase2: Phase2Validation,
  phase1Validation: ValidationResult,
  phase3Validation: ValidationResult,
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
        ? `All quality checks passed. Fact-check verified ${factCheck.supported_count} of ${factCheck.total_claims} claims against the source.`
        : 'All quality checks passed. Strategy is grounded in validated findings.'
    );
  } else if (decision === 'WARN') {
    notes.push('Strategy can be used but the listed warnings reduce confidence in specific claims. Review affected items in the Forensic Audit section before acting.');
  } else {
    notes.push('Strategy is unsafe to act on. Re-run with stronger source material or after the listed issues are resolved.');
  }

  return { decision, blocking_reasons, warnings, notes, thresholds: THRESHOLDS, fact_check: factCheck };
};
