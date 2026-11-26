import type { PipelineProgressUpdate, SourceRecord } from '../types';
import type { RunContext } from './modelRouter';
import {
  buildDomainPackets,
  buildSourceRegistry,
  scanRegistryDlp,
  sourceRegistryRuntimeStatus,
} from './sourceRegistryService';
import { validateEvidenceAcquisition } from './pipelineIntegrityService';
import { buildDataSignalCoverageReport } from './structuredDataAnalysisService';
import { deriveAllEvidenceSignals } from './derivedEvidence';
import { planGapRetrieval } from './gapAnalyzerService';
import { buildEvidenceLaneStagePackets } from './evidenceStagePacketService';
import { applyBoundedRetrieval } from './boundedRetrievalService';
import { planAcquisitionGapQueries, retrieveAcquisitionGaps } from './acquisitionGapRetrievalService';
import { sanitizeEvidenceSources } from './deterministicPrivacyService';

// Both assessment and acquisition-only verification use this path. The caller owns
// the authoritative run, persistence, and any dispatch limits for that run.
export const acquireEvidence = async (
  sources: SourceRecord[],
  context: RunContext,
  emitProgress: (update: PipelineProgressUpdate) => void = () => {},
) => {
  // Authoritative customer-content boundary. No model route is invoked until
  // the complete source population has passed this deterministic scan.
  const privacy = sanitizeEvidenceSources(sources);
  if (privacy.decision.decision === 'BLOCK') {
    throw new Error(`Deterministic privacy gate blocked the evidence set (${privacy.decision.blocking_codes.join(', ')}). Remove prohibited secrets before running the assessment.`);
  }
  const acquiredSources = privacy.sources;
  const extractionWarnings = acquiredSources.filter(source => source.extraction?.truncated || source.extraction?.quality === 'poor' || (source.parse_warnings?.length || 0) > 0).length;
  emitProgress({ stage: 'extraction', status: extractionWarnings > 0 ? 'completed_with_warnings' : 'completed' });
  emitProgress({ stage: 'packetization', status: 'in_progress' });
  let sourceRegistry = buildSourceRegistry(acquiredSources);
  const derivedRun = deriveAllEvidenceSignals(acquiredSources, sourceRegistry);
  let derivedAnalyticalEvidence = derivedRun.evidence;
  const tableInspections = acquiredSources.flatMap(source =>
    [...(source.structured_tables || []), ...(source.structured_table ? [source.structured_table] : [])]
      .flatMap(table => table.deterministic_inspection ? [{
        source_id: source.source_id,
        sheet_name: table.sheet_name,
        model_eligible: table.model_eligible !== false,
        inspection: table.deterministic_inspection
      }] : [])
  );
  const dataSignalCoverage = buildDataSignalCoverageReport();
  const baselineSourcePackets = buildDomainPackets(sourceRegistry);
  const gapPlan = planGapRetrieval({
    packets: baselineSourcePackets,
    derived: derivedAnalyticalEvidence,
    locations: derivedRun.locations
  });
  const semanticPlans = planAcquisitionGapQueries(sourceRegistry, baselineSourcePackets, derivedAnalyticalEvidence);
  const boundedRetrievalResult = applyBoundedRetrieval(sourceRegistry, baselineSourcePackets, {
    gap_plan: gapPlan, reserve_semantic_round_for: new Set(semanticPlans.keys()),
  });
  let sourcePackets = boundedRetrievalResult.packets;
  const boundedRetrieval = boundedRetrievalResult.trace;
  const verifyAcquisition = () => {
    const dlpScan = scanRegistryDlp(sourceRegistry);
    if (dlpScan.blocked) {
      throw new Error('Security Alert: high-risk secret material detected in source chunks.');
    }
    const integrity = validateEvidenceAcquisition(acquiredSources, sourceRegistry, sourcePackets);
    const status = sourceRegistryRuntimeStatus(sourceRegistry, sourcePackets, 0, dlpScan, privacy.decision, integrity);
    const stagePackets = buildEvidenceLaneStagePackets({
      source_packets: sourcePackets,
      source_packet_hashes: integrity.packet_hashes,
      derived_evidence: derivedAnalyticalEvidence,
      acquisition_limitations: sourceRegistry.acquisition_limitations,
      privacy_decision: privacy.decision,
      acquisition_readiness: status.acquisition_readiness,
    });
    return { integrity, status, stagePackets, dlpScan };
  };
  const baseline = verifyAcquisition();
  const baselineEvidenceStagePackets = baseline.stagePackets;
  const acquisitionGap = await retrieveAcquisitionGaps(sourceRegistry, sourcePackets, semanticPlans, context);
  const changed = acquisitionGap.registry !== sourceRegistry;
  const addedChunks = changed || boundedRetrieval.domains.some(domain => domain.passes.some(pass => pass.selected_chunk_ids.length > 0));
  if (addedChunks) {
    const recheck = sanitizeEvidenceSources(acquiredSources).decision;
    if (recheck.decision === 'BLOCK' || recheck.redaction_count > 0) {
      throw new Error('Deterministic privacy revalidation rejected the evidence set after bounded retrieval.');
    }
  }
  if (changed) {
    sourceRegistry = acquisitionGap.registry;
    sourcePackets = acquisitionGap.packets;
    derivedAnalyticalEvidence = deriveAllEvidenceSignals(acquiredSources, sourceRegistry).evidence;
  }
  const {
    integrity: evidenceIntegrity,
    status: sourceRegistryStatus,
    stagePackets: evidenceStagePackets,
    dlpScan,
  } = changed ? verifyAcquisition() : baseline;

  return {
    acquiredSources,
    baselineSourcePackets,
    sourceRegistry,
    sourcePackets,
    privacy,
    tableInspections,
    derivedAnalyticalEvidence,
    dataSignalCoverage,
    gapPlan,
    boundedRetrieval,
    acquisitionGap,
    baselineEvidenceStagePackets,
    evidenceIntegrity,
    sourceRegistryStatus,
    evidenceStagePackets,
    dlpScan,
  };
};
