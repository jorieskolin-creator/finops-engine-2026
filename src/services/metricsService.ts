import type { AuditItem, EvidenceCategory, Phase1AuditLogs, Phase2Validation } from '../types';

export const EVIDENCE_DENSITY_BLOCK = 30;
export const EVIDENCE_DENSITY_WARN = 60;

const clampPercent = (value: number): number => Math.min(Math.max(value, 0), 100);

const evidenceCapForDensity = (density: number): { cap: number; reason?: string } => {
  if (density < EVIDENCE_DENSITY_BLOCK) {
    return {
      cap: density,
      reason: `Evidence density ${density}% is below the ${EVIDENCE_DENSITY_BLOCK}% floor, so readiness is capped by available evidence.`
    };
  }
  if (density < EVIDENCE_DENSITY_WARN) {
    return {
      cap: EVIDENCE_DENSITY_WARN,
      reason: `Evidence density ${density}% is below ${EVIDENCE_DENSITY_WARN}%, so readiness is capped until more current-state evidence is supplied.`
    };
  }
  return { cap: 100 };
};

export const calculateMetrics = (logs: Phase1AuditLogs): Phase2Validation => {
  let maturityCount = 0; let maturitySum = 0; const maturityGaps: string[] = [];
  let antipatternCount = 0; let antipatternSum = 0; const antipatternFindings: string[] = [];
  let deliveredItems = 0;
  let itemsWithEvidence = 0;
  let antipatternItemsWithEvidence = 0;
  const silentAreas: string[] = [];
  const categoryScores: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const evidenceCategoryTotals: Partial<Record<EvidenceCategory, number>> = {};

  const tally = (item: AuditItem, stream: 'maturity' | 'antipattern') => {
    if (item.count !== -1) deliveredItems++;
    if (item.evidence_quotes && item.evidence_quotes.length > 0) {
      itemsWithEvidence++;
      if (stream === 'antipattern') antipatternItemsWithEvidence++;
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
    const catPrefix = key.charAt(0);
    if (categoryScores[catPrefix] !== undefined) categoryScores[catPrefix] += Math.max(item.count, 0);
    if (item.count === 0) {
      silentAreas.push(`Missing Capability: ${key}`);
      maturityGaps.push(`[${key}] Missing: ${item.reasoning}`);
    }
  });

  Object.entries(logs.antipattern).forEach(([key, rawItem]) => {
    const item = rawItem as AuditItem;
    tally(item, 'antipattern');
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
  const antipattern_burden_confidence =
    antipatternSum > 0 || (evidence_density >= EVIDENCE_DENSITY_WARN && antipatternItemsWithEvidence >= 8)
      ? 'confirmed'
      : 'unknown';

  const burdenPenalty = antipattern_burden * 0.5;
  const uncapped_readiness = clampPercent(maturity_depth - burdenPenalty);
  const evidenceCap = evidenceCapForDensity(evidence_density);
  const finops_readiness = clampPercent(Math.min(uncapped_readiness, evidenceCap.cap));

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
      finops_readiness,
      uncapped_readiness,
      readiness_cap: evidenceCap.cap,
      readiness_cap_reason: evidenceCap.reason,
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
    silent_areas: silentAreas,
    category_scores: categoryScores,
    evidence_category_totals: evidenceCategoryTotals,
    crawl_walk_run
  };
};
