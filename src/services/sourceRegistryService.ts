import { BATCH_TITLES } from '../knowledge_base';
import type {
  DlpPatternHit,
  DlpScanResult,
  ImageInput,
  SourceRecord,
  RoutedSourcePacket,
  SourceChunk,
  SourceChunkRoutingHint,
  SourcePacketManifestItem,
  SourceRegistry,
  SourceRegistryRuntimeStatus,
  SourceExtractionQuality,
  SourceRelevanceTier,
  EvidencePrivacyDecision,
  VisualEvidenceUnit
} from '../types';
import { renderStructuredTableContext } from './tableService';

const TARGET_PACKET_CHARS = 35000;
const HARD_PACKET_CHARS = 45000;
const CHUNK_TARGET_CHARS = 2200;
const CHUNK_OVERLAP_CHARS = 200;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_KINDS = new Set(['text', 'pdf', 'html', 'csv', 'tsv', 'json', 'xlsx', 'image']);
const PDF_PAGE_STATES = new Set(['TEXT_EXTRACTED', 'SPARSE_TEXT_ONLY', 'OCR_REQUIRED', 'OCR_COMPLETE', 'VISUAL_INTERPRETATION_REQUIRED', 'VISUAL_REGION_WITHHELD', 'EXTRACTION_FAILED']);
const SHA256_PATTERN = /^sha256_[a-f0-9]{64}$/;

const DOMAIN_TERMS: Record<string, string[]> = {
  A: [
    'allocation', 'tagging', 'tag', 'showback', 'chargeback', 'dashboard', 'reporting',
    'cost visibility', 'unit economics', 'cost per', 'anomaly', 'alert', 'owner', 'cost center'
  ],
  B: [
    'reservation', 'reserved instance', 'savings plan', 'commitment', 'rightsizing', 'right-size',
    'utilization', 'waste', 'idle', 'orphaned', 'spot', 'preemptible', 'storage lifecycle', 'tiering'
  ],
  C: [
    'policy', 'governance', 'budget', 'forecast', 'approval', 'guardrail', 'procurement',
    'vendor', 'compliance', 'regulatory', 'raci', 'operating model', 'finops operating'
  ],
  D: [
    'architecture', 'engineering', 'infrastructure as code', 'terraform', 'pulumi', 'cloudformation',
    'autoscaling', 'auto scaling', 'serverless', 'container', 'kubernetes', 'multi-cloud', 'hybrid',
    'design review'
  ],
  E: [
    'culture', 'organization', 'team', 'finance', 'engineering accountability', 'platform team',
    'finops team', 'enabling team', 'training', 'kpi', 'incentive', 'collaboration', 'community'
  ],
  F: [
    'genai', 'generative ai', 'llm', 'token', 'tokens', 'model routing', 'prompt', 'context window',
    'rag', 'embedding', 'openai', 'anthropic', 'gemini', 'inference', 'ai cost', 'model spend',
    'api usage', 'ai budget'
  ]
};

const GAP_TERMS = [
  'missing', 'not available', 'not implemented', 'not yet', 'planned', 'manual', 'ad hoc',
  'no evidence', 'no process', 'gap', 'lacks', 'without', 'unknown', 'not tracked'
];

const CONTRADICTION_TERMS = [
  'contradiction', 'conflict', 'inconsistent', 'unclear', 'exception', 'override', 'manual override'
];

const validNativeCharts = (charts: NonNullable<SourceRecord['structured_table']>['native_charts']): boolean => {
  if (charts === undefined) return true;
  if (!Array.isArray(charts) || charts.length > 50) return false;
  const ids = new Set<string>();
  return charts.every(chart => {
    if (!chart || chart.schema_version !== 'native_chart_evidence_unit_v1'
      || !SOURCE_ID_PATTERN.test(chart.chart_id) || ids.has(chart.chart_id)
      || typeof chart.chart_part !== 'string' || !/^xl\/charts\/chart[^/]*\.xml$/i.test(chart.chart_part)
      || (chart.sheet_name !== undefined && (typeof chart.sheet_name !== 'string' || chart.sheet_name.length > 255))
      || typeof chart.chart_type !== 'string' || chart.chart_type.length === 0 || chart.chart_type.length > 64
      || (chart.title !== undefined && (typeof chart.title !== 'string' || chart.title.length > 1000))
      || !Array.isArray(chart.axis_titles) || chart.axis_titles.some(title => typeof title !== 'string' || title.length > 1000)
      || !Array.isArray(chart.series) || chart.series.length > 20
      || !['COMPLETE', 'PARTIAL'].includes(chart.extraction_status)
      || !Array.isArray(chart.warnings) || chart.warnings.some(warning => typeof warning !== 'string' || warning.length > 200)) return false;
    ids.add(chart.chart_id);
    let points = 0;
    return chart.series.every(series => {
      if (!series || [series.name, series.category_range, series.value_range]
        .some(value => value !== undefined && (typeof value !== 'string' || value.length > 1000))
        || [series.category_range, series.value_range].some(value => value?.includes('['))
        || !Array.isArray(series.categories) || series.categories.some(value => typeof value !== 'string' || value.length > 1000)
        || !Array.isArray(series.values) || series.values.some(value => value !== null && !Number.isFinite(value))) return false;
      points += Math.max(series.categories.length, series.values.length);
      return points <= 5000;
    });
  });
};

const validDeterministicInspection = (table: NonNullable<SourceRecord['structured_table']>): boolean => {
  const inspection = table.deterministic_inspection;
  if (inspection === undefined) return true;
  return inspection.schema_version === 'deterministic_table_inspection_v1'
    && inspection.population_scope === 'FULL_TABLE'
    && inspection.row_count === table.total_row_count
    && inspection.column_count === table.headers.length
    && inspection.duplicate_definition === 'REPEATED_ROWS_AFTER_FIRST_OCCURRENCE'
    && inspection.type_consistency_definition === 'DOMINANT_NON_EMPTY_TYPE_SHARE'
    && ['EXACT', 'NOT_CALCULATED_LIMIT'].includes(inspection.duplicate_calculation_state)
    && ((inspection.duplicate_calculation_state === 'EXACT'
      && Number.isInteger(inspection.duplicate_row_count) && inspection.duplicate_row_count! >= 0
      && Number.isFinite(inspection.duplicate_row_rate_percent))
      || (inspection.duplicate_calculation_state === 'NOT_CALCULATED_LIMIT'
        && inspection.duplicate_row_count === null && inspection.duplicate_row_rate_percent === null))
    && Array.isArray(inspection.columns) && inspection.columns.length === table.headers.length
    && inspection.columns.every((column, index) => column.column_index === index
      && ['EMPTY', 'STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'MIXED'].includes(column.inferred_type)
      && Number.isInteger(column.non_empty_count) && column.non_empty_count >= 0
      && Number.isInteger(column.blank_count) && column.blank_count >= 0
      && column.non_empty_count + column.blank_count === inspection.row_count
      && Number.isFinite(column.blank_rate_percent) && column.blank_rate_percent >= 0 && column.blank_rate_percent <= 100
      && (column.type_consistency_percent === null || (Number.isFinite(column.type_consistency_percent) && column.type_consistency_percent >= 0 && column.type_consistency_percent <= 100))
      && Number.isInteger(column.distinct_value_count) && column.distinct_value_count >= 0
      && ['EXACT', 'LOWER_BOUND'].includes(column.distinct_count_state)
      && Array.isArray(column.detected_currencies) && column.detected_currencies.every(currency => typeof currency === 'string' && currency.length <= 32));
};

const validStructuredTable = (table: NonNullable<SourceRecord['structured_table']>): boolean =>
  table.schema_version === 'structured_table_v1'
  && Array.isArray(table.headers) && table.headers.length <= 200
  && Array.isArray(table.rows) && table.rows.length <= 150 && Number.isInteger(table.total_row_count)
  && table.total_row_count >= table.rows.length && typeof table.truncated === 'boolean'
  && !(table.total_row_count > table.rows.length && !table.truncated)
  && table.headers.every(header => typeof header === 'string' && header.length <= 243)
  && table.rows.every(row => Array.isArray(row) && row.length <= 200 && row.every(cell => typeof cell === 'string' && cell.length <= 243))
  && validNativeCharts(table.native_charts)
  && validDeterministicInspection(table)
  && (table.analysis_rows === undefined || (
    Array.isArray(table.analysis_rows) && table.analysis_rows.length === table.total_row_count
    && table.analysis_complete === true
    && table.analysis_rows.every(row => Array.isArray(row) && row.length <= 200 && row.every(cell => typeof cell === 'string'))
  ))
  && (table.sampled_row_numbers === undefined || (
    Array.isArray(table.sampled_row_numbers) && table.sampled_row_numbers.length === table.rows.length
    && table.sampled_row_numbers.every(rowNumber => Number.isInteger(rowNumber) && rowNumber >= 1)
  ))
  && (table.sampled_row_reasons === undefined || (
    Array.isArray(table.sampled_row_reasons) && table.sampled_row_reasons.length === table.rows.length
    && table.sampled_row_reasons.every(reasons => Array.isArray(reasons) && reasons.length > 0 && reasons.every(reason => typeof reason === 'string' && reason.length <= 100))
  ))
  && (table.sample_strategy_version === undefined || table.sample_strategy_version === 'deterministic_table_sample_v1')
  && (table.sample_seed_hash === undefined || (typeof table.sample_seed_hash === 'string' && table.sample_seed_hash.length >= 8 && table.sample_seed_hash.length <= 80))
  && (table.analysis_row_numbers === undefined || (
    Array.isArray(table.analysis_row_numbers) && table.analysis_row_numbers.length === (table.analysis_rows?.length || 0)
    && table.analysis_row_numbers.every(rowNumber => Number.isInteger(rowNumber) && rowNumber >= 1)
  ))
  && (table.privacy_scan_headers === undefined || (
    Array.isArray(table.privacy_scan_headers)
    && table.privacy_scan_headers.every(header => typeof header === 'string' && header.length <= 243)
  ))
  && ((table.privacy_scan_headers === undefined) === (table.privacy_scan_rows === undefined))
  && (table.privacy_scan_rows === undefined || (
    Array.isArray(table.privacy_scan_rows)
    && table.privacy_scan_rows.length === table.source_total_row_count
    && table.privacy_scan_rows.every(row => Array.isArray(row) && row.length === table.privacy_scan_headers!.length
      && row.every(cell => typeof cell === 'string'))
  ))
  && (table.source_column_numbers === undefined || (
    Array.isArray(table.source_column_numbers) && table.source_column_numbers.length === table.headers.length
    && new Set(table.source_column_numbers).size === table.source_column_numbers.length
    && table.source_column_numbers.every(column => Number.isInteger(column) && column >= 1 && column <= 200)
  ))
  && (table.source_total_row_count === undefined || (Number.isInteger(table.source_total_row_count) && table.source_total_row_count >= table.total_row_count))
  && (table.hidden_row_count === undefined || (Number.isInteger(table.hidden_row_count) && table.hidden_row_count >= 0))
  && (table.hidden_column_count === undefined || (Number.isInteger(table.hidden_column_count) && table.hidden_column_count >= 0))
  && (table.privacy_scan_rows === undefined || table.source_total_row_count !== undefined)
  && (table.hidden_row_count === undefined || table.source_total_row_count === table.total_row_count + table.hidden_row_count)
  && (table.hidden_column_count === undefined || table.privacy_scan_headers === undefined
    || table.privacy_scan_headers.length === table.headers.length + table.hidden_column_count)
  && (table.active_filter_range === undefined || (typeof table.active_filter_range === 'string' && table.active_filter_range.length <= 64))
  && (table.formula_cell_count === undefined || (Number.isInteger(table.formula_cell_count) && table.formula_cell_count >= 0))
  && (table.formula_cached_value_missing_count === undefined || table.formula_cached_value_missing_count === 0)
  && (table.merged_range_count === undefined || (Number.isInteger(table.merged_range_count) && table.merged_range_count >= 0))
  && (table.merged_ranges === undefined || (Array.isArray(table.merged_ranges) && table.merged_ranges.length === table.merged_range_count
    && table.merged_ranges.every(range => typeof range === 'string' && /^[A-Z]+\d+(?::[A-Z]+\d+)?$/.test(range))))
  && (table.unsupported_objects === undefined || (Array.isArray(table.unsupported_objects) && table.unsupported_objects.length <= 20
    && table.unsupported_objects.every(code => typeof code === 'string' && /^[A-Z0-9_]+$/.test(code))));

const escapeXml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

const buildExtractionQuality = (records: SourceRecord[]): SourceExtractionQuality => {
  const sources = records.map(record => {
    const metadata = record.extraction || {
      unit: 'document' as const,
      total_units: 1,
      processed_units: 1,
      truncated: false
    };
    const unitCoverage = metadata.total_units === 0
      ? 1
      : Math.min(1, metadata.processed_units / metadata.total_units);
    const textCoverage = metadata.text_coverage_ratio === undefined
      ? 1
      : Math.min(1, Math.max(0, metadata.text_coverage_ratio));
    const completeness = clampPercent(unitCoverage * textCoverage * 100);
    const status = completeness === 100 && !metadata.truncated
      ? 'COMPLETE' as const
      : completeness === 0
        ? 'FAILED' as const
        : 'PARTIAL' as const;
    const warningCodes: SourceExtractionQuality['sources'][number]['warning_codes'] = [
      ...((record.parse_warnings || []).length > 0 ? ['PARSE_WARNING' as const] : []),
      ...(metadata.truncated ? ['TRUNCATED' as const] : []),
      ...((metadata.sparse_units || 0) > 0 ? ['SPARSE_CONTENT' as const] : []),
      ...(metadata.quality === 'mixed' ? ['MIXED_QUALITY' as const] : []),
      ...(metadata.quality === 'poor' ? ['POOR_QUALITY' as const] : [])
    ];
    return {
      source_id: record.source_id,
      source_name: record.source_name,
      kind: record.kind,
      completeness,
      status,
      unit: metadata.unit,
      total_units: metadata.total_units,
      processed_units: metadata.processed_units,
      text_coverage_ratio: metadata.text_coverage_ratio,
      sparse_units: metadata.sparse_units,
      truncated: metadata.truncated,
      quality: metadata.quality,
      warning_count: (record.parse_warnings || []).length,
      warning_codes: Array.from(new Set(warningCodes))
    };
  });
  const overallCompleteness = sources.length > 0
    ? clampPercent(sources.reduce((sum, source) => sum + source.completeness, 0) / sources.length)
    : 0;
  const status = overallCompleteness === 100 && sources.every(source => source.status === 'COMPLETE')
    ? 'COMPLETE' as const
    : overallCompleteness === 0
      ? 'FAILED' as const
      : 'PARTIAL' as const;
  return {
    overall_completeness: overallCompleteness,
    status,
    warning_count: sources.reduce((sum, source) => sum + source.warning_count, 0),
    sources,
    blocking_reasons: sources
      .filter(source => source.status !== 'COMPLETE')
      .map(source => `${source.source_id}: extraction ${source.status.toLowerCase()} (${source.completeness}%)`)
  };
};

const splitLongText = (text: string): Array<{ text: string; start: number; end: number }> => {
  const normalized = text.trim();
  if (normalized.length <= CHUNK_TARGET_CHARS) return [{ text: normalized, start: 0, end: normalized.length }];

  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(cursor + CHUNK_TARGET_CHARS, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n', end);
      const sentence = normalized.lastIndexOf('. ', end);
      const best = Math.max(boundary, sentence);
      if (best > cursor + 800) end = best + 1;
    }
    const part = normalized.slice(cursor, end).trim();
    if (part.length > 0) chunks.push({ text: part, start: cursor, end });
    if (end >= normalized.length) break;
    cursor = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
};

const sourceIdFor = (index: number): string => `src-${String(index + 1).padStart(3, '0')}`;
const chunkIdFor = (sourceId: string, index: number, pageNumber?: number): string => (
  pageNumber
    ? `${sourceId}-p${String(pageNumber).padStart(3, '0')}-c${String(index + 1).padStart(3, '0')}`
    : `${sourceId}-c${String(index + 1).padStart(3, '0')}`
);

const inferType = (sourceName: string, text: string, pageNumber?: number): SourceChunk['type'] => {
  if (pageNumber) return 'pdf_page';
  if (/\[TABLE_SAMPLE\]|^Format:\s*(CSV|TSV)/im.test(text)) return 'table_profile';
  if (/^\s*\{[\s\S]*\}\s*$/.test(text) || /\.json$/i.test(sourceName)) return 'metadata';
  return 'text';
};

const tableRowChunks = (text: string): Array<{ rowNumber: number; text: string }> => {
  const match = text.match(/\[TABLE_SAMPLE\]\s*([\s\S]*?)\s*\[\/TABLE_SAMPLE\]/);
  if (!match) return [];
  const lines = match[1]
    .split(/\n+/)
    .map(line => normalize(line))
    .filter(Boolean);
  const header = lines[0] || '';
  return lines.slice(1, 151).map((row, idx) => {
    const located = row.match(/^\[ROW\s+(\d+)(?:\s+reasons=([A-Z0-9_,-]+))?\]\s*(.*)$/i);
    const rowNumber = located ? Number(located[1]) : idx + 1;
    const reasons = located?.[2];
    const values = located ? located[3] : row;
    return {
      rowNumber,
      text: `Table evidence sample row ${rowNumber}${reasons ? `\nSelection reasons: ${reasons}` : ''}\nHeaders: ${header}\nValues: ${values}`
    };
  });
};

const scoreDomain = (haystack: string, domain: string): SourceChunkRoutingHint => {
  const terms = DOMAIN_TERMS[domain] || [];
  const reasons: string[] = [];
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length > 8 ? 3 : 2;
      if (reasons.length < 4) reasons.push(term);
    }
  }
  const tier: SourceRelevanceTier = score >= 6 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { domain, score, tier, reasons };
};

const routeChunk = (text: string): SourceChunkRoutingHint[] => {
  const haystack = text.toLowerCase();
  const hints = Object.keys(BATCH_TITLES).map(domain => scoreDomain(haystack, domain));
  const anySignal = hints.some(h => h.score > 0);
  if (!anySignal) {
    return Object.keys(BATCH_TITLES).map(domain => ({ domain, score: 0, tier: 'unknown' as const, reasons: [] }));
  }
  return hints;
};

const validateSourceRecords = (records: SourceRecord[]): void => {
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    throw new Error('INVALID_SOURCE_RECORDS');
  }
  const sourceIds = new Set<string>();
  for (const record of records) {
    if (!record || record.schema_version !== 'source_record_v1'
      || typeof record.source_id !== 'string' || !SOURCE_ID_PATTERN.test(record.source_id)
      || sourceIds.has(record.source_id)
      || typeof record.source_name !== 'string' || record.source_name.length === 0 || record.source_name.length > 500
      || !SOURCE_KINDS.has(record.kind)
      || (record.text !== undefined && typeof record.text !== 'string')
      || (record.parse_warnings !== undefined && (!Array.isArray(record.parse_warnings) || record.parse_warnings.some(warning => typeof warning !== 'string' || warning.length > 1000)))
      || (record.acquisition !== undefined && (
        record.acquisition.schema_version !== 'evidence_source_acquisition_v1'
        || record.acquisition.source_role !== 'CUSTOMER_EVIDENCE'
        || !SHA256_PATTERN.test(record.acquisition.original_sha256)
        || !Number.isInteger(record.acquisition.byte_size) || record.acquisition.byte_size < 0
        || record.acquisition.validation_status !== 'PASS'
        || !Array.isArray(record.acquisition.validation_codes) || record.acquisition.validation_codes.length !== 0
        || record.acquisition.extraction_status !== 'PASS'
        || record.acquisition.extraction_method === 'not_started'
        || typeof record.acquisition.extraction_version !== 'string' || record.acquisition.extraction_version.length === 0
      ))
      || (record.extraction !== undefined && (
        !['document', 'page', 'row'].includes(record.extraction.unit)
        || !Number.isInteger(record.extraction.total_units) || record.extraction.total_units < 0
        || !Number.isInteger(record.extraction.processed_units) || record.extraction.processed_units < 0
        || record.extraction.processed_units > record.extraction.total_units
        || (record.extraction.text_coverage_ratio !== undefined
          && (!Number.isFinite(record.extraction.text_coverage_ratio)
            || record.extraction.text_coverage_ratio < 0
            || record.extraction.text_coverage_ratio > 1))
        || typeof record.extraction.truncated !== 'boolean'
      ))) {
      throw new Error('INVALID_SOURCE_RECORD');
    }
    sourceIds.add(record.source_id);
    const hasText = typeof record.text === 'string' && record.text.trim().length > 0;
    const hasPages = Array.isArray(record.pages) && record.pages.length > 0;
    const hasVisualUnits = Array.isArray(record.visual_units) && record.visual_units.length > 0;
    if (record.kind === 'image') {
      if (hasText || hasPages || !hasVisualUnits
        || record.acquisition?.extraction_method !== 'local_ocr') throw new Error('INVALID_SOURCE_CONTENT');
    } else if (hasText === hasPages || (hasVisualUnits && record.kind !== 'pdf')) throw new Error('INVALID_SOURCE_CONTENT');
    if (hasPages) {
      const pageIds = new Set<string>();
      const pageNumbers = new Set<number>();
      let nonEmptyPageCount = 0;
      for (const page of record.pages!) {
        if (!page || page.schema_version !== 'source_page_v1'
          || typeof page.page_id !== 'string' || !SOURCE_ID_PATTERN.test(page.page_id) || pageIds.has(page.page_id)
          || !Number.isInteger(page.page_number) || page.page_number < 1 || pageNumbers.has(page.page_number)
          || typeof page.text !== 'string'
          || (page.acquisition_state !== undefined && !PDF_PAGE_STATES.has(page.acquisition_state))) {
          throw new Error('INVALID_SOURCE_PAGE');
        }
        if (page.text.trim().length > 0) nonEmptyPageCount++;
        pageIds.add(page.page_id);
        pageNumbers.add(page.page_number);
      }
      if (nonEmptyPageCount === 0) throw new Error('INVALID_SOURCE_CONTENT');
    }
    const tables = [...(record.structured_table ? [record.structured_table] : []), ...(record.structured_tables || [])];
    if ((record.structured_tables !== undefined && (
      record.kind !== 'xlsx' || !Array.isArray(record.structured_tables) || record.structured_tables.length === 0
      || record.structured_tables.length > 20 || record.structured_table !== undefined
    )) || (tables.length > 0 && !['csv', 'tsv', 'xlsx'].includes(record.kind))
      || tables.some(table => !validStructuredTable(table))) {
      throw new Error('INVALID_STRUCTURED_TABLE');
    }
    if (record.kind === 'xlsx' && record.structured_tables) {
      const sheetNames = new Set<string>();
      if (!record.structured_tables.some(table => table.model_eligible)) throw new Error('INVALID_STRUCTURED_TABLE');
      for (const table of record.structured_tables) {
        if (!table.sheet_name || sheetNames.has(table.sheet_name)
          || table.model_eligible !== (table.sheet_visibility === 'visible')) throw new Error('INVALID_STRUCTURED_TABLE');
        sheetNames.add(table.sheet_name);
      }
    }
    if (record.visual_units) {
      const unitIds = new Set<string>();
      for (const unit of record.visual_units) {
        if (!unit || unit.schema_version !== 'visual_evidence_unit_v1'
          || !SOURCE_ID_PATTERN.test(unit.unit_id) || unitIds.has(unit.unit_id)
          || unit.source_id !== record.source_id
          || unit.extraction_method !== 'local_ocr' || unit.engine_version !== 'tesseract.js@7.0.0'
          || !['eng', 'eng+fin'].includes(unit.language)
          || (record.kind === 'pdf' && (!Number.isInteger(unit.page_number) || !record.pages?.some(page => page.page_number === unit.page_number)))
          || (record.kind === 'pdf' && unit.words.length === 0)
          || (record.kind === 'image' && unit.page_number !== undefined)
          || !Number.isInteger(unit.width) || unit.width < 1 || unit.width > 10000
          || !Number.isInteger(unit.height) || unit.height < 1 || unit.height > 10000
          || unit.width * unit.height > 20_000_000
          || !Number.isFinite(unit.confidence) || unit.confidence < 0 || unit.confidence > 100
          || typeof unit.text !== 'string' || unit.text.trim().length === 0
          || !Array.isArray(unit.words) || unit.words.some(word =>
            typeof word.text !== 'string' || !word.text
            || !Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 100
            || ![word.bounding_box.x0, word.bounding_box.y0, word.bounding_box.x1, word.bounding_box.y1].every(Number.isFinite)
            || word.bounding_box.x0 < 0 || word.bounding_box.y0 < 0
            || word.bounding_box.x1 > unit.width || word.bounding_box.y1 > unit.height
            || word.bounding_box.x0 >= word.bounding_box.x1 || word.bounding_box.y0 >= word.bounding_box.y1)
          || !['PASSED', 'PASSED_WITH_REDACTIONS'].includes(unit.post_ocr_redaction_status)
          || unit.visual_interpretation_status !== 'OCR_TEXT_ONLY'
          || !Array.isArray(unit.withheld_regions) || unit.withheld_regions.length === 0
          || unit.withheld_regions.some(region => region.reason !== 'UNINSPECTED_VISUAL_REGION'
            || ![region.bounding_box.x0, region.bounding_box.y0, region.bounding_box.x1, region.bounding_box.y1].every(Number.isFinite)
            || region.bounding_box.x0 < 0 || region.bounding_box.y0 < 0
            || region.bounding_box.x1 > unit.width || region.bounding_box.y1 > unit.height
            || region.bounding_box.x0 >= region.bounding_box.x1 || region.bounding_box.y0 >= region.bounding_box.y1)) {
          throw new Error('INVALID_VISUAL_EVIDENCE_UNIT');
        }
        unitIds.add(unit.unit_id);
      }
    }
  }
};

export const buildSourceRegistry = (records: SourceRecord[]): SourceRegistry => {
  validateSourceRecords(records);
  const chunks: SourceChunk[] = [];
  const warnings: string[] = [];
  const workbookTables = records.flatMap(record => record.structured_tables || []);
  const unsupportedObjectCodes = [...new Set(workbookTables.flatMap(table => table.unsupported_objects || []))].sort();
  const acquisitionLimitations: SourceRegistry['acquisition_limitations'] = {
    schema_version: 'evidence_acquisition_limitations_v1',
    withheld_sheet_count: workbookTables.filter(table => table.model_eligible === false).length,
    withheld_row_count: workbookTables.reduce((sum, table) => sum + (table.hidden_row_count || 0), 0),
    withheld_column_count: workbookTables.reduce((sum, table) => sum + (table.hidden_column_count || 0), 0),
    active_filter_table_count: workbookTables.filter(table => Boolean(table.active_filter_range)).length,
    merged_range_count: workbookTables.reduce((sum, table) => sum + (table.merged_range_count || 0), 0),
    uninspected_workbook_image_source_count: records.filter(record =>
      record.structured_tables?.some(table => table.unsupported_objects?.includes('WORKBOOK_IMAGE_REQUIRES_VISUAL_INSPECTION'))
    ).length,
    partial_native_chart_count: workbookTables.flatMap(table => table.native_charts || [])
      .filter(chart => chart.extraction_status === 'PARTIAL').length,
    unsupported_object_codes: unsupportedObjectCodes
  };
  records.forEach((doc, docIndex) => {
    const sourceId = doc.source_id || sourceIdFor(docIndex);
    if (doc.kind === 'image') {
      warnings.push(...(doc.parse_warnings || []).map(warning => `${sourceId}: ${warning}`));
      for (const [unitIndex, unit] of doc.visual_units!.entries()) {
        const split = splitLongText(unit.text);
        for (const [partIndex, part] of split.entries()) {
          chunks.push({
            chunk_id: `${sourceId}-v${String(unitIndex + 1).padStart(3, '0')}-c${String(partIndex + 1).padStart(3, '0')}`,
            source_id: sourceId,
            source_name: doc.source_name,
            type: 'image',
            text: part.text,
            visual_unit_id: unit.unit_id,
            bounding_box: { x0: 0, y0: 0, x1: unit.width, y1: unit.height },
            ocr_confidence: unit.confidence,
            ocr_extraction_method: unit.extraction_method,
            ocr_engine_version: unit.engine_version,
            ocr_language: unit.language,
            post_ocr_redaction_status: unit.post_ocr_redaction_status as Exclude<typeof unit.post_ocr_redaction_status, 'PENDING'>,
            visual_interpretation_status: unit.visual_interpretation_status,
            withheld_visual_region_count: unit.withheld_regions.length,
            char_start: part.start,
            char_end: part.end,
            routing: routeChunk(part.text),
            parse_warnings: doc.parse_warnings
          });
        }
      }
      return;
    }
    warnings.push(...(doc.parse_warnings || []).map(warning => `${sourceId}: ${warning}`));
    let chunkIndex = 0;
    if (doc.kind === 'xlsx' && doc.structured_tables) {
      for (const table of doc.structured_tables.filter(item => item.model_eligible)) {
        const context = renderStructuredTableContext(table, 'XLSX');
        chunks.push({
          chunk_id: chunkIdFor(sourceId, chunkIndex++),
          source_id: sourceId,
          source_name: doc.source_name,
          type: 'table_profile',
          text: context,
          sheet_name: table.sheet_name,
          char_start: 0,
          char_end: context.length,
          routing: routeChunk(context)
        });
        for (const row of tableRowChunks(context)) {
          chunks.push({
            chunk_id: chunkIdFor(sourceId, chunkIndex++),
            source_id: sourceId,
            source_name: doc.source_name,
            type: 'table_row',
            text: row.text,
            sheet_name: table.sheet_name,
            row_number: row.rowNumber,
            routing: routeChunk(row.text)
          });
        }
      }
      return;
    }
    const pages: Array<{ pageNumber?: number; text: string; visualUnit?: VisualEvidenceUnit }> = doc.pages?.length
      ? doc.pages.filter(page => page.text.trim().length > 0).map(page => ({
          pageNumber: page.page_number,
          text: page.text,
          visualUnit: doc.visual_units?.find(unit => unit.page_number === page.page_number)
        }))
      : [{ text:doc.text || '' }];
    for (const page of pages) {
      const isTable = !page.pageNumber && /\[TABLE_SAMPLE\]/.test(page.text);
      if (isTable) {
        const chunkId = chunkIdFor(sourceId, chunkIndex, page.pageNumber);
        chunks.push({
          chunk_id: chunkId,
          source_id: sourceId,
          source_name: doc.source_name,
          type: 'table_profile',
          text: page.text,
          char_start: 0,
          char_end: page.text.length,
          routing: routeChunk(page.text)
        });
        chunkIndex++;
        for (const row of tableRowChunks(page.text)) {
          const rowChunkId = chunkIdFor(sourceId, chunkIndex);
          chunks.push({
            chunk_id: rowChunkId,
            source_id: sourceId,
            source_name: doc.source_name,
            type: 'table_row',
            text: row.text,
            row_number: row.rowNumber,
            routing: routeChunk(row.text)
          });
          chunkIndex++;
        }
        continue;
      }
      const split = splitLongText(page.text);
      for (const part of split) {
        const chunkId = chunkIdFor(sourceId, chunkIndex, page.pageNumber);
        const chunkText = part.text;
        chunks.push({
          chunk_id: chunkId,
          source_id: sourceId,
          source_name: doc.source_name,
          type: inferType(doc.source_name, chunkText, page.pageNumber),
          text: chunkText,
          page_id: page.pageNumber ? `${sourceId}-p${String(page.pageNumber).padStart(3, '0')}` : undefined,
          page_number: page.pageNumber,
          visual_unit_id: page.visualUnit?.unit_id,
          bounding_box: page.visualUnit ? { x0: 0, y0: 0, x1: page.visualUnit.width, y1: page.visualUnit.height } : undefined,
          ocr_confidence: page.visualUnit?.confidence,
          ocr_extraction_method: page.visualUnit?.extraction_method,
          ocr_engine_version: page.visualUnit?.engine_version,
          ocr_language: page.visualUnit?.language,
          post_ocr_redaction_status: page.visualUnit?.post_ocr_redaction_status as Exclude<VisualEvidenceUnit['post_ocr_redaction_status'], 'PENDING'> | undefined,
          visual_interpretation_status: page.visualUnit?.visual_interpretation_status,
          withheld_visual_region_count: page.visualUnit?.withheld_regions.length,
          char_start: part.start,
          char_end: part.end,
          routing: routeChunk(chunkText),
          parse_warnings: doc.parse_warnings
        });
        chunkIndex++;
      }
    }
  });

  return {
    source_count: new Set(chunks.map(chunk => chunk.source_id)).size,
    chunk_count: chunks.length,
    chunks,
    source_acquisition: records.map(record => ({
      source_id: record.source_id,
      original_sha256: record.acquisition?.original_sha256,
      byte_size: record.acquisition?.byte_size,
      declared_media_type: record.acquisition?.declared_media_type,
      detected_media_type: record.acquisition?.detected_media_type,
      format: record.kind,
      validation_status: record.acquisition ? 'PASS' as const : 'NOT_RECORDED' as const,
      extraction_method: record.acquisition?.extraction_method,
      extraction_version: record.acquisition?.extraction_version,
      extraction_status: record.acquisition?.extraction_status
    })),
    acquisition_limitations: acquisitionLimitations,
    warnings,
    extraction: buildExtractionQuality(records)
  };
};

const tierForDomain = (chunk: SourceChunk, domain: string): SourceRelevanceTier => {
  return chunk.routing.find(r => r.domain === domain)?.tier || 'unknown';
};

const scoreForDomain = (chunk: SourceChunk, domain: string): number => {
  return chunk.routing.find(r => r.domain === domain)?.score || 0;
};

const routedDomains = (chunk: SourceChunk): string[] => chunk.routing
  .filter(r => r.tier === 'high' || r.tier === 'medium')
  .map(r => r.domain);

const hasGapOrContradictionSignal = (chunk: SourceChunk): boolean => {
  const lower = chunk.text.toLowerCase();
  return GAP_TERMS.some(term => lower.includes(term)) || CONTRADICTION_TERMS.some(term => lower.includes(term));
};

const renderChunk = (chunk: SourceChunk, relevance: SourceRelevanceTier): string => {
  const attrs = [
    `id="${escapeXml(chunk.chunk_id)}"`,
    `source_id="${escapeXml(chunk.source_id)}"`,
    chunk.page_id ? `page_id="${escapeXml(chunk.page_id)}"` : '',
    chunk.page_number ? `page="${chunk.page_number}"` : '',
    chunk.sheet_name ? `sheet="${escapeXml(chunk.sheet_name)}"` : '',
    chunk.row_number ? `row="${chunk.row_number}"` : '',
    chunk.visual_unit_id ? `visual_unit_id="${escapeXml(chunk.visual_unit_id)}"` : '',
    chunk.bounding_box ? `region="${chunk.bounding_box.x0},${chunk.bounding_box.y0},${chunk.bounding_box.x1},${chunk.bounding_box.y1}"` : '',
    chunk.ocr_confidence !== undefined ? `ocr_confidence="${chunk.ocr_confidence}"` : '',
    chunk.ocr_extraction_method ? `ocr_method="${chunk.ocr_extraction_method}"` : '',
    chunk.ocr_engine_version ? `ocr_engine="${chunk.ocr_engine_version}"` : '',
    chunk.ocr_language ? `ocr_language="${chunk.ocr_language}"` : '',
    chunk.post_ocr_redaction_status ? `post_ocr_redaction="${chunk.post_ocr_redaction_status}"` : '',
    chunk.visual_interpretation_status ? `visual_interpretation="${chunk.visual_interpretation_status}"` : '',
    chunk.withheld_visual_region_count !== undefined ? `withheld_visual_regions="${chunk.withheld_visual_region_count}"` : '',
    `type="${chunk.type}"`,
    `relevance="${relevance}"`,
    `routed_domains="${escapeXml(routedDomains(chunk).join(','))}"`
  ].filter(Boolean).join(' ');
  return `<CHUNK ${attrs}>\n${escapeXml(chunk.text)}\n</CHUNK>`;
};

const manifestFor = (chunk: SourceChunk, relevance: SourceRelevanceTier): SourcePacketManifestItem => ({
  chunk_id: chunk.chunk_id,
  source_id: chunk.source_id,
  page_id: chunk.page_id,
  page_number: chunk.page_number,
  sheet_name: chunk.sheet_name,
  row_number: chunk.row_number,
  visual_unit_id: chunk.visual_unit_id,
  bounding_box: chunk.bounding_box,
  ocr_confidence: chunk.ocr_confidence,
  ocr_extraction_method: chunk.ocr_extraction_method,
  ocr_engine_version: chunk.ocr_engine_version,
  ocr_language: chunk.ocr_language,
  post_ocr_redaction_status: chunk.post_ocr_redaction_status,
  visual_interpretation_status: chunk.visual_interpretation_status,
  withheld_visual_region_count: chunk.withheld_visual_region_count,
  type: chunk.type,
  relevance,
  routed_domains: routedDomains(chunk)
});

export const rankedDomainCandidates = (registry: SourceRegistry, domainId: string) => registry.chunks
    .map(chunk => ({ chunk, tier: tierForDomain(chunk, domainId), score: scoreForDomain(chunk, domainId) }))
    .filter(item => item.tier === 'high' || item.tier === 'medium' || hasGapOrContradictionSignal(item.chunk))
    .sort((a, b) => {
      const tierWeight = (tier: SourceRelevanceTier) => tier === 'high' ? 3 : tier === 'medium' ? 2 : tier === 'unknown' ? 1 : 0;
      return tierWeight(b.tier) - tierWeight(a.tier) || b.score - a.score || a.chunk.chunk_id.localeCompare(b.chunk.chunk_id);
    });

export const buildDomainPacket = (registry: SourceRegistry, domainId: string): RoutedSourcePacket => {
  const title = BATCH_TITLES[domainId] || domainId;
  const candidates = rankedDomainCandidates(registry, domainId);

  const included: Array<{ chunk: SourceChunk; tier: SourceRelevanceTier }> = [];
  let chars = 0;
  for (const item of candidates) {
    const nextLen = item.chunk.text.length + 260;
    const target = included.length < 3 ? HARD_PACKET_CHARS : TARGET_PACKET_CHARS;
    if (chars + nextLen > target) continue;
    included.push({ chunk: item.chunk, tier: item.tier });
    chars += nextLen;
    if (chars >= TARGET_PACKET_CHARS) break;
  }

  const imageChunks = included.filter(item => item.chunk.image).map(item => item.chunk.image!) as ImageInput[];
  const omittedRelevantChunks = Math.max(0, candidates.length - included.length);
  const weakCoverage = included.length < 2
    || included.every(item => item.tier !== 'high')
    || omittedRelevantChunks > 0;
  const coverageNotes = [
    weakCoverage
      ? `Packet ${domainId} has incomplete deterministic coverage; no broad-source fallback is permitted.`
      : `Packet ${domainId} includes high/medium relevance source chunks for ${title}.`,
    `Candidate chunks: ${candidates.length}; included chunks: ${included.length}; omitted relevant chunks: ${omittedRelevantChunks}.`
  ];

  const manifest = included.map(item => manifestFor(item.chunk, item.tier));
  const body = included.length > 0
    ? included.map(item => renderChunk(item.chunk, item.tier)).join('\n\n')
    : '<NO_ROUTED_CHUNKS>Deterministic routing found no domain-specific chunks. Treat source coverage as insufficient and do not infer findings or absence.</NO_ROUTED_CHUNKS>';
  const manifestText = manifest.map(item => [
    item.chunk_id,
    item.page_number ? `page ${item.page_number}` : '',
    item.type,
    item.relevance,
    item.routed_domains.join(',')
  ].filter(Boolean).map(value => escapeXml(String(value))).join(' | ')).join('\n');

  const text = `<SOURCE_PACKET domain="${escapeXml(domainId)}" title="${escapeXml(title)}">
<PACKET_RULES>
This packet controls attention, not truth. Use only cited source chunks as customer evidence. If coverage is weak, say so; do not infer maturity from routing.
Evidence quotes should include chunk_id/source_id/page_number when available.
</PACKET_RULES>
<COVERAGE_NOTES>
${coverageNotes.join('\n')}
</COVERAGE_NOTES>
<CHUNK_MANIFEST>
${manifestText}
</CHUNK_MANIFEST>
${body}
</SOURCE_PACKET>`;

  return {
    domain_id: domainId,
    title,
    text,
    images: imageChunks,
    manifest,
    included_chunk_count: included.length,
    total_candidate_chunks: candidates.length,
    weak_coverage: weakCoverage,
    coverage_notes: coverageNotes,
    char_count: text.length
  };
};

export const buildDomainPackets = (registry: SourceRegistry): Record<string, RoutedSourcePacket> => {
  return Object.fromEntries(Object.keys(BATCH_TITLES).map(domain => [domain, buildDomainPacket(registry, domain)]));
};

export const renderPseudonymousSourceContext = (registry: SourceRegistry, maxChars = 45000): string => {
  const rendered: string[]=[]; let chars=0;
  for(const chunk of registry.chunks){const value=renderChunk(chunk,'unknown');if(chars+value.length>maxChars)break;rendered.push(value);chars+=value.length;}
  return `<FULL_SOURCE_CONTEXT source_count="${registry.source_count}" chunk_count="${registry.chunk_count}">\n${rendered.join('\n\n')}\n</FULL_SOURCE_CONTEXT>`;
};

const countMatches = (text: string, rx: RegExp): number => {
  const matches = text.match(rx);
  return matches ? matches.length : 0;
};

export const scanRegistryDlp = (registry: SourceRegistry): DlpScanResult => {
  const patterns: Array<{ kind: DlpPatternHit['kind']; severity: DlpPatternHit['severity']; rx: RegExp }> = [
    { kind: 'cloud_key', severity: 'block', rx: /\bAKIA[0-9A-Z]{16}\b|\[AWS_KEY_REDACTED\]/g },
    { kind: 'secret', severity: 'block', rx: /\b(?:sk-[a-zA-Z0-9]{20,}|pk_[a-zA-Z0-9]{20,})\b|\[API_KEY_REDACTED\]/g },
    { kind: 'private_key', severity: 'block', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { kind: 'email', severity: 'caution', rx: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\[EMAIL_REDACTED\]/g },
    { kind: 'phone', severity: 'caution', rx: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\[PHONE_REDACTED\]/g },
    { kind: 'ip', severity: 'caution', rx: /\b\d{1,3}(?:\.\d{1,3}){3}\b|\[IP_REDACTED\]/g },
    { kind: 'financial_caution', severity: 'caution', rx: /\b(?:contract value|discount rate|edp pricing|negotiated rate|billing account|invoice number)\b/gi }
  ];

  const byKind = new Map<string, DlpPatternHit>();
  for (const chunk of registry.chunks) {
    for (const pattern of patterns) {
      const count = countMatches(chunk.text, pattern.rx);
      if (count === 0) continue;
      const existing = byKind.get(pattern.kind) || {
        kind: pattern.kind,
        severity: pattern.severity,
        count: 0,
        chunk_ids: []
      };
      existing.count += count;
      if (!existing.chunk_ids.includes(chunk.chunk_id)) existing.chunk_ids.push(chunk.chunk_id);
      byKind.set(pattern.kind, existing);
    }
  }

  const hits = Array.from(byKind.values());
  const high = hits.filter(hit => hit.severity === 'block');
  const caution = hits.filter(hit => hit.severity === 'caution');
  return {
    scanned_chunk_count: registry.chunk_count,
    high_risk_hits: high,
    caution_hits: caution,
    blocked: high.length > 0,
    warnings: [
      ...caution.map(hit => `${hit.kind}: ${hit.count} caution-level hit(s) across ${hit.chunk_ids.length} chunk(s).`),
      ...high.map(hit => `${hit.kind}: ${hit.count} high-risk hit(s) across ${hit.chunk_ids.length} chunk(s).`)
    ]
  };
};

const hasDlpRiskText = (chunk: SourceChunk): boolean => {
  return /\[EMAIL_REDACTED\]|\[PHONE_REDACTED\]|\[IP_REDACTED\]|\[AWS_KEY_REDACTED\]|\[API_KEY_REDACTED\]|AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|PRIVATE KEY|billing account|contract value|discount rate|edp pricing/i.test(chunk.text);
};

export const buildDlpReviewPacket = (registry: SourceRegistry): { text: string; images: ImageInput[]; selected_chunk_count: number } => {
  const selected = new Map<string, SourceChunk>();
  const chunks = registry.chunks.filter(chunk => chunk.type !== 'image');
  const add = (chunk?: SourceChunk) => {
    if (chunk) selected.set(chunk.chunk_id, chunk);
  };

  add(chunks[0]);
  add(chunks[chunks.length - 1]);
  chunks.filter(hasDlpRiskText).forEach(add);
  chunks.filter(chunk => chunk.type === 'table_profile').slice(0, 8).forEach(add);
  chunks.filter(chunk => (chunk.parse_warnings || []).length > 0).forEach(add);

  const representativeCount = Math.min(8, chunks.length);
  for (let i = 0; i < representativeCount; i++) {
    const idx = Math.floor((i / Math.max(1, representativeCount - 1)) * Math.max(0, chunks.length - 1));
    add(chunks[idx]);
  }

  const rendered: string[] = [];
  let chars = 0;
  for (const chunk of selected.values()) {
    const renderedChunk = renderChunk(chunk, 'medium');
    if (chars + renderedChunk.length > 32000) continue;
    rendered.push(renderedChunk);
    chars += renderedChunk.length;
  }

  const imageChunks = registry.chunks.filter(chunk => chunk.image).slice(0, 24);
  const text = `<DLP_REVIEW_PACKET>
<DLP_PACKET_SCOPE>
Distributed safety review packet built from the full source registry: first/last chunks, high-risk regex-hit chunks, table headers/profile chunks, parse-warning chunks, and representative later-page chunks.
Full deterministic DLP scanned ${registry.chunk_count} chunk(s); this model review packet contains ${selected.size} text chunk(s) plus ${imageChunks.length} image part(s).
</DLP_PACKET_SCOPE>
${rendered.join('\n\n')}
</DLP_REVIEW_PACKET>`;

  return {
    text,
    images: imageChunks.map(chunk => chunk.image!) as ImageInput[],
    selected_chunk_count: selected.size
  };
};

export const sourceRegistryRuntimeStatus = (
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
  dlpReviewChunkCount: number,
  dlpScan: DlpScanResult,
  privacyDecision: EvidencePrivacyDecision,
  integrity: { registry_hash: string; packet_manifest_hash: string }
): SourceRegistryRuntimeStatus => {
  const blockingReasons = [
    ...(registry.extraction.status === 'FAILED' ? ['SOURCE_EXTRACTION_FAILED'] : []),
    ...(dlpScan.blocked ? ['DETERMINISTIC_DLP_BLOCKED'] : []),
    ...(privacyDecision.decision === 'BLOCK' ? privacyDecision.blocking_codes : [])
  ];
  const warningReasons = [
    ...(registry.extraction.warning_count > 0 ? ['EXTRACTION_WARNINGS_PRESENT'] : []),
    ...(registry.acquisition_limitations.withheld_sheet_count > 0
      || registry.acquisition_limitations.withheld_row_count > 0
      || registry.acquisition_limitations.withheld_column_count > 0
      ? ['WITHHELD_WORKBOOK_CONTENT_PRESENT'] : []),
    ...(registry.acquisition_limitations.uninspected_workbook_image_source_count > 0
      ? ['UNINSPECTED_WORKBOOK_IMAGES_PRESENT'] : []),
    ...(registry.acquisition_limitations.partial_native_chart_count > 0
      ? ['PARTIAL_NATIVE_CHART_EXTRACTION_PRESENT'] : []),
    ...(registry.acquisition_limitations.active_filter_table_count > 0
      || registry.acquisition_limitations.merged_range_count > 0
      || registry.acquisition_limitations.unsupported_object_codes.length > 0
      ? ['WORKBOOK_STRUCTURE_WARNINGS_PRESENT'] : []),
    ...(dlpScan.caution_hits.length > 0 ? ['DLP_CAUTION_FINDINGS_PRESENT'] : []),
    ...(privacyDecision.decision === 'PASS_WITH_REDACTIONS' ? ['PRIVACY_REDACTIONS_APPLIED'] : []),
    ...(Object.values(packets).some(packet => packet.weak_coverage) ? ['PACKET_COVERAGE_WARNINGS_PRESENT'] : [])
  ];
  return ({
  source_count: registry.source_count,
  chunk_count: registry.chunk_count,
  dlp_review_chunk_count: dlpReviewChunkCount,
  dlp_high_risk_hits: dlpScan.high_risk_hits.reduce((sum, hit) => sum + hit.count, 0),
  dlp_caution_hits: dlpScan.caution_hits.reduce((sum, hit) => sum + hit.count, 0),
  acquisition_limitations: registry.acquisition_limitations,
  acquisition_readiness: {
    status: blockingReasons.length > 0 ? 'BLOCKED' : warningReasons.length > 0 ? 'READY_WITH_WARNINGS' : 'READY',
    reasons: blockingReasons.length > 0 ? blockingReasons : warningReasons,
    privacy_decision: privacyDecision.decision,
    registry_hash: integrity.registry_hash,
    packet_manifest_hash: integrity.packet_manifest_hash
  },
  extraction: registry.extraction,
  packets: Object.fromEntries(Object.entries(packets).map(([domain, packet]) => [domain, {
    included_chunk_count: packet.included_chunk_count,
    total_candidate_chunks: packet.total_candidate_chunks,
    weak_coverage: packet.weak_coverage,
    char_count: packet.char_count
  }]))
  });
};
