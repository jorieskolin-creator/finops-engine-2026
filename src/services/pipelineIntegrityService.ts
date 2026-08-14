import type {
  EvidenceCheckResult,
  RemoteKnowledgeBaseIndex,
  RoutedSourcePacket,
  SourceRecord,
  SourceRegistry,
} from '../types';
import {
  BATCH_DEFINITIONS,
  BATCH_IDS,
  buildShadowKnowledgePacket,
} from '../knowledge_base';
import { hashString } from './runTraceService';

export type IntegrityGate = 'acquisition' | 'knowledge' | 'pre_synthesis';

export class PipelineIntegrityError extends Error {
  constructor(
    public readonly code: string,
    public readonly gate: IntegrityGate,
    public readonly domains: string[] = [],
  ) {
    super(PipelineIntegrityError.userMessage(code, domains));
    this.name = 'PipelineIntegrityError';
  }

  private static userMessage(code: string, domains: string[]): string {
    if (code === 'SOURCE_EXTRACTION_INCOMPLETE') {
      return 'The uploaded material could not be extracted completely or was truncated. No assessment was started. Check the source files and start a new analysis.';
    }
    if (code === 'EVIDENCE_PACKET_INTEGRITY_FAILED') {
      return 'Acquired evidence was lost or changed during processing. No assessment was finalized. Start a new analysis.';
    }
    if (code === 'KNOWLEDGE_PACKET_INTEGRITY_FAILED') {
      return 'The assessment knowledge packet was incomplete or changed during processing. No assessment was finalized. Start a new analysis.';
    }
    if (code === 'DOMAIN_ANALYSIS_FAILED') {
      const label = domains.length > 0 ? ` for domain${domains.length === 1 ? '' : 's'} ${domains.join(', ')}` : '';
      return `Material analysis was interrupted${label} after safe retries. No assessment was finalized from incomplete analysis. Start a new analysis.`;
    }
    if (code === 'ANALYSIS_OUTPUT_INCOMPLETE') {
      return 'Material analysis returned incomplete or truncated information. No assessment was finalized. Start a new analysis.';
    }
    if (code === 'EVIDENCE_VERIFICATION_FAILED') {
      return 'Evidence verification did not complete. Findings were not finalized or summarized. Start a new analysis.';
    }
    return 'Processing integrity could not be verified. No assessment was finalized. Start a new analysis.';
  }
}

export interface EvidenceIntegritySnapshot {
  registry_hash: string;
  packet_hashes: Record<string, string>;
  packet_manifest_hash: string;
}

export interface KnowledgeIntegritySnapshot {
  mode: 'remote_blob' | 'built_in';
  index_hash: string;
}

interface Phase1IntegrityInput {
  phase_1_audit_logs: {
    maturity: Record<string, unknown>;
    antipattern: Record<string, unknown>;
  };
  evidence_check: EvidenceCheckResult;
  failed_batches: string[];
}

const stableRegistryValue = (registry: SourceRegistry): string => JSON.stringify({
  source_count: registry.source_count,
  chunk_count: registry.chunk_count,
  source_acquisition: [...(registry.source_acquisition || [])]
    .sort((a, b) => a.source_id.localeCompare(b.source_id)),
  extraction: {
    overall_completeness: registry.extraction.overall_completeness,
    status: registry.extraction.status,
    sources: [...registry.extraction.sources]
      .sort((a, b) => a.source_id.localeCompare(b.source_id))
      .map(source => ({
        source_id: source.source_id,
        kind: source.kind,
        completeness: source.completeness,
        status: source.status,
        unit: source.unit,
        total_units: source.total_units,
        processed_units: source.processed_units,
        text_coverage_ratio: source.text_coverage_ratio,
        sparse_units: source.sparse_units,
        truncated: source.truncated,
        quality: source.quality,
        warning_codes: source.warning_codes,
      })),
  },
  chunks: [...registry.chunks]
    .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id))
    .map(chunk => ({
      chunk_id: chunk.chunk_id,
      source_id: chunk.source_id,
      page_id: chunk.page_id,
      page_number: chunk.page_number,
      sheet_name: chunk.sheet_name,
      row_number: chunk.row_number,
      type: chunk.type,
      text: chunk.text,
      image_hash: chunk.image ? hashString(chunk.image.data) : undefined,
    })),
});

const packetHash = (packet: RoutedSourcePacket): string => hashString(JSON.stringify({
  domain_id: packet.domain_id,
  text: packet.text,
  images: packet.images.map(image => ({
    mime_type: image.mimeType,
    data_hash: hashString(image.data),
    source_id: image.source_id,
    page_id: image.page_id,
    page_number: image.page_number,
    chunk_id: image.chunk_id,
  })),
  manifest: packet.manifest,
  included_chunk_count: packet.included_chunk_count,
  total_candidate_chunks: packet.total_candidate_chunks,
  char_count: packet.char_count,
}));

const knowledgeIndexHash = (index: RemoteKnowledgeBaseIndex): string => hashString(JSON.stringify({
  source: index.status.source,
  documents: [...(index.documents || [])]
    .sort((a, b) => `${a.stream}:${a.criterion_id}`.localeCompare(`${b.stream}:${b.criterion_id}`))
    .map(document => ({
      kb_id: document.kb_id,
      version: document.version,
      domain_id: document.domain_id,
      criterion_id: document.criterion_id,
      stream: document.stream,
      pdf_sha256: document.pdf_sha256,
      extracted_text_sha256: document.extracted_text_sha256,
      sections: document.sections,
      body_excerpt: document.body_excerpt,
    })),
}));

const builtInKnowledgeHash = (): string => hashString(JSON.stringify(
  BATCH_IDS.map(domain => ({ domain, definition: BATCH_DEFINITIONS[domain] }))
));

const remoteKnowledgeReady = (index: RemoteKnowledgeBaseIndex): boolean =>
  index.status.source === 'remote_blob'
  && index.status.failure_count === 0
  && index.status.delivery?.shadow_ready !== false
  && BATCH_IDS.every(domain => (
    buildShadowKnowledgePacket(index, { batchId: domain, stage: 'forensic_audit' }).readiness === 'READY'
    && buildShadowKnowledgePacket(index, { batchId: domain, stage: 'evidence_check' }).readiness === 'READY'
  ));

const isGovernedBoundedTable = (source: SourceRecord): boolean =>
  (source.kind === 'csv' || source.kind === 'tsv')
  && source.extraction?.unit === 'row'
  && Boolean(source.structured_table)
  && (source.extraction?.processed_units || 0) > 0;

export const validateEvidenceAcquisition = (
  sources: SourceRecord[],
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
): EvidenceIntegritySnapshot => {
  const sourceIds = new Set(sources.map(source => source.source_id));
  const extractionFailed = registry.extraction.status === 'FAILED'
    || registry.extraction.sources.some(extraction => {
      const source = sources.find(candidate => candidate.source_id === extraction.source_id);
      if (source && isGovernedBoundedTable(source)) return false;
      return extraction.truncated
        || extraction.processed_units < extraction.total_units
        || extraction.quality === 'poor';
    });
  if (extractionFailed) {
    throw new PipelineIntegrityError('SOURCE_EXTRACTION_INCOMPLETE', 'acquisition');
  }
  if (registry.source_count !== sources.length
    || registry.extraction.sources.length !== sources.length
    || registry.chunk_count !== registry.chunks.length
    || registry.chunk_count === 0) {
    throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition');
  }

  const chunksById = new Map<string, SourceRegistry['chunks'][number]>();
  for (const chunk of registry.chunks) {
    if (!chunk.chunk_id || chunksById.has(chunk.chunk_id) || !sourceIds.has(chunk.source_id) || (!chunk.text && !chunk.image)) {
      throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition');
    }
    chunksById.set(chunk.chunk_id, chunk);
  }

  const packetHashes: Record<string, string> = {};
  for (const domain of BATCH_IDS) {
    const packet = packets[domain];
    if (!packet || packet.domain_id !== domain || packet.char_count !== packet.text.length
      || packet.included_chunk_count !== packet.manifest.length) {
      throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition', [domain]);
    }
    if (packet.manifest.length === 0 && !packet.text.includes('<NO_ROUTED_CHUNKS>')) {
      throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition', [domain]);
    }
    const packetChunkIds = new Set<string>();
    for (const item of packet.manifest) {
      const chunk = chunksById.get(item.chunk_id);
      if (!chunk
        || packetChunkIds.has(item.chunk_id)
        || chunk.source_id !== item.source_id
        || !packet.text.includes(`id="${item.chunk_id}"`)
        || !packet.text.includes(`source_id="${item.source_id}"`)) {
        throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition', [domain]);
      }
      packetChunkIds.add(item.chunk_id);
    }
    packetHashes[domain] = packetHash(packet);
  }
  if (Object.keys(packets).some(domain => !BATCH_IDS.includes(domain))) {
    throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'acquisition');
  }
  return {
    registry_hash: hashString(stableRegistryValue(registry)),
    packet_hashes: packetHashes,
    packet_manifest_hash: hashString(JSON.stringify(packetHashes)),
  };
};

export const validateKnowledgeAcquisition = (
  index: RemoteKnowledgeBaseIndex,
): KnowledgeIntegritySnapshot => {
  const builtInReady = BATCH_IDS.every(domain => {
    const definition = BATCH_DEFINITIONS[domain];
    return Boolean(definition?.title && definition.maturity && definition.antipattern);
  });
  if (!builtInReady) {
    throw new PipelineIntegrityError('KNOWLEDGE_PACKET_INTEGRITY_FAILED', 'knowledge');
  }

  const useRemote = remoteKnowledgeReady(index);
  return {
    mode: useRemote ? 'remote_blob' : 'built_in',
    index_hash: useRemote ? knowledgeIndexHash(index) : builtInKnowledgeHash(),
  };
};

export const validatePreSynthesisIntegrity = (
  evidenceSnapshot: EvidenceIntegritySnapshot,
  knowledgeSnapshot: KnowledgeIntegritySnapshot,
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
  knowledgeIndex: RemoteKnowledgeBaseIndex,
  phase1: Phase1IntegrityInput,
): void => {
  if (evidenceSnapshot.registry_hash !== hashString(stableRegistryValue(registry))) {
    throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'pre_synthesis');
  }
  for (const domain of BATCH_IDS) {
    if (!packets[domain] || evidenceSnapshot.packet_hashes[domain] !== packetHash(packets[domain])) {
      throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'pre_synthesis', [domain]);
    }
  }
  const currentKnowledgeMode = remoteKnowledgeReady(knowledgeIndex) ? 'remote_blob' : 'built_in';
  const currentKnowledgeHash = currentKnowledgeMode === 'remote_blob'
    ? knowledgeIndexHash(knowledgeIndex)
    : builtInKnowledgeHash();
  if (knowledgeSnapshot.mode !== currentKnowledgeMode
    || knowledgeSnapshot.index_hash !== currentKnowledgeHash) {
    throw new PipelineIntegrityError('KNOWLEDGE_PACKET_INTEGRITY_FAILED', 'pre_synthesis');
  }
  if (phase1.failed_batches.length > 0) {
    throw new PipelineIntegrityError('DOMAIN_ANALYSIS_FAILED', 'pre_synthesis', phase1.failed_batches);
  }

  const expectedIds = new Set(BATCH_IDS.flatMap(domain => Array.from({ length: 5 }, (_, index) => `${domain}${index + 1}`)));
  for (const stream of ['maturity', 'antipattern'] as const) {
    const deliveredIds = Object.keys(phase1.phase_1_audit_logs[stream]);
    if (deliveredIds.length !== expectedIds.size
      || deliveredIds.some(id => !expectedIds.has(id))) {
      throw new PipelineIntegrityError('ANALYSIS_OUTPUT_INCOMPLETE', 'pre_synthesis');
    }
    if (Object.values(phase1.phase_1_audit_logs[stream]).some(item => {
      if (!item || typeof item !== 'object') return true;
      const candidate = item as { count?: unknown; evidence_quotes?: unknown };
      return !Number.isInteger(candidate.count)
        || (candidate.count as number) < 0
        || (candidate.count as number) > 3
        || !Array.isArray(candidate.evidence_quotes);
    })) {
      throw new PipelineIntegrityError('ANALYSIS_OUTPUT_INCOMPLETE', 'pre_synthesis');
    }
  }

  for (const domain of BATCH_IDS) {
    const manifest = new Map(packets[domain].manifest.map(item => [item.chunk_id, item]));
    for (const stream of ['maturity', 'antipattern'] as const) {
      for (let index = 1; index <= 5; index++) {
        const item = phase1.phase_1_audit_logs[stream][`${domain}${index}`] as {
          evidence_quotes?: Array<{ chunk_id?: string; source_id?: string }>;
        } | undefined;
        for (const quote of item?.evidence_quotes || []) {
          if (!quote.chunk_id) continue;
          const located = manifest.get(quote.chunk_id);
          if (!located || (quote.source_id && quote.source_id !== located.source_id)) {
            throw new PipelineIntegrityError('EVIDENCE_PACKET_INTEGRITY_FAILED', 'pre_synthesis', [domain]);
          }
        }
      }
    }
  }

  const evidence = phase1.evidence_check;
  const decisionKeys = new Set(evidence.items.map(item => `${item.stream}:${item.id}`));
  const expectedDecisionKeys = new Set([...expectedIds].flatMap(id => [`maturity:${id}`, `antipattern:${id}`]));
  if (evidence.failed
    || evidence.items.length !== expectedDecisionKeys.size
    || decisionKeys.size !== expectedDecisionKeys.size
    || [...decisionKeys].some(key => !expectedDecisionKeys.has(key))
    || evidence.items.some(item => item.adjudication_unresolved || item.verification_unresolved)) {
    throw new PipelineIntegrityError('EVIDENCE_VERIFICATION_FAILED', 'pre_synthesis');
  }
};
