import type {
  AntiPatternAbsenceStatus,
  AuditItem,
  CapabilityId,
  DomainId,
  KnowledgeStream,
  MaturityCriterionEvidenceBasis,
  MaturityCriterionResolutionReason,
  MaturityCriterionResolutionRecord,
  MaturityPairRegistry,
  MaturityPairRegistryEntry,
  MaturityPairShadowResult,
  MaturityShadowAggregate,
  Phase1AuditLogs,
  ResolutionBasedMaturityShadow,
} from '../types';
import { FINOPS_MATURITY_PAIR_REGISTRY } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';

const GAMMA = 0.5 as const;

const roundedPercent = (value: number): number => Math.round(value * 1000) / 10;

const evidenceBasis = (item: AuditItem | undefined): MaturityCriterionEvidenceBasis => {
  if (!item || !Array.isArray(item.evidence_quotes)) return 'NONE';
  const direct = item.evidence_quotes.some(quote =>
    quote?.evidence_source !== 'derived'
    && typeof quote?.quote === 'string'
    && quote.quote.trim().length >= 4
    && typeof quote.source_id === 'string'
    && quote.source_id.length > 0
    && typeof quote.chunk_id === 'string'
    && quote.chunk_id.length > 0
  );
  const derived = item.evidence_quotes.some(quote =>
    quote?.evidence_source === 'derived'
    && typeof quote?.quote === 'string'
    && quote.quote.trim().length >= 4
    && typeof quote.source_id === 'string'
    && quote.source_id.length > 0
    && typeof quote.derived_evidence_id === 'string'
    && quote.derived_evidence_id.length > 0
  );
  if (direct && derived) return 'DIRECT_AND_DERIVED';
  if (direct) return 'DIRECT';
  if (derived) return 'DERIVED';
  return 'NONE';
};

const unresolvedRecord = (
  stream: KnowledgeStream,
  id: CapabilityId,
  reason: MaturityCriterionResolutionReason,
  basis: MaturityCriterionEvidenceBasis = 'NONE',
  antipatternStatus?: AntiPatternAbsenceStatus,
): MaturityCriterionResolutionRecord => ({
  schema_version: 'maturity_criterion_resolution_v1',
  stream,
  criterion_id: id,
  domain_id: id.charAt(0) as DomainId,
  state: reason === 'VERIFICATION_UNRESOLVED' ? 'VERIFICATION_UNRESOLVED' : 'UNKNOWN',
  reason,
  evidence_basis: basis,
  score_count: null,
  normalized_value: null,
  ...(antipatternStatus ? { antipattern_absence_status: antipatternStatus } : {}),
});

const resolvedRecord = (
  stream: KnowledgeStream,
  id: CapabilityId,
  count: number,
  value: number,
  basis: MaturityCriterionEvidenceBasis,
  reason: MaturityCriterionResolutionReason,
  antipatternStatus?: AntiPatternAbsenceStatus,
): MaturityCriterionResolutionRecord => ({
  schema_version: 'maturity_criterion_resolution_v1',
  stream,
  criterion_id: id,
  domain_id: id.charAt(0) as DomainId,
  state: 'RESOLVED',
  reason,
  evidence_basis: basis,
  score_count: count,
  normalized_value: value,
  ...(antipatternStatus ? { antipattern_absence_status: antipatternStatus } : {}),
});

const resolveCapability = (id: CapabilityId, item: AuditItem | undefined): MaturityCriterionResolutionRecord => {
  if (item?.verification_unresolved) return unresolvedRecord('maturity', id, 'VERIFICATION_UNRESOLVED');
  const basis = evidenceBasis(item);
  if (!item || item.assessment_status !== 'assessed' || basis === 'NONE'
    || item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') {
    return unresolvedRecord('maturity', id, 'NO_GOVERNED_EVIDENCE', basis);
  }
  const count = Math.min(Math.max(Math.round(item.count), 0), 3);
  return resolvedRecord('maturity', id, count, count / 3, basis, 'PROVENANCE_BOUND_EVIDENCE');
};

const resolveAntipattern = (id: CapabilityId, item: AuditItem | undefined): MaturityCriterionResolutionRecord => {
  if (item?.verification_unresolved) return unresolvedRecord('antipattern', id, 'VERIFICATION_UNRESOLVED');
  const status = inferAntiPatternAbsenceStatus(item);
  if (
    item
    && status === 'tested_absent'
    && item.count === 0
    && item.assessment_status === 'assessed'
    && item.evidence_check_status === 'supported'
    && typeof item.coverage_reason === 'string'
    && item.coverage_reason.trim().length > 0
  ) {
    return resolvedRecord('antipattern', id, 0, 1, 'TESTED_ABSENCE', 'GOVERNED_TESTED_ABSENCE', status);
  }

  const basis = evidenceBasis(item);
  const count = item ? Math.min(Math.max(Math.round(item.count), 0), 3) : 0;
  const dispositionConsistent = status === 'confirmed_present' ? count === 3 : status === 'partially_present' && (count === 1 || count === 2);
  if ((status === 'confirmed_present' || status === 'partially_present') && !dispositionConsistent) {
    return unresolvedRecord('antipattern', id, 'INCONSISTENT_DISPOSITION', basis, status);
  }
  if (!item || status === 'unknown_absent' || item.assessment_status !== 'assessed' || basis === 'NONE'
    || item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') {
    return unresolvedRecord('antipattern', id, 'NO_GOVERNED_EVIDENCE', basis, status);
  }
  return resolvedRecord('antipattern', id, count, (3 - count) / 3, basis, 'PROVENANCE_BOUND_EVIDENCE', status);
};

export const buildMaturityCriterionResolutions = (
  logs: Phase1AuditLogs,
  registry: MaturityPairRegistry = FINOPS_MATURITY_PAIR_REGISTRY,
): MaturityCriterionResolutionRecord[] => registry.pairs.flatMap(pair => [
  resolveCapability(pair.capability_id, logs.maturity[pair.capability_id]),
  resolveAntipattern(pair.antipattern_id, logs.antipattern[pair.antipattern_id]),
]);

const pairResult = (
  pair: MaturityPairRegistryEntry,
  capability: MaturityCriterionResolutionRecord,
  antipattern: MaturityCriterionResolutionRecord,
): MaturityPairShadowResult => {
  const capabilityValue = capability.normalized_value;
  const antipatternHealth = antipattern.normalized_value;
  const capabilityResolved = capabilityValue !== null;
  const antipatternResolved = antipatternHealth !== null;
  const resolutionCredit = capabilityResolved && antipatternResolved ? 1 : capabilityResolved || antipatternResolved ? 0.5 : 0;
  const state = capabilityResolved && antipatternResolved
    ? 'BOTH_RESOLVED'
    : capabilityResolved
      ? 'CAPABILITY_ONLY'
      : antipatternResolved
        ? 'ANTIPATTERN_ONLY'
        : 'UNRESOLVED';
  const corroborated = capabilityResolved && antipatternResolved
    ? (1 - pair.interaction_strength) * ((capabilityValue + antipatternHealth) / 2)
      + pair.interaction_strength * Math.sqrt(capabilityValue * antipatternHealth)
    : null;
  const observed = corroborated ?? (capabilityResolved ? capabilityValue : antipatternResolved ? antipatternHealth : null);
  const contradiction = capabilityResolved && antipatternResolved
    ? capabilityValue >= 2 / 3 && antipatternHealth <= 1 / 3
      ? 'DETECTED'
      : 'NONE'
    : 'NOT_EVALUABLE';

  return {
    pair_id: pair.pair_id,
    domain_id: pair.domain_id,
    relationship_type: pair.relationship_type,
    interaction_strength: pair.interaction_strength,
    weight: pair.weight,
    state,
    resolution_credit: resolutionCredit,
    capability_value: capabilityValue,
    antipattern_health: antipatternHealth,
    observed_pair_value: observed,
    corroborated_pair_value: corroborated,
    contradiction_status: contradiction,
  };
};

const aggregate = (pairs: MaturityPairShadowResult[]): MaturityShadowAggregate => {
  const configuredWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  const corroboratedPairs = pairs.filter(pair => pair.corroborated_pair_value !== null);
  const corroboratedWeight = corroboratedPairs.reduce((sum, pair) => sum + pair.weight, 0);
  const observedWeight = pairs.reduce((sum, pair) => sum + pair.weight * pair.resolution_credit, 0);
  const corroborated = corroboratedWeight > 0
    ? corroboratedPairs.reduce((sum, pair) => sum + pair.weight * pair.corroborated_pair_value!, 0) / corroboratedWeight
    : null;
  const observed = observedWeight > 0
    ? pairs.reduce((sum, pair) => sum + pair.weight * pair.resolution_credit * (pair.observed_pair_value ?? 0), 0) / observedWeight
    : null;
  const resolution = configuredWeight > 0 ? observedWeight / configuredWeight : 0;

  return {
    corroborated_maturity: corroborated === null ? null : roundedPercent(corroborated),
    observed_maturity: observed === null ? null : roundedPercent(observed),
    resolution: roundedPercent(resolution),
    adjusted_maturity: observed === null ? null : roundedPercent(observed * Math.pow(resolution, GAMMA)),
    fully_resolved_pair_count: pairs.filter(pair => pair.state === 'BOTH_RESOLVED').length,
    partially_resolved_pair_count: pairs.filter(pair => pair.state === 'CAPABILITY_ONLY' || pair.state === 'ANTIPATTERN_ONLY').length,
    unresolved_pair_count: pairs.filter(pair => pair.state === 'UNRESOLVED').length,
    contradiction_count: pairs.filter(pair => pair.contradiction_status === 'DETECTED').length,
  };
};

export const calculateResolutionBasedMaturityShadow = (
  logs: Phase1AuditLogs,
  registry: MaturityPairRegistry = FINOPS_MATURITY_PAIR_REGISTRY,
): ResolutionBasedMaturityShadow => {
  if (registry.status !== 'SHADOW_NOT_ACTIVE') throw new Error('MATURITY_SHADOW_REGISTRY_NOT_SHADOW');
  const criterionResolutions = buildMaturityCriterionResolutions(logs, registry);
  const byKey = new Map(criterionResolutions.map(record => [`${record.stream}.${record.criterion_id}`, record]));
  const pairs = registry.pairs.map(pair => pairResult(
    pair,
    byKey.get(`maturity.${pair.capability_id}`)!,
    byKey.get(`antipattern.${pair.antipattern_id}`)!,
  ));
  const domains = (['A', 'B', 'C', 'D', 'E', 'F'] as DomainId[]).map(domainId => ({
    domain_id: domainId,
    ...aggregate(pairs.filter(pair => pair.domain_id === domainId)),
  }));

  return {
    schema_version: 'resolution_based_maturity_shadow_v1',
    formula_version: 'resolution_based_maturity_formula_v1',
    registry_version: registry.registry_version,
    mode: registry.status,
    gamma: GAMMA,
    criterion_resolutions: criterionResolutions,
    pair_results: pairs,
    overall: aggregate(pairs),
    domains,
  };
};
