import type { RoutedSourcePacket, SourceRecord, SourceRegistry } from '../types';

export const retrievalReference = {
  version: 'retrieval-v1',
  sourceHashes: [
    'sha256_006ae5ac08d5e067862427f8781679be59daf7415e2f14b38fd1962d618c51fc',
    'sha256_3c88ae0134470904489851ae1f499b9dc163db5e55c35c7cda669e8a56676867',
    'sha256_095f8f5224269ff1b9746adce55a52386650d01a522ac6b4b9c29d7454e76d90',
  ],
  direct: { domain: 'A', sourceId: 'src-001', row: 2 },
  recovery: {
    domain: 'C',
    criterion: 'maturity.C2',
    sourceId: 'src-002',
    fact: 'recorded the forecast as a spending outlook for next month',
  },
  excludedSourceId: 'src-003',
  calculation: { rows: 3, duplicateRows: 1, duplicatePercent: 33.33 },
} as const;

export const compareRetrievalReference = (input: {
  sources: readonly SourceRecord[];
  baselinePackets: Readonly<Record<string, RoutedSourcePacket>>;
  finalPackets: Readonly<Record<string, RoutedSourcePacket>>;
  registry: SourceRegistry;
}) => {
  const { sources, baselinePackets, finalPackets, registry } = input;
  const { direct, recovery, excludedSourceId, sourceHashes, calculation } = retrievalReference;
  const hasDirectRow = (packet: RoutedSourcePacket | undefined) => packet?.manifest.some(
    item => item.source_id === direct.sourceId && item.row_number === direct.row,
  ) === true;
  const inspection = sources.find(source => source.source_id === direct.sourceId)?.structured_table?.deterministic_inspection;
  const recovered = finalPackets[recovery.domain]?.manifest.some(item => {
    if (item.source_id !== recovery.sourceId) return false;
    const chunk = registry.chunks.find(candidate => candidate.chunk_id === item.chunk_id);
    return chunk?.source_id === recovery.sourceId && chunk.char_start !== undefined
      && chunk.char_end !== undefined && chunk.char_end > chunk.char_start
      && chunk.text.includes(recovery.fact) && chunk.routing.some(hint =>
      hint.domain === recovery.domain && hint.reasons.includes(`catalog_gap:${recovery.criterion}`),
    );
  }) === true;

  return {
    fixtureHashes: sources.length === sourceHashes.length
      && sourceHashes.every((hash, index) => sources[index].acquisition?.original_sha256 === hash),
    directEvidence: hasDirectRow(baselinePackets[direct.domain]) && hasDirectRow(finalPackets[direct.domain]),
    calculation: inspection?.population_scope === 'FULL_TABLE' && inspection.row_count === calculation.rows
      && inspection.duplicate_row_count === calculation.duplicateRows
      && inspection.duplicate_row_rate_percent === calculation.duplicatePercent,
    gapPresentOnFirstPass: baselinePackets[recovery.domain]?.manifest.every(item => item.source_id !== recovery.sourceId) === true,
    recoveredEvidence: recovered,
    irrelevantEvidenceExcluded: Object.values(finalPackets).every(packet =>
      packet.manifest.every(item => item.source_id !== excludedSourceId),
    ),
  };
};
