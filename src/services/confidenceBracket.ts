// Synthesis confidence bracket: pure function of Phase 2 metrics.
//
// The bracket determines which synthesis prompt variant runs:
//   HIGH   → directive prompt (tactics, case studies, owners, sequencing)
//   MEDIUM → cautious prompt  (same shape + per-phase confidence + assumptions)
//   LOW    → findings prompt  (no roadmap, no case studies, evidence + plan)
//
// Thresholds are deliberately conservative: it is cheaper and more honest to
// emit a findings report than to emit a directive that the fact-checker
// will later downgrade to BLOCK. Tighten over time once we have real-world
// telemetry on which bracket assignments hold up.

import { ConfidenceBracket, Phase2Validation } from '../types';

export interface BracketInputs {
  evidence_density: number;
  delivery_integrity: number;
  silent_areas_count: number;
}

export const HIGH_THRESHOLDS = {
  evidence_density: 70,
  delivery_integrity: 95,
  max_silent_areas: 10,
};

export const LOW_THRESHOLDS = {
  evidence_density: 30,
  delivery_integrity: 70,
};

export function computeConfidenceBracket(metrics: BracketInputs): ConfidenceBracket {
  if (
    metrics.evidence_density < LOW_THRESHOLDS.evidence_density ||
    metrics.delivery_integrity < LOW_THRESHOLDS.delivery_integrity
  ) {
    return 'LOW';
  }
  if (
    metrics.evidence_density >= HIGH_THRESHOLDS.evidence_density &&
    metrics.delivery_integrity >= HIGH_THRESHOLDS.delivery_integrity &&
    metrics.silent_areas_count <= HIGH_THRESHOLDS.max_silent_areas
  ) {
    return 'HIGH';
  }
  return 'MEDIUM';
}

export function bracketFromValidation(v: Phase2Validation): ConfidenceBracket {
  return computeConfidenceBracket({
    evidence_density: v.metrics.evidence_density,
    delivery_integrity: v.metrics.delivery_integrity,
    silent_areas_count: v.silent_areas.length,
  });
}

export function explainBracket(b: ConfidenceBracket, m: BracketInputs): string {
  return `bracket=${b} evidence_density=${Math.round(m.evidence_density)}% delivery_integrity=${Math.round(m.delivery_integrity)}% silent_areas=${m.silent_areas_count}`;
}
