import type { AuditItem, EvidenceCategory, Phase1AuditLogs, Phase2Validation } from '../types';
import { BATCH_TITLES, FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';

export const EVIDENCE_DENSITY_BLOCK = 30;
export const EVIDENCE_DENSITY_WARN = 60;

const clampPercent = (value: number): number => Math.min(Math.max(value, 0), 100);
const maturityCriterionTotal = Math.max(FINOPS_CRITERIA.length, 1);
const antipatternCriterionTotal = Math.max(FINOPS_ANTIPATTERNS.length, 1);
const totalCriterionCount = maturityCriterionTotal + antipatternCriterionTotal;
const maturityMaxScore = maturityCriterionTotal * 3;
const antipatternMaxScore = antipatternCriterionTotal * 3;

const hasSourceQuote = (item: AuditItem): boolean =>
  Array.isArray(item.evidence_quotes) &&
  item.evidence_quotes.some(q =>
    typeof q?.quote === 'string' &&
    q.quote.trim().length > 0 &&
    (q.evidence_source === undefined || q.evidence_source === 'text' || q.evidence_source === 'image')
  );

const hasVerifiedSourceCoverage = (item: AuditItem, stream: 'maturity' | 'antipattern'): boolean => {
  if (hasSourceQuote(item)) return true;
  if (item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') return false;
  if (stream === 'antipattern') {
    return inferAntiPatternAbsenceStatus(item) === 'tested_absent' && Boolean(item.coverage_reason);
  }
  return false;
};

const QUALITY_GATE_BLOCK_SCORE_CAP = 70;

export const applyQualityGateScoreCap = (
  phase2: Phase2Validation,
  decision: 'GO' | 'WARN' | 'BLOCK'
): Phase2Validation => {
  const metrics = phase2.metrics;
  const rawScore = metrics.raw_finops_maturity_score ?? metrics.uncapped_readiness ?? metrics.finops_readiness;
  metrics.raw_finops_maturity_score = rawScore;
  metrics.uncapped_readiness = rawScore;
  metrics.readiness_cap = decision === 'BLOCK' ? QUALITY_GATE_BLOCK_SCORE_CAP : 100;
  if (decision === 'BLOCK' && rawScore > QUALITY_GATE_BLOCK_SCORE_CAP) {
    metrics.finops_readiness = QUALITY_GATE_BLOCK_SCORE_CAP;
    metrics.quality_gate_score_cap = QUALITY_GATE_BLOCK_SCORE_CAP;
    metrics.quality_gate_score_cap_reason =
      `The calculated score was ${Math.round(rawScore)}%, but a BLOCKED assessment cannot report a FinOps Maturity Score above ${QUALITY_GATE_BLOCK_SCORE_CAP}%.`;
    metrics.readiness_cap_reason = metrics.quality_gate_score_cap_reason;
  } else {
    metrics.finops_readiness = rawScore;
    delete metrics.quality_gate_score_cap;
    delete metrics.quality_gate_score_cap_reason;
    delete metrics.readiness_cap_reason;
  }
  return phase2;
};

export const calculateMetrics = (logs: Phase1AuditLogs): Phase2Validation => {
  let maturityCount = 0; let maturitySum = 0; const maturityGaps: string[] = [];
  let antipatternCount = 0; let antipatternSum = 0; const antipatternFindings: string[] = [];
  let testedAbsentCount = 0;
  let assessedAntipatternCount = 0;
  let capabilityPoints = 0;
  let antipatternControlPoints = 0;
  let maturityFull = 0;
  let maturityPartial = 0;
  let maturityLowOrAbsent = 0;
  let maturityNotDemonstrated = 0;
  let antipatternTestedAbsent = 0;
  let antipatternPartialControl = 0;
  let antipatternUncontrolled = 0;
  let antipatternNotAssessed = 0;
  const verifiedAntipatternAbsences: string[] = [];
  const unknownAntipatternAbsences: string[] = [];
  const scoreEvidenceGaps: string[] = [];
  let deliveredItems = 0;
  let itemsWithEvidence = 0;
  const silentAreas: string[] = [];
  const categoryScores: Record<string, number> = Object.fromEntries(
    Object.keys(BATCH_TITLES).map(batch => [batch, 0])
  ) as Record<string, number>;
  const evidenceCategoryTotals: Partial<Record<EvidenceCategory, number>> = {};

  const tally = (item: AuditItem, stream: 'maturity' | 'antipattern') => {
    if (item.count !== -1) deliveredItems++;
    if (hasVerifiedSourceCoverage(item, stream)) {
      itemsWithEvidence++;
    }
    if (item.category_footprint) {
      for (const [cat, n] of Object.entries(item.category_footprint)) {
        const c = cat as EvidenceCategory;
        evidenceCategoryTotals[c] = (evidenceCategoryTotals[c] || 0) + (n as number);
      }
    }
  };

  Object.entries(logs.maturity).forEach(([key, rawItem]) => {
    const item = rawItem as AuditItem;
    tally(item, 'maturity');
    maturitySum += Math.max(item.count, 0);
    if (item.status === 'OK') maturityCount++;
    const hasCapabilityEvidence = hasVerifiedSourceCoverage(item, 'maturity');
    if (!hasCapabilityEvidence) {
      maturityNotDemonstrated++;
      scoreEvidenceGaps.push(
        `[${key}] Not demonstrated by the supplied material. This contributes zero to the score but is not proof that the capability is absent. Evidence needed: ${item.reasoning || item.evidence || 'current-state capability evidence.'}`
      );
    } else if (item.count === 3) {
      capabilityPoints += 1;
      maturityFull++;
    } else if (item.count === 2) {
      capabilityPoints += 0.5;
      maturityPartial++;
    } else {
      maturityLowOrAbsent++;
    }
    const catPrefix = key.charAt(0);
    if (categoryScores[catPrefix] !== undefined) categoryScores[catPrefix] += Math.max(item.count, 0);
    if (item.count === 0) {
      const hasGapEvidence = hasVerifiedSourceCoverage(item, 'maturity');
      if (!hasGapEvidence) silentAreas.push(`Capability not demonstrated by supplied material: ${key}`);
      maturityGaps.push(`[${key}] ${hasGapEvidence ? 'Confirmed gap' : 'Not demonstrated by supplied material (not proof the capability is absent)'}: ${item.reasoning}`);
    }
  });

  Object.entries(logs.antipattern).forEach(([key, rawItem]) => {
    const item = rawItem as AuditItem;
    tally(item, 'antipattern');
    const absenceStatus = inferAntiPatternAbsenceStatus(item);
    const effectiveBurdenCount =
      absenceStatus === 'confirmed_present'
        ? Math.max(item.count, 3)
        : absenceStatus === 'partially_present'
          ? Math.max(item.count, 1)
          : Math.max(item.count, 0);
    antipatternSum += effectiveBurdenCount;
    if (absenceStatus !== 'unknown_absent') assessedAntipatternCount++;
    if (absenceStatus === 'tested_absent') {
      testedAbsentCount++;
      antipatternControlPoints += 1;
      antipatternTestedAbsent++;
      verifiedAntipatternAbsences.push(`[${key}] Tested absent: ${item.coverage_reason || item.reasoning || item.evidence}`);
    }
    if (absenceStatus === 'unknown_absent') {
      antipatternNotAssessed++;
      unknownAntipatternAbsences.push(`[${key}] Not assessed: ${item.coverage_reason || item.reasoning || item.evidence || 'Source coverage was insufficient to verify absence.'}`);
      scoreEvidenceGaps.push(
        `[${key}] Anti-pattern control was not assessed. This contributes zero to the score, and no finding must be interpreted as tested absence. Evidence needed: ${item.coverage_reason || item.reasoning || 'material covering this anti-pattern.'}`
      );
    }
    if (absenceStatus === 'partially_present') {
      if (item.count === 1 && hasVerifiedSourceCoverage(item, 'antipattern')) {
        antipatternControlPoints += 0.5;
        antipatternPartialControl++;
      } else {
        antipatternUncontrolled++;
      }
    }
    if (absenceStatus === 'confirmed_present') {
      antipatternUncontrolled++;
    }
    if (absenceStatus === 'confirmed_present' || absenceStatus === 'partially_present') antipatternCount++;
    if (absenceStatus === 'confirmed_present' || absenceStatus === 'partially_present' || item.count > 0) {
      const findingLabel = absenceStatus === 'partially_present' ? 'Partial finding' : 'Finding';
      antipatternFindings.push(`[${key}] ${findingLabel}: ${item.evidence.substring(0, 100)}...`);
    }
  });

  const delivery_integrity = Math.round((deliveredItems / totalCriterionCount) * 100);
  const evidence_density = Math.round((itemsWithEvidence / totalCriterionCount) * 100);

  const maturity_ratio = (maturityCount / maturityCriterionTotal) * 100;
  const maturity_depth = (maturitySum / maturityMaxScore) * 100;
  const antipattern_ratio = (antipatternCount / antipatternCriterionTotal) * 100;
  const antipattern_burden = (antipatternSum / antipatternMaxScore) * 100;
  const antipattern_clearance = Math.round((testedAbsentCount / antipatternCriterionTotal) * 100);
  const antipattern_coverage = Math.round((assessedAntipatternCount / antipatternCriterionTotal) * 100);
  const antipattern_burden_confidence =
    antipatternSum > 0 || antipattern_coverage >= EVIDENCE_DENSITY_WARN
      ? 'confirmed'
      : 'unknown';

  const capability_attainment = clampPercent((capabilityPoints / maturityCriterionTotal) * 100);
  const antipattern_control = clampPercent((antipatternControlPoints / antipatternCriterionTotal) * 100);
  const raw_finops_maturity_score = clampPercent((capability_attainment + antipattern_control) / 2);
  const finops_readiness = raw_finops_maturity_score;

  let crawl_walk_run: Phase2Validation['crawl_walk_run'];
  if (evidence_density < EVIDENCE_DENSITY_BLOCK) {
    crawl_walk_run = 'Insufficient evidence';
  } else if (finops_readiness < 33) {
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
      antipattern_clearance,
      antipattern_coverage,
      capability_attainment,
      antipattern_control,
      raw_finops_maturity_score,
      finops_readiness,
      uncapped_readiness: raw_finops_maturity_score,
      readiness_cap: 100,
      score_gap_breakdown: {
        maturity_full: maturityFull,
        maturity_partial: maturityPartial,
        maturity_low_or_absent: maturityLowOrAbsent,
        maturity_not_demonstrated: maturityNotDemonstrated,
        antipattern_tested_absent: antipatternTestedAbsent,
        antipattern_partial_control: antipatternPartialControl,
        antipattern_uncontrolled: antipatternUncontrolled,
        antipattern_not_assessed: antipatternNotAssessed,
      },
      antipattern_burden_confidence,
      delivery_integrity,
      evidence_density
    },
    raw_counts: {
      maturity_sub_criteria_met: maturitySum,
      antipattern_sub_criteria_met: antipatternSum
    },
    maturity_gaps: maturityGaps,
    antipattern_findings: antipatternFindings,
    verified_antipattern_absences: verifiedAntipatternAbsences,
    unknown_antipattern_absences: unknownAntipatternAbsences,
    silent_areas: silentAreas,
    score_evidence_gaps: scoreEvidenceGaps,
    category_scores: categoryScores,
    evidence_category_totals: evidenceCategoryTotals,
    crawl_walk_run
  };
};
