
import goldenBaselines from '../knowledge_base/golden_baselines.json';

interface ScoreRange {
  min: number;
  max: number;
  rationale: string;
}

interface DriftResult {
  pack_id: string;
  timestamp: string;
  classification_match: boolean;
  expected_classification: string;
  actual_classification: string;
  readiness_in_range: boolean;
  expected_readiness_range: [number, number];
  actual_readiness: number;
  total_deviation: number;
  threshold_exceeded: boolean;
  criterion_violations: CriterionViolation[];
  summary: string;
}

interface CriterionViolation {
  stream: 'maturity' | 'antipattern';
  criterion_id: string;
  expected_min: number;
  expected_max: number;
  actual_score: number;
  deviation: number;
  rationale: string;
}

const policy = goldenBaselines.drift_policy;

export const runDriftCheck = (
  packId: string,
  phase1Logs: { maturity: Record<string, any>; antipattern: Record<string, any> },
  phase2Classification: string,
  phase2Readiness: number
): DriftResult => {
  const pack = (goldenBaselines.golden_packs as any)[packId];
  if (!pack) {
    throw new Error(`Unknown golden pack: ${packId}. Available: ${Object.keys(goldenBaselines.golden_packs).join(', ')}`);
  }

  const violations: CriterionViolation[] = [];
  let totalDeviation = 0;

  for (const stream of ['maturity', 'antipattern'] as const) {
    const expectedScores = pack.expected_scores[stream] as Record<string, ScoreRange>;
    const actualScores = phase1Logs[stream];

    for (const [criterionId, range] of Object.entries(expectedScores)) {
      const actual = actualScores[criterionId];
      const actualScore = typeof actual?.count === 'number' ? actual.count : -1;

      if (actualScore < 0) {
        violations.push({
          stream,
          criterion_id: criterionId,
          expected_min: range.min,
          expected_max: range.max,
          actual_score: actualScore,
          deviation: range.max,
          rationale: `Missing score (AI failure). ${range.rationale}`
        });
        totalDeviation += range.max;
        continue;
      }

      let deviation = 0;
      if (actualScore < range.min) deviation = range.min - actualScore;
      if (actualScore > range.max) deviation = actualScore - range.max;

      if (deviation > 0) {
        totalDeviation += deviation;
        violations.push({
          stream,
          criterion_id: criterionId,
          expected_min: range.min,
          expected_max: range.max,
          actual_score: actualScore,
          deviation,
          rationale: range.rationale
        });
      }
    }
  }

  const classificationMatch = phase2Classification.toLowerCase().includes(
    pack.expected_classification.toLowerCase()
  );

  const [rMin, rMax] = pack.expected_readiness_range;
  const readinessInRange = phase2Readiness >= rMin && phase2Readiness <= rMax;

  const thresholdExceeded = totalDeviation > policy.alert_threshold_aggregate;

  const criticalViolations = violations.filter(v => v.deviation >= policy.alert_threshold_per_criterion);

  let summary: string;
  if (thresholdExceeded || !classificationMatch) {
    summary = `DRIFT DETECTED: ${packId} — Total deviation ${totalDeviation} (threshold: ${policy.alert_threshold_aggregate}). `
      + `Classification: expected ${pack.expected_classification}, got ${phase2Classification}. `
      + `${criticalViolations.length} critical violations. `
      + `Model scoring behavior has likely changed. Investigate before deploying.`;
  } else if (violations.length > 0) {
    summary = `MINOR VARIANCE: ${packId} — ${violations.length} criteria outside expected range (total deviation: ${totalDeviation}). `
      + `Within acceptable limits. Classification correct: ${phase2Classification}.`;
  } else {
    summary = `CLEAN: ${packId} — All scores within expected ranges. Classification: ${phase2Classification}. No drift detected.`;
  }

  return {
    pack_id: packId,
    timestamp: new Date().toISOString(),
    classification_match: classificationMatch,
    expected_classification: pack.expected_classification,
    actual_classification: phase2Classification,
    readiness_in_range: readinessInRange,
    expected_readiness_range: pack.expected_readiness_range as [number, number],
    actual_readiness: phase2Readiness,
    total_deviation: totalDeviation,
    threshold_exceeded: thresholdExceeded,
    criterion_violations: violations,
    summary
  };
};

export const runFullDriftSuite = (
  results: Array<{
    packId: string;
    phase1Logs: { maturity: Record<string, any>; antipattern: Record<string, any> };
    classification: string;
    readiness: number;
  }>
): { results: DriftResult[]; overall_status: 'CLEAN' | 'MINOR_VARIANCE' | 'DRIFT_DETECTED'; report: string } => {
  const driftResults = results.map(r =>
    runDriftCheck(r.packId, r.phase1Logs, r.classification, r.readiness)
  );

  const anyDrift = driftResults.some(r => r.threshold_exceeded || !r.classification_match);
  const anyVariance = driftResults.some(r => r.criterion_violations.length > 0);

  const overall_status = anyDrift ? 'DRIFT_DETECTED' : anyVariance ? 'MINOR_VARIANCE' : 'CLEAN';

  const report = [
    `=== DRIFT DETECTION REPORT ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Packs tested: ${driftResults.length}`,
    `Overall status: ${overall_status}`,
    ``,
    ...driftResults.map(r => [
      `--- ${r.pack_id} ---`,
      `  Classification: ${r.actual_classification} (expected: ${r.expected_classification}) ${r.classification_match ? 'OK' : 'MISMATCH'}`,
      `  Readiness: ${Math.round(r.actual_readiness)}% (expected: ${r.expected_readiness_range[0]}-${r.expected_readiness_range[1]}%) ${r.readiness_in_range ? 'OK' : 'OUT OF RANGE'}`,
      `  Total deviation: ${r.total_deviation} (threshold: ${policy.alert_threshold_aggregate})`,
      `  Violations: ${r.criterion_violations.length}`,
      ...(r.criterion_violations.length > 0 ? [
        `  Top violations:`,
        ...r.criterion_violations
          .sort((a, b) => b.deviation - a.deviation)
          .slice(0, 5)
          .map(v => `    ${v.stream}.${v.criterion_id}: got ${v.actual_score}, expected ${v.expected_min}-${v.expected_max} (deviation: ${v.deviation})`)
      ] : []),
      ``
    ]).flat()
  ].join('\n');

  return { results: driftResults, overall_status, report };
};

export const getAvailableGoldenPacks = (): string[] => {
  return Object.keys(goldenBaselines.golden_packs);
};
