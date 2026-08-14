import type {
  DerivedAnalyticalEvidence,
  EvidenceLaneStagePacket,
  EvidencePrivacyDecision,
  RoutedSourcePacket,
  SourceRegistryRuntimeStatus
} from '../types';
import { hashString } from './runTraceService';
import { isDerivedEvidenceApprovedForPacket } from './structuredDataAnalysisService';

const PERMITTED_USES = [
  'Assess customer evidence only for the routed FinOps domain.',
  'Explain report-eligible deterministic metrics without recalculating or overriding them.',
  'Report insufficient coverage and withheld content explicitly.'
];

const FORBIDDEN_USES = [
  'Treat knowledge-base statements as customer evidence.',
  'Treat shadow-only derived evidence as a finding or score input.',
  'Infer non-text visual semantics from OCR text.',
  'Infer tested absence from weak or unrouted coverage.'
];

const domainForEvidence = (evidence: DerivedAnalyticalEvidence): string | undefined =>
  evidence.targets.map(target => target.criterion_id.charAt(0)).find(Boolean);

const hashable = (packet: Omit<EvidenceLaneStagePacket, 'integrity_hash' | 'text'>): string =>
  JSON.stringify(packet);

const renderPacket = (
  packet: Omit<EvidenceLaneStagePacket, 'integrity_hash' | 'text'>,
  sourceText: string
): string => `<EVIDENCE_LANE_STAGE_PACKET schema="${packet.schema_version}" domain="${packet.domain_id}" source_role="${packet.source_role}" source_packet_hash="${packet.source_packet_hash}">
<ROLE_BOUNDARY>
evidence[] contains sanitized customer textual/table evidence manifests.
sanitized_visual_evidence[] contains local-OCR text evidence with region provenance; it is not graph or image interpretation.
derived_evidence[] contains only registry-approved, report-eligible deterministic calculations.
knowledge_context[] is intentionally empty in the Customer Evidence lane. Knowledge is supplied separately and is never customer proof.
</ROLE_BOUNDARY>
<ACQUISITION_STATE privacy_decision="${packet.privacy_decision}" readiness="${packet.acquisition_readiness}" />
<COVERAGE weak="${packet.coverage.weak}" candidates="${packet.coverage.candidate_chunks}" included="${packet.coverage.included_chunks}" omitted="${packet.coverage.omitted_relevant_chunks}">
${packet.coverage.notes.join('\n')}
</COVERAGE>
<WITHHELD_CONTENT shadow_derived_evidence="${packet.withheld_content.shadow_derived_evidence_count}" uninspected_visual_regions="${packet.withheld_content.uninspected_visual_region_count}" raw_image_payloads="0">
${packet.withheld_content.reasons.join('\n')}
</WITHHELD_CONTENT>
<PERMITTED_USES>
${packet.policy.permitted_uses.map(value => `- ${value}`).join('\n')}
</PERMITTED_USES>
<FORBIDDEN_USES>
${packet.policy.forbidden_uses.map(value => `- ${value}`).join('\n')}
</FORBIDDEN_USES>
<EVIDENCE_MANIFEST count="${packet.evidence.length}">
${JSON.stringify(packet.evidence)}
</EVIDENCE_MANIFEST>
<SANITIZED_VISUAL_EVIDENCE_MANIFEST count="${packet.sanitized_visual_evidence.length}">
${JSON.stringify(packet.sanitized_visual_evidence)}
</SANITIZED_VISUAL_EVIDENCE_MANIFEST>
<DERIVED_EVIDENCE count="${packet.derived_evidence.length}">
${packet.derived_evidence.length > 0 ? JSON.stringify(packet.derived_evidence) : 'No report-eligible deterministic analytical evidence is approved for this domain.'}
</DERIVED_EVIDENCE>
<CUSTOMER_EVIDENCE>
${sourceText}
</CUSTOMER_EVIDENCE>
</EVIDENCE_LANE_STAGE_PACKET>`;

export const buildEvidenceLaneStagePackets = (input: {
  source_packets: Record<string, RoutedSourcePacket>;
  source_packet_hashes: Record<string, string>;
  derived_evidence: DerivedAnalyticalEvidence[];
  privacy_decision: EvidencePrivacyDecision;
  acquisition_readiness: SourceRegistryRuntimeStatus['acquisition_readiness'];
}): Record<string, EvidenceLaneStagePacket> => {
  if (input.privacy_decision.decision === 'BLOCK' || input.acquisition_readiness.status === 'BLOCKED') {
    throw new Error('EVIDENCE_STAGE_PACKET_NOT_APPROVED');
  }
  if (input.derived_evidence.some(item =>
    item.result.status === 'OBSERVED'
    && item.result.row_scope === 'full_table'
    && !item.result.row_truncated
    && item.result.reconciliation.state === 'FAILED'
  )) {
    throw new Error('DERIVED_EVIDENCE_RECONCILIATION_FAILED');
  }
  return Object.fromEntries(Object.entries(input.source_packets).map(([domainId, sourcePacket]) => {
    if (sourcePacket.images.length > 0) throw new Error('RAW_IMAGE_PAYLOAD_NOT_PERMITTED');
    const evidence = sourcePacket.manifest.filter(item => item.type !== 'image');
    const sanitizedVisualEvidence = sourcePacket.manifest.filter(item => item.type === 'image');
    const domainDerived = input.derived_evidence.filter(item =>
      isDerivedEvidenceApprovedForPacket(item) && domainForEvidence(item) === domainId
    );
    const shadowDerivedCount = input.derived_evidence.filter(item =>
      !isDerivedEvidenceApprovedForPacket(item) && domainForEvidence(item) === domainId
    ).length;
    const sourcePacketHash = input.source_packet_hashes[domainId];
    if (!sourcePacketHash) throw new Error(`EVIDENCE_SOURCE_PACKET_HASH_MISSING:${domainId}`);
    const reasons = [
      ...(shadowDerivedCount > 0 ? [`${shadowDerivedCount} shadow-only deterministic result(s) were withheld from model context.`] : []),
      ...(sanitizedVisualEvidence.length > 0 ? ['Non-text visual semantics remain UNINSPECTED_VISUAL_REGION.'] : []),
      ...(sourcePacket.total_candidate_chunks > sourcePacket.included_chunk_count ? ['Relevant routed chunks were omitted by bounded packet limits.'] : [])
    ];
    const base: Omit<EvidenceLaneStagePacket, 'integrity_hash' | 'text'> = {
      schema_version: 'evidence_lane_stage_packet_v1',
      domain_id: domainId,
      source_role: 'CUSTOMER_EVIDENCE',
      evidence,
      sanitized_visual_evidence: sanitizedVisualEvidence,
      derived_evidence: domainDerived,
      knowledge_context: [],
      coverage: {
        weak: sourcePacket.weak_coverage,
        candidate_chunks: sourcePacket.total_candidate_chunks,
        included_chunks: sourcePacket.included_chunk_count,
        omitted_relevant_chunks: Math.max(0, sourcePacket.total_candidate_chunks - sourcePacket.included_chunk_count),
        notes: sourcePacket.coverage_notes
      },
      withheld_content: {
        shadow_derived_evidence_count: shadowDerivedCount,
        uninspected_visual_region_count: sanitizedVisualEvidence.length,
        raw_image_payload_count: 0,
        reasons
      },
      policy: { permitted_uses: [...PERMITTED_USES], forbidden_uses: [...FORBIDDEN_USES] },
      privacy_decision: input.privacy_decision.decision,
      acquisition_readiness: input.acquisition_readiness.status,
      source_packet_hash: sourcePacketHash,
      images: []
    };
    const roleText = renderPacket(base, sourcePacket.text);
    return [domainId, {
      ...base,
      integrity_hash: hashString(`${hashable(base)}\n${roleText}`),
      text: roleText
    }];
  }));
};

export const assertEvidenceLaneStagePacket = (packet: EvidenceLaneStagePacket): void => {
  const { integrity_hash, text, ...base } = packet;
  if (packet.schema_version !== 'evidence_lane_stage_packet_v1'
    || packet.source_role !== 'CUSTOMER_EVIDENCE'
    || packet.knowledge_context.length !== 0
    || packet.images.length !== 0
    || packet.withheld_content.raw_image_payload_count !== 0
    || packet.derived_evidence.some(item => item.report_eligible !== true || item.mode !== 'authoritative')
    || !text.includes(`<CUSTOMER_EVIDENCE>`) || !text.includes(packet.source_packet_hash)
    || integrity_hash !== hashString(`${hashable(base)}\n${text}`)) {
    throw new Error('EVIDENCE_LANE_STAGE_PACKET_INTEGRITY_FAILED');
  }
};
