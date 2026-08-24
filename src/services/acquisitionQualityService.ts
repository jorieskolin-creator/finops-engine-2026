import type {
  AcquisitionQualitySnapshot,
  AcquisitionQualityPersistence,
  AuditItem,
  BoundedRetrievalTrace,
  DataSignalCoverageReport,
  DerivedAnalyticalEvidence,
  EvidenceCategory,
  KnowledgeBaseRuntimeStatus,
  Phase1AuditLogs,
  Phase2Validation,
  RunTrace,
  RetrievalStopReason,
  ShadowTelemetryPersistence,
  SourceRegistryRuntimeStatus
} from '../types';

const EVIDENCE_CATEGORY_COUNT = 7;
const EXPECTED_KB_DOCUMENT_COUNT = 60;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));
const normalizeEvidenceText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

const entries = (logs: Phase1AuditLogs) => [
  ...Object.entries(logs.maturity).map(([id, item]) => ({ id, stream: 'maturity' as const, item })),
  ...Object.entries(logs.antipattern).map(([id, item]) => ({ id, stream: 'antipattern' as const, item }))
];

const isCovered = (item: AuditItem, stream: 'maturity' | 'antipattern'): boolean => {
  if ((item.evidence_quotes || []).some(quote => quote.quote?.trim())) return true;
  if (item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') return false;
  return stream === 'antipattern'
    && item.antipattern_absence_status === 'tested_absent'
    && Boolean(item.coverage_reason);
};

const statusWeight = (item: AuditItem): number => {
  if (item.evidence_check_status === 'supported') return 1;
  if (item.evidence_check_status === 'weak') return 0.5;
  return 0;
};

export const buildAcquisitionQualitySnapshot = (input: {
  logs: Phase1AuditLogs;
  phase2: Phase2Validation;
  sourceRegistry: SourceRegistryRuntimeStatus;
  knowledgeBase: KnowledgeBaseRuntimeStatus;
  runTrace: RunTrace;
}): AcquisitionQualitySnapshot => {
  const manifestSourceIds = new Set(input.runTrace.input_manifest.map(source => source.source_id));
  const sourceIdByChunk = new Map(input.runTrace.input_manifest.flatMap(
    source => source.chunk_ids.map(chunkId => [chunkId, source.source_id] as const)
  ));
  const resolveSource = (attribution: { source_id?: string; chunk_id?: string }): string | undefined => {
    if (attribution.source_id && !manifestSourceIds.has(attribution.source_id)) return undefined;
    if (attribution.chunk_id && !sourceIdByChunk.has(attribution.chunk_id)) return undefined;
    const candidateSets = [
      attribution.source_id ? new Set([attribution.source_id]) : undefined,
      attribution.chunk_id ? new Set([sourceIdByChunk.get(attribution.chunk_id)!]) : undefined
    ].filter((value): value is Set<string> => Boolean(value));
    if (candidateSets.length === 0) return undefined;
    const intersection = [...candidateSets[0]].filter(candidate => candidateSets.every(set => set.has(candidate)));
    return intersection.length === 1 ? intersection[0] : undefined;
  };
  const allEntries = entries(input.logs);
  const coveredEntries = allEntries.filter(({ item, stream }) => isCovered(item, stream));
  const maturityEntries = allEntries.filter(entry => entry.stream === 'maturity');
  const antipatternEntries = allEntries.filter(entry => entry.stream === 'antipattern');
  const maturityCovered = maturityEntries.filter(({ item, stream }) => isCovered(item, stream)).length;
  const antipatternCovered = antipatternEntries.filter(({ item, stream }) => isCovered(item, stream)).length;

  const domainCoverage: AcquisitionQualitySnapshot['evidence']['coverage']['by_domain'] = {};
  for (const { id, stream, item } of allEntries) {
    const domain = id.replace(/^AP-/, '').charAt(0) || '?';
    const current = domainCoverage[domain] || { covered_items: 0, total_items: 0, completeness: 0 };
    current.total_items++;
    if (isCovered(item, stream)) current.covered_items++;
    current.completeness = clampPercent((current.covered_items / current.total_items) * 100);
    domainCoverage[domain] = current;
  }

  const verifiedStrength = coveredEntries.length > 0
    ? clampPercent((coveredEntries.reduce((sum, entry) => sum + statusWeight(entry.item), 0) / coveredEntries.length) * 100)
    : 0;
  const sourceDiversity = coveredEntries.length > 0
    ? clampPercent((coveredEntries.reduce((sum, { item }) => {
        const sources = new Set((item.evidence_quotes || []).map(resolveSource).filter(Boolean));
        return sum + Math.min(sources.size / 2, 1);
      }, 0) / coveredEntries.length) * 100)
    : 0;
  const categories = new Set<EvidenceCategory>();
  for (const { item } of coveredEntries) {
    for (const quote of item.evidence_quotes || []) {
      if (quote.category && resolveSource(quote)) categories.add(quote.category);
    }
  }
  const categoryDenominator = Math.min(EVIDENCE_CATEGORY_COUNT, Math.max(coveredEntries.length, 1));
  const categoryDiversity = coveredEntries.length > 0
    ? clampPercent((categories.size / categoryDenominator) * 100)
    : 0;
  const density = clampPercent((verifiedStrength * 0.6) + (sourceDiversity * 0.2) + (categoryDiversity * 0.2));

  const directSourceBackedCriterionIds = new Set(
    input.runTrace.evidence_paths
      .filter(path => path.evidence_source !== 'derived' && Boolean(resolveSource(path)))
      .map(path => `${path.stream}:${path.criterion_id}`)
  );
  const derivedById = new Map((input.runTrace.derived_analytical_evidence || []).map(item => [item.evidence_id, item]));
  const derivedCriterionIds = new Set(
    input.runTrace.evidence_paths
      .filter(path => {
        if (path.evidence_source !== 'derived' || !path.derived_evidence_id || !path.source_id) return false;
        const evidence = derivedById.get(path.derived_evidence_id);
        return Boolean(evidence
          && evidence.mode === 'authoritative'
          && evidence.report_eligible
          && evidence.eligibility.state === 'ELIGIBLE'
          && evidence.source_id === path.source_id
          && evidence.targets.some(target => target.stream === path.stream && target.criterion_id === path.criterion_id)
          && evidence.summary_lines.some(line => normalizeEvidenceText(line) === normalizeEvidenceText(path.quote_snippet)));
      })
      .map(path => `${path.stream}:${path.criterion_id}`)
  );
  const groundedCriterionIds = new Set([...directSourceBackedCriterionIds, ...derivedCriterionIds]);
  const coveredCriterionKeys = coveredEntries.map(entry => `${entry.stream}:${entry.id}`);
  const unresolvedCriterionIds = coveredCriterionKeys.filter(key => !groundedCriterionIds.has(key));
  const sourceBackedCount = coveredCriterionKeys.filter(key => directSourceBackedCriterionIds.has(key)).length;
  const derivedCount = coveredCriterionKeys.filter(key => derivedCriterionIds.has(key)).length;
  const groundedCount = coveredCriterionKeys.filter(key => groundedCriterionIds.has(key)).length;
  const provenanceIntegrity = coveredCriterionKeys.length > 0
    ? clampPercent((groundedCount / coveredCriterionKeys.length) * 100)
    : 0;

  const delivery = input.knowledgeBase.delivery;
  const missingDocumentCount = delivery?.missing_expected_document_count
    ?? Math.max(0, EXPECTED_KB_DOCUMENT_COUNT - input.knowledgeBase.document_count);
  const knowledgeCompleteness = clampPercent(
    ((EXPECTED_KB_DOCUMENT_COUNT - Math.min(EXPECTED_KB_DOCUMENT_COUNT, missingDocumentCount))
      / EXPECTED_KB_DOCUMENT_COUNT) * 100
  );
  const knowledgeBlockingReasons = [
    ...(input.knowledgeBase.source !== 'remote_blob' ? [`KB source is ${input.knowledgeBase.source}, not remote_blob.`] : []),
    ...(input.knowledgeBase.failure_count > 0 ? [`KB delivery reported ${input.knowledgeBase.failure_count} failure(s).`] : []),
    ...(missingDocumentCount > 0 ? [`KB is missing ${missingDocumentCount} of ${EXPECTED_KB_DOCUMENT_COUNT} expected documents.`] : []),
    ...((delivery?.unexpected_document_count || 0) > 0 ? [`KB has ${delivery!.unexpected_document_count} unexpected document(s).`] : []),
    ...((delivery?.duplicate_document_count || 0) > 0 ? [`KB has ${delivery!.duplicate_document_count} duplicate document ID(s).`] : []),
  ];
  const knowledgeReady = knowledgeBlockingReasons.length === 0;

  // Future stage-packet contract diagnostics remain in knowledgeBase telemetry.
  // They do not describe availability of the current operational KB and cannot
  // block acquisition readiness, scoring, or gates.

  const weakPacketDomains = Object.entries(input.sourceRegistry.packets)
    .filter(([, packet]) => packet.weak_coverage)
    .map(([domain]) => domain);
  const evidenceBlockingReasons = [
    ...input.sourceRegistry.extraction.blocking_reasons,
    ...weakPacketDomains.map(domain => `Source packet ${domain} has incomplete deterministic routing coverage.`)
  ];
  const evidenceReady = evidenceBlockingReasons.length === 0;
  const securityStatus = input.runTrace.dlp.blocked
    ? 'BLOCK' as const
    : input.runTrace.dlp.caution_hit_count > 0
      ? 'WARN' as const
      : 'PASS' as const;
  const evidenceAcquisitionBlockingReasons = [
    ...evidenceBlockingReasons,
    ...(securityStatus === 'BLOCK' ? ['Security gate blocked the source packet.'] : [])
  ];

  return {
    schema_version: 'acquisition_quality_snapshot_v1',
    formula_version: 'acquisition_quality_formula_v1',
    enforcement: 'observability_only',
    extraction: input.sourceRegistry.extraction,
    evidence: {
      coverage: {
        overall: input.phase2.metrics.evidence_density,
        maturity: clampPercent((maturityCovered / Math.max(maturityEntries.length, 1)) * 100),
        antipattern: clampPercent((antipatternCovered / Math.max(antipatternEntries.length, 1)) * 100),
        covered_items: coveredEntries.length,
        total_items: allEntries.length,
        by_domain: domainCoverage
      },
      density: {
        overall: density,
        verified_strength: verifiedStrength,
        source_diversity: sourceDiversity,
        category_diversity: categoryDiversity,
        covered_items: coveredEntries.length
      },
      provenance: {
        integrity: provenanceIntegrity,
        source_backed_count: sourceBackedCount,
        derived_count: derivedCount,
        asserted_count: unresolvedCriterionIds.length,
        unresolved_criterion_ids: unresolvedCriterionIds
      }
    },
    knowledge: {
      completeness: knowledgeCompleteness,
      ready: knowledgeReady,
      source: input.knowledgeBase.source,
      expected_document_count: EXPECTED_KB_DOCUMENT_COUNT,
      loaded_document_count: input.knowledgeBase.document_count,
      missing_document_count: missingDocumentCount,
      blocking_reasons: knowledgeBlockingReasons
    },
    security: {
      status: securityStatus,
      high_risk_hit_count: input.runTrace.dlp.high_risk_hit_count,
      caution_hit_count: input.runTrace.dlp.caution_hit_count,
      scanned_chunk_count: input.runTrace.dlp.scanned_chunk_count
    },
    readiness: {
      evidence_packet: evidenceReady ? 'READY' : 'NOT_READY',
      knowledge_packet: knowledgeReady ? 'READY' : 'NOT_READY',
      acquisition: evidenceAcquisitionBlockingReasons.length === 0 ? 'READY' : 'NOT_READY',
      blocking_reasons: evidenceAcquisitionBlockingReasons
    }
  };
};

export const acquisitionQualityPersistence = (
  snapshot: AcquisitionQualitySnapshot,
  sourceRegistry: SourceRegistryRuntimeStatus
): AcquisitionQualityPersistence => ({
  schema_version: snapshot.schema_version,
  formula_version: snapshot.formula_version,
  extraction_completeness: snapshot.extraction.overall_completeness,
  evidence_coverage: snapshot.evidence.coverage.overall,
  evidence_density: snapshot.evidence.density.overall,
  provenance_integrity: snapshot.evidence.provenance.integrity,
  kb_completeness: snapshot.knowledge.completeness,
  evidence_packet_status: snapshot.readiness.evidence_packet,
  knowledge_packet_status: snapshot.readiness.knowledge_packet,
  acquisition_status: snapshot.readiness.acquisition,
  security_status: snapshot.security.status,
  extraction_incomplete_count: snapshot.extraction.sources.filter(source => source.status !== 'COMPLETE').length,
  weak_source_packet_count: Object.values(sourceRegistry.packets).filter(packet => packet.weak_coverage).length,
  kb_blocking_count: snapshot.knowledge.blocking_reasons.length,
  unresolved_provenance_count: snapshot.evidence.provenance.unresolved_criterion_ids.length
});

export const shadowTelemetryPersistence = (
  retrieval: BoundedRetrievalTrace,
  evidence: DerivedAnalyticalEvidence[],
  coverage: DataSignalCoverageReport
): ShadowTelemetryPersistence => {
  const passes = retrieval.domains.flatMap(domain => domain.passes);
  const gains = retrieval.domains.map(domain => domain.final_coverage - domain.baseline_coverage);
  const stopCount = (reason: RetrievalStopReason): number => retrieval.domains.filter(domain => domain.stop_reason === reason).length;
  return {
    schema_version: 'shadow_telemetry_v1',
    retrieval_policy_version: retrieval.policy_version,
    derived_evidence_schema_version: 'derived_analytical_evidence_v1',
    analyzer_version: 'tagging_allocation_v1@1.3.0',
    scale_registry_version: coverage.registry_version,
    retrieval_domain_count: retrieval.domains.length,
    retrieval_triggered_domain_count: retrieval.domains.filter(domain => domain.passes.length > 0).length,
    retrieval_pass_1_count: passes.filter(pass => pass.pass === 1).length,
    retrieval_pass_2_count: passes.filter(pass => pass.pass === 2).length,
    retrieval_selected_candidate_count: passes.reduce((sum, pass) => sum + pass.selected_chunk_ids.length, 0),
    retrieval_average_gain_points: gains.length ? Math.round(gains.reduce((sum, gain) => sum + gain, 0) / gains.length) : 0,
    retrieval_max_gain_points: gains.length ? Math.max(...gains) : 0,
    stop_sufficient_baseline_count: stopCount('SUFFICIENT_BASELINE'),
    stop_minimum_gain_not_met_count: stopCount('MINIMUM_GAIN_NOT_MET'),
    stop_no_new_candidates_count: stopCount('NO_NEW_CANDIDATES'),
    stop_max_passes_reached_count: stopCount('MAX_PASSES_REACHED'),
    derived_evidence_count: evidence.length,
    derived_observed_count: evidence.filter(item => item.result.status === 'OBSERVED').length,
    derived_insufficient_signal_count: evidence.filter(item => item.result.status !== 'OBSERVED').length,
    derived_full_table_count: evidence.filter(item => item.result.row_scope !== 'bounded_prefix').length,
    derived_bounded_prefix_count: evidence.filter(item => item.result.row_scope === 'bounded_prefix').length,
    scale_total_object_count: coverage.total_object_count,
    scale_analyzer_available_count: coverage.analyzer_available_count,
    scale_unsupported_count: coverage.unsupported_count
  };
};
