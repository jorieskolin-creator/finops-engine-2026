import type { DiagnosticResult } from '../types';
import { FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';

export interface ReportMetricCard {
  value: number | null;
  label: string;
  description: string;
  denominator: string;
  trend: 'positive' | 'negative';
  color: string;
}

export interface ReportViewModel {
  sufficiency: {
    decision: 'PASS' | 'BLOCK';
    statement: string;
    reasons: string[];
    warnings: string[];
  };
  actionability: {
    gate: DiagnosticResult['quality_gate']['decision'];
    planningDecision: string;
    confidence: string;
    blockerCount: number;
    statement: string;
  };
  metrics: ReportMetricCard[];
  antipatternDisposition: {
    confirmed: number;
    partial: number;
    testedAbsent: number;
    notAssessed: number;
    unresolved: number;
  };
}

export const buildReportViewModel = (result: DiagnosticResult): ReportViewModel => {
  const maturityTotal = FINOPS_CRITERIA.length;
  const metrics = result.phase_2_validation.metrics;
  const evidenceCheck = result.quality_gate.evidence_check;
  const unresolvedAntiPatternIds = new Set(
    evidenceCheck?.items
      .filter(item => item.stream === 'antipattern' && (item.adjudication_unresolved || item.verification_unresolved))
      .map(item => item.id) || []
  );

  let confirmed = 0;
  let partial = 0;
  let testedAbsent = 0;
  let notAssessed = 0;

  for (const criterion of FINOPS_ANTIPATTERNS) {
    const item = result.phase_1_audit_logs.antipattern[criterion.id];
    if (unresolvedAntiPatternIds.has(criterion.id)) continue;
    const status = inferAntiPatternAbsenceStatus(item);
    if (status === 'confirmed_present') {
      confirmed++;
    } else if (status === 'partially_present') {
      partial++;
    } else if (status === 'tested_absent') {
      testedAbsent++;
    } else {
      if (!unresolvedAntiPatternIds.has(criterion.id)) notAssessed++;
    }
  }

  const unresolved = unresolvedAntiPatternIds.size;
  const planningDecision = result.phase_3_strategy.planning_decision?.decision || 'NOT_AVAILABLE';
  const confidence = result.phase_3_strategy.diagnosis?.confidence
    || result.phase_3_strategy.effective_bracket
    || result.phase_3_strategy.confidence_bracket
    || 'unknown';
  const gate = result.quality_gate.decision;
  const statement = gate === 'BLOCK'
    ? 'The assessment completed, but unresolved validation or insufficient evidence prevents an actionable roadmap.'
    : gate === 'WARN'
      ? 'The assessment is usable with the listed evidence and strategy limitations.'
      : 'The validated evidence supports the reported planning decision.';
  const sufficiency = result.phase_2_validation.assessment_sufficiency;
  const maturityModel = result.phase_2_validation.resolution_maturity;

  return {
    sufficiency: {
      decision: sufficiency.decision,
      statement: sufficiency.decision === 'PASS'
        ? `${sufficiency.warning_reasons?.length ? 'Assessment Sufficiency passed with evidence warnings.' : 'Assessment Sufficiency passed.'} The adjusted score can publish a ${result.phase_2_validation.crawl_walk_run} classification.`
        : 'Assessment Sufficiency blocked CRAWL/WALK/RUN publication. Model values remain visible for calibration, but are not a maturity classification.',
      reasons: sufficiency.blocking_reasons,
      warnings: sufficiency.warning_reasons || [],
    },
    actionability: {
      gate,
      planningDecision,
      confidence: String(confidence).toLowerCase(),
      blockerCount: result.quality_gate.blocking_reasons.length,
      statement,
    },
    metrics: [
      {
        value: metrics.corroborated_maturity,
        label: 'Corroborated Maturity',
        description: 'Maturity from pairs where both the capability and its related anti-pattern are resolved. Unknown pairs are excluded rather than scored as zero.',
        denominator: `${maturityModel.overall.fully_resolved_pair_count} of ${maturityTotal} pairs fully resolved`,
        trend: 'positive',
        color: '#0891b2',
      },
      {
        value: metrics.observed_maturity,
        label: 'Observed Maturity',
        description: 'Evidence-weighted maturity across fully and partially resolved pairs. Partial pairs contribute with half resolution credit.',
        denominator: `${metrics.assessment_resolution.toFixed(1)}% resolution · ${maturityModel.overall.partially_resolved_pair_count} partially resolved pairs`,
        trend: 'positive',
        color: '#7c3aed',
      },
      {
        value: metrics.adjusted_maturity,
        label: 'Adjusted FinOps Maturity',
        description: 'Observed Maturity adjusted by the square root of assessment resolution. This score drives CRAWL/WALK/RUN only when Assessment Sufficiency passes.',
        denominator: `${metrics.observed_maturity === null ? 'N/A' : metrics.observed_maturity.toFixed(1)} observed × √${(metrics.assessment_resolution / 100).toFixed(3)} resolution · sufficiency ${sufficiency.decision}`,
        trend: 'positive',
        color: '#059669',
      },
    ],
    antipatternDisposition: {
      confirmed,
      partial,
      testedAbsent,
      notAssessed,
      unresolved,
    },
  };
};
