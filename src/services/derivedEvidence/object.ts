import type { DerivedAnalyticalEvidence } from '../../types';

export const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

export const LLM_POLICY = {
  may_use_as_evidence: true,
  may_recalculate: false as const,
  may_infer_exact_values: false as const,
  causal_authority: 'NONE' as const,
};

export const emptyCostBasis = {
  state: 'NOT_PRESENT' as const,
  column_index: null,
  source_column_number: null,
  currencies: [] as string[],
  excluded_row_count: 0,
};

export const qualityFor = (n: number, complete: boolean, limitation: string | null): NonNullable<DerivedAnalyticalEvidence['quality']> => ({
  population_coverage: !complete ? 'LOW' : n >= 20 ? 'HIGH' : n >= 6 ? 'MODERATE' : 'LOW',
  confidence: !complete ? 'LOW' : n >= 20 ? 'HIGH' : n >= 6 ? 'MODERATE' : 'LOW',
  limitation,
});

export const baseResult = (
  status: DerivedAnalyticalEvidence['result']['status'],
  sourceRowCount: number,
  analyzed: number,
  rowScope: DerivedAnalyticalEvidence['result']['row_scope'],
  rowTruncated: boolean,
  extra: Partial<DerivedAnalyticalEvidence['result']> = {}
): DerivedAnalyticalEvidence['result'] => ({
  status,
  source_row_count: sourceRowCount,
  withheld_source_row_count: extra.withheld_source_row_count ?? 0,
  withheld_source_column_count: extra.withheld_source_column_count ?? 0,
  analyzed_row_count: analyzed,
  eligible_row_count: extra.eligible_row_count ?? analyzed,
  excluded_total_row_count: extra.excluded_total_row_count ?? 0,
  row_scope: rowScope,
  row_truncated: rowTruncated,
  detected_signal_count: extra.detected_signal_count ?? (status === 'OBSERVED' ? 1 : 0),
  mapping_population_coverage: null,
  tagging_population_coverage: null,
  allocation_population_coverage: null,
  field_coverage: [],
  cost_basis: extra.cost_basis ?? emptyCostBasis,
  reconciliation: extra.reconciliation ?? { state: 'NOT_AVAILABLE' },
  ...extra,
});

export const buildDerived = (input: {
  analyzerId: DerivedAnalyticalEvidence['derivation']['analyzer_id'];
  analyzerVersion: string;
  method: DerivedAnalyticalEvidence['derivation']['method'];
  calculationIds: string[];
  sourceId: string;
  targets: DerivedAnalyticalEvidence['targets'];
  result: DerivedAnalyticalEvidence['result'];
  summaryLines: string[];
  locator: DerivedAnalyticalEvidence['locator'];
  eligibilityReasons: string[];
  fingerprintSeed: string;
  quality: NonNullable<DerivedAnalyticalEvidence['quality']>;
  mayUseAsEvidence?: boolean;
}): DerivedAnalyticalEvidence => {
  const observedEligible = input.eligibilityReasons.length === 0 && input.result.status === 'OBSERVED';
  const signature = [
    'derived_analytical_evidence_v1',
    input.analyzerId,
    input.analyzerVersion,
    'evidence_analysis_registry_v2',
    input.method,
    input.sourceId,
    hash(input.fingerprintSeed),
  ].join('|');
  return {
    schema_version: 'derived_analytical_evidence_v1',
    mode: observedEligible ? 'authoritative' : 'shadow',
    evidence_id: `EVID-DER-${hash(signature)}`,
    evidence_type: 'deterministic_analytical',
    source_id: input.sourceId,
    targets: input.targets,
    derivation: {
      analyzer_id: input.analyzerId,
      analyzer_version: input.analyzerVersion,
      registry_version: 'evidence_analysis_registry_v2',
      method: input.method,
      calculation_ids: input.calculationIds,
    },
    result: input.result,
    summary_lines: input.summaryLines,
    locator: input.locator,
    eligibility: { state: observedEligible ? 'ELIGIBLE' : 'INELIGIBLE', reasons: input.eligibilityReasons },
    unit_fingerprint: hash(signature),
    report_eligible: observedEligible,
    raw_value_exposure: false,
    quality: input.quality,
    llm_policy: { ...LLM_POLICY, may_use_as_evidence: input.mayUseAsEvidence ?? observedEligible },
  };
};
