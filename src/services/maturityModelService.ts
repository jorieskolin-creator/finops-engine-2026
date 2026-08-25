import type {
  AntiPatternAbsenceStatus,
  AssessmentSufficiencyResult,
  AuditItem,
  CapabilityId,
  DomainId,
  KnowledgeStream,
  MaturityCriterionEvidenceBasis,
  MaturityCriterionResolutionReason,
  MaturityCriterionResolutionRecord,
  MaturityPairRegistry,
  MaturityPairRegistryEntry,
  MaturityPairResult,
  MaturityAggregate,
  Phase1AuditLogs,
  ResolutionBasedMaturityRunTrace,
  ResolutionBasedMaturityModel,
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
): MaturityPairResult => {
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

const aggregate = (pairs: MaturityPairResult[]): MaturityAggregate => {
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

export const calculateResolutionBasedMaturity = (
  logs: Phase1AuditLogs,
  registry: MaturityPairRegistry = FINOPS_MATURITY_PAIR_REGISTRY,
): ResolutionBasedMaturityModel => {
  if (registry.status !== 'ACTIVE') throw new Error('MATURITY_MODEL_REGISTRY_NOT_ACTIVE');
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
    schema_version: 'resolution_based_maturity_model_v1',
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

const SUFFICIENCY_THRESHOLDS = {
  criterion_evidence_density: 30,
  overall_resolution: 30,
  evidence_warning_below: 60,
  silent_domain_density_below: 10,
  provenance_integrity: 100,
} as const;

export const evaluateAssessmentSufficiency = (
  model: ResolutionBasedMaturityModel,
  options: { evidencePacketReady?: boolean } = {},
): AssessmentSufficiencyResult => {
  const resolvedCriteria = model.criterion_resolutions.filter(record => record.state === 'RESOLVED');
  const criterionEvidenceDensity = Math.round((resolvedCriteria.length / Math.max(model.criterion_resolutions.length, 1)) * 1000) / 10;
  const verificationUnresolvedCount = model.criterion_resolutions.filter(record => record.state === 'VERIFICATION_UNRESOLVED').length;
  const provenanceIntegrity = resolvedCriteria.every(record => record.evidence_basis !== 'NONE') ? 100 : 0;
  const domainResolution = Object.fromEntries(model.domains.map(domain => [domain.domain_id, domain.resolution])) as Record<DomainId, number>;
  const domainCriterionEvidenceDensity = Object.fromEntries((['A', 'B', 'C', 'D', 'E', 'F'] as DomainId[]).map(domainId => {
    const records = model.criterion_resolutions.filter(record => record.domain_id === domainId);
    const resolved = records.filter(record => record.state === 'RESOLVED').length;
    return [domainId, Math.round((resolved / Math.max(records.length, 1)) * 1000) / 10];
  })) as Record<DomainId, number>;
  const silentDomainIds = (Object.entries(domainCriterionEvidenceDensity) as Array<[DomainId, number]>)
    .filter(([, density]) => density < SUFFICIENCY_THRESHOLDS.silent_domain_density_below)
    .map(([domainId]) => domainId);
  const evidencePacketReady = options.evidencePacketReady !== false;
  const blockingReasons: string[] = [];
  const warningReasons: string[] = [];
  if (criterionEvidenceDensity < SUFFICIENCY_THRESHOLDS.criterion_evidence_density) {
    blockingReasons.push(`Criterion evidence density ${criterionEvidenceDensity}% is below ${SUFFICIENCY_THRESHOLDS.criterion_evidence_density}%.`);
  }
  if (model.overall.resolution < SUFFICIENCY_THRESHOLDS.overall_resolution) {
    blockingReasons.push(`Overall assessment resolution ${model.overall.resolution}% is below ${SUFFICIENCY_THRESHOLDS.overall_resolution}%.`);
  }
  if (criterionEvidenceDensity >= SUFFICIENCY_THRESHOLDS.criterion_evidence_density
    && criterionEvidenceDensity < SUFFICIENCY_THRESHOLDS.evidence_warning_below) {
    warningReasons.push(`Criterion evidence density ${criterionEvidenceDensity}% is below the ${SUFFICIENCY_THRESHOLDS.evidence_warning_below}% confidence target.`);
  }
  if (model.overall.resolution >= SUFFICIENCY_THRESHOLDS.overall_resolution
    && model.overall.resolution < SUFFICIENCY_THRESHOLDS.evidence_warning_below) {
    warningReasons.push(`Overall assessment resolution ${model.overall.resolution}% is below the ${SUFFICIENCY_THRESHOLDS.evidence_warning_below}% confidence target.`);
  }
  if (silentDomainIds.length > 0) {
    warningReasons.push(`Domain evidence is silent below ${SUFFICIENCY_THRESHOLDS.silent_domain_density_below}% for ${silentDomainIds.join(', ')}; collect evidence instead of prescribing domain remediation.`);
  }
  if (provenanceIntegrity < SUFFICIENCY_THRESHOLDS.provenance_integrity) {
    blockingReasons.push('Resolved maturity inputs are not fully provenance-bound.');
  }
  if (verificationUnresolvedCount > 0) {
    blockingReasons.push(`${verificationUnresolvedCount} criterion verification decision(s) remain unresolved.`);
  }
  if (!evidencePacketReady) blockingReasons.push('The effective Evidence Package is not ready.');

  return {
    schema_version: 'assessment_sufficiency_v1',
    policy_version: 'assessment_sufficiency_policy_v2',
    decision: blockingReasons.length === 0 ? 'PASS' : 'BLOCK',
    scoring_authority: true,
    thresholds: SUFFICIENCY_THRESHOLDS,
    criterion_evidence_density: criterionEvidenceDensity,
    overall_resolution: model.overall.resolution,
    domain_resolution: domainResolution,
    domain_criterion_evidence_density: domainCriterionEvidenceDensity,
    silent_domain_ids: silentDomainIds,
    provenance_integrity: provenanceIntegrity,
    evidence_packet_status: evidencePacketReady ? 'READY' : 'NOT_READY',
    verification_unresolved_count: verificationUnresolvedCount,
    blocking_reasons: blockingReasons,
    warning_reasons: warningReasons,
    kb_completeness_excluded: true,
  };
};

export const maturityRunTraceProjection = (
  model: ResolutionBasedMaturityModel,
  assessmentSufficiency: AssessmentSufficiencyResult,
): ResolutionBasedMaturityRunTrace => ({
  schema_version: 'resolution_based_maturity_run_trace_v1',
  formula_version: model.formula_version,
  registry_version: model.registry_version,
  mode: model.mode,
  scoring_authority: true,
  gamma: model.gamma,
  overall: { ...model.overall },
  domains: model.domains.map(domain => ({ ...domain })),
  assessment_sufficiency: assessmentSufficiency,
});
