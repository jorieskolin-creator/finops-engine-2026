import type { DiagnosticResult } from '../types';
import { FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';

export interface ReportMetricCard {
  value: number;
  label: string;
  description: string;
  denominator: string;
  trend: 'positive' | 'negative';
  color: string;
}

export interface ReportViewModel {
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

const percent = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;

export const buildReportViewModel = (result: DiagnosticResult): ReportViewModel => {
  const maturityTotal = FINOPS_CRITERIA.length;
  const antiPatternTotal = FINOPS_ANTIPATTERNS.length;
  const criterionTotal = maturityTotal + antiPatternTotal;
  const metrics = result.phase_2_validation.metrics;
  const scoreGapBreakdown = metrics.score_gap_breakdown || {
    maturity_full: 0,
    maturity_partial: 0,
    maturity_low_or_absent: 0,
    maturity_not_demonstrated: maturityTotal,
    maturity_verification_unresolved: 0,
    antipattern_tested_absent: 0,
    antipattern_partial_control: 0,
    antipattern_uncontrolled: 0,
    antipattern_not_assessed: antiPatternTotal,
    antipattern_verification_unresolved: 0,
  };
  const overallScoreAvailable = scoreGapBreakdown.maturity_verification_unresolved === 0
    && scoreGapBreakdown.antipattern_verification_unresolved === 0;
  const capabilityAttainment = metrics.capability_attainment ?? metrics.maturity_ratio ?? 0;
  const antipatternControl = metrics.antipattern_control ?? metrics.antipattern_clearance ?? 0;
  const rawMaturityScore = metrics.raw_finops_maturity_score ?? metrics.finops_readiness ?? 0;
  const maturityAssessedCount = metrics.maturity_assessed_count
    ?? scoreGapBreakdown.maturity_full + scoreGapBreakdown.maturity_partial + scoreGapBreakdown.maturity_low_or_absent;
  const antipatternScoreEligibleCount = metrics.antipattern_score_eligible_count
    ?? metrics.antipattern_assessed_count
    ?? scoreGapBreakdown.antipattern_tested_absent + scoreGapBreakdown.antipattern_uncontrolled;
  const evidenceCheck = result.quality_gate.evidence_check;
  const verificationCompleted = evidenceCheck
    ? evidenceCheck.items.filter(item => !item.adjudication_unresolved && !item.verification_unresolved).length
    : 0;
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

  return {
    actionability: {
      gate,
      planningDecision,
      confidence: String(confidence).toLowerCase(),
      blockerCount: result.quality_gate.blocking_reasons.length,
      statement,
    },
    metrics: [
      {
        value: metrics.evidence_density,
        label: 'Evidence Coverage',
        description: 'Share of the 60-criterion assessment surface supported by relevant, verified source evidence.',
        denominator: `${Math.round((metrics.evidence_density / 100) * criterionTotal)} of ${criterionTotal} criteria evidenced`,
        trend: 'positive',
        color: '#475569',
      },
      {
        value: percent(verificationCompleted, criterionTotal),
        label: 'Verification Completion',
        description: 'Share of required criterion-level evidence decisions that completed with a valid verdict.',
        denominator: `${verificationCompleted} of ${criterionTotal} decisions complete`,
        trend: 'positive',
        color: '#7c3aed',
      },
      {
        value: capabilityAttainment,
        label: 'Evidence-Based Capability',
        description: 'Supported capability questions across assessed criteria. Unknown criteria are excluded.',
        denominator: `${result.phase_2_validation.raw_counts.maturity_sub_criteria_met} of ${maturityAssessedCount * 3} assessed questions supported`,
        trend: 'positive',
        color: '#0891b2',
      },
      {
        value: antipatternControl,
        label: 'Anti-Pattern Control',
        description: 'Inverse of verified harmful-pattern burden. Unknown and not-assessed anti-patterns are excluded.',
        denominator: `${antipatternScoreEligibleCount} anti-patterns score-eligible · ${Math.max(antiPatternTotal - antipatternScoreEligibleCount, 0)} excluded`,
        trend: 'positive',
        color: '#7c3aed',
      },
      ...(overallScoreAvailable ? [{
        value: metrics.finops_readiness,
        label: 'FinOps Maturity Score',
        description: metrics.quality_gate_score_cap_reason
          || 'Equal-weight average of Evidence-Based Capability and Anti-Pattern Control.',
        denominator: metrics.quality_gate_score_cap_reason
          ? `${Math.round(rawMaturityScore)} calculated · capped at 70 because Quality Gate BLOCKED`
          : `${Math.round(capabilityAttainment)} capability · ${Math.round(antipatternControl)} anti-pattern control`,
        trend: 'positive',
        color: '#059669',
      } as ReportMetricCard] : []),
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
