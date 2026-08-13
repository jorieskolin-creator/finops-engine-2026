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
  const evidenceCheck = result.quality_gate.evidence_check;
  const verificationCompleted = evidenceCheck
    ? evidenceCheck.items.filter(item => !item.adjudication_unresolved).length
    : 0;
  const unresolvedAntiPatternIds = new Set(
    evidenceCheck?.items
      .filter(item => item.stream === 'antipattern' && item.adjudication_unresolved)
      .map(item => item.id) || []
  );

  let confirmed = 0;
  let partial = 0;
  let testedAbsent = 0;
  let notAssessed = 0;
  let assessedBurdenPoints = 0;
  let assessedCount = 0;

  for (const criterion of FINOPS_ANTIPATTERNS) {
    const item = result.phase_1_audit_logs.antipattern[criterion.id];
    const status = inferAntiPatternAbsenceStatus(item);
    if (status === 'confirmed_present') {
      confirmed++;
      assessedCount++;
      assessedBurdenPoints += Math.max(item?.count || 0, 3);
    } else if (status === 'partially_present') {
      partial++;
      assessedCount++;
      assessedBurdenPoints += Math.max(item?.count || 0, 1);
    } else if (status === 'tested_absent') {
      testedAbsent++;
      assessedCount++;
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
        value: result.phase_2_validation.metrics.evidence_density,
        label: 'Evidence Coverage',
        description: 'Share of the 60-criterion assessment surface supported by relevant, verified source evidence.',
        denominator: `${Math.round((result.phase_2_validation.metrics.evidence_density / 100) * criterionTotal)} of ${criterionTotal} criteria evidenced`,
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
        value: result.phase_2_validation.metrics.maturity_depth,
        label: 'Observed Maturity',
        description: 'Verified maturity points demonstrated across the complete FinOps assessment framework.',
        denominator: `${result.phase_2_validation.raw_counts.maturity_sub_criteria_met} of ${maturityTotal * 3} maturity points`,
        trend: 'positive',
        color: '#0891b2',
      },
      {
        value: percent(assessedBurdenPoints, assessedCount * 3),
        label: 'Observed Friction',
        description: 'Anti-pattern severity on the meaningfully assessed surface. Unassessed criteria are not treated as healthy.',
        denominator: assessedCount > 0
          ? `${assessedBurdenPoints} of ${assessedCount * 3} possible points across ${assessedCount} assessed criteria`
          : 'No anti-pattern criteria were sufficiently assessed',
        trend: 'negative',
        color: '#e11d48',
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
