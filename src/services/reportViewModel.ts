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
        value: metrics.adjusted_maturity,
        label: 'Adjusted FinOps Maturity',
        description: 'Observed Maturity adjusted by the square root of assessment resolution. Drives CRAWL/WALK/RUN only when Assessment Sufficiency passes.',
        denominator: `${metrics.observed_maturity === null ? 'N/A' : metrics.observed_maturity.toFixed(1)} observed × √${(metrics.assessment_resolution / 100).toFixed(3)} resolution · sufficiency ${sufficiency.decision}`,
        trend: 'positive',
        color: '#059669',
      },
      {
        value: sufficiency.criterion_evidence_density,
        label: 'Criterion Evidence Density',
        description: 'Share of the 60 maturity and anti-pattern criteria assessed with verified evidence or governed tested absence. Must exceed 24% to pass sufficiency.',
        denominator: `${maturityModel.criterion_resolutions.filter(r => r.state === 'RESOLVED').length} of ${maturityModel.criterion_resolutions.length} criteria assessed · >24% floor, 60% target`,
        trend: 'positive',
        color: '#0891b2',
      },
      {
        value: metrics.assessment_resolution,
        label: 'Overall Assessment Resolution',
        description: 'Weighted share of the 30 capability/anti-pattern pairs resolved by evidence. Must exceed 24% to pass sufficiency.',
        denominator: `${maturityModel.overall.fully_resolved_pair_count} full + ${maturityModel.overall.partially_resolved_pair_count} partial of ${maturityTotal} pairs · >24% floor, 60% target`,
        trend: 'positive',
        color: '#7c3aed',
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
