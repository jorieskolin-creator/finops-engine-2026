import { TextWriter, Uint8ArrayReader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import * as XLSX from 'xlsx';
import type { NativeChartEvidenceUnit, StructuredTableData } from '../types';
import { buildDeterministicTableInspection, renderStructuredTableContext, selectDeterministicTableSample, TABLE_SAMPLE_STRATEGY_VERSION } from './tableService';

const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_SHEETS = 20;
const MAX_ROWS = 250_000;
const MAX_COLUMNS = 200;
const MAX_CELL_CHARS = 240;
const MAX_CHARTS = 50;
const MAX_CHART_SERIES = 20;
const MAX_CHART_POINTS = 5_000;

export interface XlsxSheetManifest {
  sheet_name: string;
  visibility: 'visible' | 'hidden' | 'very_hidden';
  source_range?: string;
  selected: boolean;
  reason: 'SELECTED' | 'HIDDEN' | 'EMPTY' | 'ADDITIONAL_VISIBLE_SHEET';
}

export interface XlsxExtractionResult {
  schema_version: 'xlsx_extraction_v1';
  parser: 'sheetjs_ce';
  parser_version: '0.20.3';
  archive_inspector: 'zipjs';
  archive_inspector_version: '2.8.49';
  text: string;
  tables: StructuredTableData[];
  native_charts: NativeChartEvidenceUnit[];
  sheets: XlsxSheetManifest[];
  warnings: string[];
}

const decodeXmlText = (value: string): string => value
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/\s+/g, ' ').trim();

const xmlBlocks = (xml: string, localName: string): string[] => {
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`, 'gi');
  return [...xml.matchAll(pattern)].map(match => match[1]);
};

const firstXmlValue = (xml: string, localName: string): string | undefined => {
  const value = xmlBlocks(xml, localName)[0];
  return value === undefined ? undefined : decodeXmlText(value);
};

const cachedValues = (xml: string, numeric: boolean): Array<string | number | null> => {
  const cache = xmlBlocks(xml, numeric ? 'numCache' : 'strCache')[0];
  if (!cache) return [];
  const pointCountMatch = cache.match(/<(?:[A-Za-z_][\w.-]*:)?ptCount\b[^>]*\bval="(\d+)"/i);
  const pointCount = pointCountMatch ? Number(pointCountMatch[1]) : 0;
  const points = [...cache.matchAll(/<(?:[A-Za-z_][\w.-]*:)?pt\b[^>]*\bidx="(\d+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?pt>/gi)]
    .map(match => ({ index: Number(match[1]), value: firstXmlValue(match[2], 'v') || '' }));
  const length = Math.max(Number.isInteger(pointCount) ? pointCount : 0, ...points.map(point => point.index + 1), 0);
  const values: Array<string | number | null> = Array.from({ length }, () => numeric ? null : '');
  for (const point of points) {
    if (point.index >= length) continue;
    if (!numeric) values[point.index] = point.value;
    else {
      const parsed = Number(point.value);
      values[point.index] = Number.isFinite(parsed) ? parsed : null;
    }
  }
  return values;
};

export const parseNativeChartXml = (chartPart: string, xml: string): NativeChartEvidenceUnit => {
  const chartTypes = ['barChart', 'lineChart', 'pieChart', 'doughnutChart', 'areaChart', 'scatterChart', 'bubbleChart', 'radarChart', 'surfaceChart', 'stockChart'];
  const chartType = chartTypes.find(type => new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${type}\\b`, 'i').test(xml)) || 'unknown';
  const titleBlock = xmlBlocks(xml, 'title')[0] || '';
  const title = xmlBlocks(titleBlock, 't').map(decodeXmlText).filter(Boolean).join(' ') || undefined;
  const axisTitles = xmlBlocks(xml, 'catAx').concat(xmlBlocks(xml, 'valAx'))
    .flatMap(axis => xmlBlocks(xmlBlocks(axis, 'title')[0] || '', 't').map(decodeXmlText).filter(Boolean));
  const warnings: string[] = [];
  const seriesBlocks = xmlBlocks(xml, 'ser');
  if (seriesBlocks.length > MAX_CHART_SERIES) throw new Error('XLSX_CHART_SERIES_LIMIT_EXCEEDED');
  let pointCount = 0;
  const series = seriesBlocks.map(block => {
    const tx = xmlBlocks(block, 'tx')[0] || '';
    const category = xmlBlocks(block, 'cat')[0] || xmlBlocks(block, 'xVal')[0] || '';
    const value = xmlBlocks(block, 'val')[0] || xmlBlocks(block, 'yVal')[0] || '';
    const name = firstXmlValue(xmlBlocks(tx, 'strCache')[0] || '', 'v') || firstXmlValue(tx, 'v');
    const categoryRange = firstXmlValue(category, 'f');
    const valueRange = firstXmlValue(value, 'f');
    if ([categoryRange, valueRange].some(range => range?.includes('['))) throw new Error('XLSX_EXTERNAL_LINK_REJECTED');
    const categories = (cachedValues(category, false).length > 0
      ? cachedValues(category, false)
      : cachedValues(category, true)).map(String);
    const values = cachedValues(value, true) as Array<number | null>;
    pointCount += Math.max(categories.length, values.length);
    if (categories.length === 0) warnings.push('CHART_CATEGORIES_CACHE_UNAVAILABLE');
    if (values.length === 0) warnings.push('CHART_VALUES_CACHE_UNAVAILABLE');
    return { name, category_range: categoryRange, value_range: valueRange, categories, values };
  });
  if (pointCount > MAX_CHART_POINTS) throw new Error('XLSX_CHART_POINT_LIMIT_EXCEEDED');
  const formulas = series.flatMap(item => [item.category_range, item.value_range]).filter(Boolean) as string[];
  const sheetName = formulas.map(formula => formula.match(/^(?:'((?:[^']|'')+)'|([^!]+))!/))
    .find(Boolean)?.slice(1).find(Boolean)?.replace(/''/g, "'");
  if (chartType === 'unknown') warnings.push('CHART_TYPE_UNSUPPORTED');
  if (series.length === 0) warnings.push('CHART_SERIES_UNAVAILABLE');
  return {
    schema_version: 'native_chart_evidence_unit_v1',
    chart_id: `chart-${chartPart.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    chart_part: chartPart,
    sheet_name: sheetName,
    chart_type: chartType,
    title,
    axis_titles: axisTitles,
    series,
    extraction_status: warnings.length === 0 ? 'COMPLETE' : 'PARTIAL',
    warnings: [...new Set(warnings)].sort()
  };
};

const blockedEntry = (name: string): string | null => {
  const normalized = name.toLowerCase();
  if (/vbaproject|\.bin$/.test(normalized)) return 'XLSX_ACTIVE_CONTENT_REJECTED';
  if (/^xl\/(?:embeddings|oleobjects)\//.test(normalized)) return 'XLSX_EMBEDDED_OBJECT_REJECTED';
  if (/^xl\/externallinks\//.test(normalized)) return 'XLSX_EXTERNAL_LINK_REJECTED';
  return null;
};

export const inspectXlsxArchive = async (bytes: Uint8Array): Promise<{ unsupportedObjects: string[]; nativeCharts: NativeChartEvidenceUnit[] }> => {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('XLSX_ARCHIVE_ENTRY_LIMIT_EXCEEDED');
    const names = new Set(entries.map(entry => entry.filename));
    if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('XLSX_STRUCTURE_INVALID');
    let totalUncompressed = 0;
    const unsupportedObjects = new Set<string>();
    const chartEntries: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.encrypted) throw new Error('XLSX_ENCRYPTED_REJECTED');
      const rejection = blockedEntry(entry.filename);
      if (rejection) throw new Error(rejection);
      totalUncompressed += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('XLSX_DECOMPRESSED_SIZE_LIMIT_EXCEEDED');
      }
      if (entry.uncompressedSize > 1_000_000 && entry.compressedSize > 0
        && entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO) {
        throw new Error('XLSX_COMPRESSION_RATIO_LIMIT_EXCEEDED');
      }
      const normalized = entry.filename.toLowerCase();
      if (!entry.directory && /^xl\/charts\/chart[^/]*\.xml$/.test(normalized)) chartEntries.push(entry);
      if (/^xl\/media\//.test(normalized)) unsupportedObjects.add('WORKBOOK_IMAGE_REQUIRES_VISUAL_INSPECTION');
      if (/^xl\/(?:comments|threadedcomments)\//.test(normalized)) unsupportedObjects.add('CELL_COMMENTS_NOT_INSPECTED');
    }
    if (chartEntries.length > MAX_CHARTS) throw new Error('XLSX_CHART_LIMIT_EXCEEDED');
    const nativeCharts: NativeChartEvidenceUnit[] = [];
    for (const entry of chartEntries.sort((a, b) => a.filename.localeCompare(b.filename))) {
      nativeCharts.push(parseNativeChartXml(entry.filename, await entry.getData(new TextWriter())));
    }
    return { unsupportedObjects: [...unsupportedObjects].sort(), nativeCharts };
  } finally {
    await reader.close();
  }
};

const visibilityFor = (hidden: number | undefined): XlsxSheetManifest['visibility'] =>
  hidden === 2 ? 'very_hidden' : hidden === 1 ? 'hidden' : 'visible';

const cellText = (cell: XLSX.CellObject | undefined): string => {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  const value = cell.w ?? XLSX.utils.format_cell(cell);
  return String(value).replace(/\s+/g, ' ').trim();
};

const boundedCell = (value: string): string => value.length > MAX_CELL_CHARS
  ? `${value.slice(0, MAX_CELL_CHARS)}...`
  : value;

const uniqueHeaders = (values: string[], startColumn: number): string[] => {
  const seen = new Map<string, number>();
  return values.map((value, index) => {
    const base = value || `column_${XLSX.utils.encode_col(startColumn + index)}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
};

export const parseXlsxBytes = async (bytes: Uint8Array, sourceHash?: string): Promise<XlsxExtractionResult> => {
  const archive = await inspectXlsxArchive(bytes);
  const workbook = XLSX.read(bytes, {
    type: 'array',
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: false,
    bookVBA: false,
    WTF: false
  });
  if (workbook.SheetNames.length === 0 || workbook.SheetNames.length > MAX_SHEETS) throw new Error('XLSX_SHEET_LIMIT_EXCEEDED');

  const sheetDetails = workbook.SheetNames.map((sheetName, index) => {
    const sheet = workbook.Sheets[sheetName];
    const visibility = visibilityFor(workbook.Workbook?.Sheets?.[index]?.Hidden);
    return { sheetName, sheet, visibility, range: sheet['!ref'], sheetIndex: index };
  });
  const warnings: string[] = [];
  warnings.push(...archive.unsupportedObjects.map(code => `Unsupported workbook object: ${code}.`));
  warnings.push(...archive.nativeCharts.flatMap(chart => chart.warnings.map(code => `Native chart ${chart.chart_id}: ${code}.`)));
  const nonEmptySheets = sheetDetails.filter(item => Boolean(item.range));
  if (!nonEmptySheets.some(item => item.visibility === 'visible')) throw new Error('XLSX_NO_VISIBLE_NONEMPTY_SHEET');
  const extractedSheetNames = new Set(nonEmptySheets.map(item => item.sheetName));
  let totalDataRows = 0;
  const tables: StructuredTableData[] = [];
  for (const [tableIndex, detail] of nonEmptySheets.entries()) {
    const range = XLSX.utils.decode_range(detail.range!);
    const rowCapacity = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;
    if (rowCapacity > MAX_ROWS + 1) throw new Error('XLSX_ROW_LIMIT_EXCEEDED');
    if (columnCount > MAX_COLUMNS) throw new Error('XLSX_COLUMN_LIMIT_EXCEEDED');

    let formulaCellCount = 0;
    let formulaCachedValueMissingCount = 0;
    let headerRow = -1;
    const physicalRows: Array<{ rowNumber: number; values: string[] }> = [];
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
      const values: string[] = [];
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex++) {
        const cell = detail.sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (cell?.f) {
          formulaCellCount++;
          if (cell.v === undefined || cell.v === null) formulaCachedValueMissingCount++;
        }
        if (cell?.l?.Target && /^(?:https?:|file:|\\\\)/i.test(cell.l.Target)) throw new Error('XLSX_EXTERNAL_LINK_REJECTED');
        values.push(cellText(cell));
      }
      if (values.some(Boolean)) {
        if (headerRow < 0) headerRow = rowIndex;
        physicalRows.push({ rowNumber: rowIndex + 1, values });
      }
    }
    if (headerRow < 0 || physicalRows.length === 0) continue;
    const headers = uniqueHeaders(physicalRows[0].values, range.s.c);
    const dataRows = physicalRows.slice(1);
    totalDataRows += dataRows.length;
    if (totalDataRows > MAX_ROWS) throw new Error('XLSX_TOTAL_ROW_LIMIT_EXCEEDED');
    const analysisRows = dataRows.map(row => row.values);
    const analysisRowNumbers = dataRows.map(row => row.rowNumber);
    const sample = selectDeterministicTableSample({
      headers,
      rows: analysisRows,
      rowNumbers: analysisRowNumbers,
      sourceHash: sourceHash ? `${sourceHash}:${detail.sheetIndex}` : undefined
    });
    if (dataRows.length > sample.rows.length) warnings.push(`Workbook sheet ${detail.sheetIndex + 1} has ${dataRows.length} data rows; a deterministic bounded sample of ${sample.rows.length} rows was included for model context.`);
    if (formulaCellCount > 0) warnings.push(`Workbook sheet ${detail.sheetIndex + 1} contains ${formulaCellCount} formula cell(s); cached values were recorded and formulas were not executed.`);
    if (formulaCachedValueMissingCount > 0) warnings.push(`Workbook sheet ${detail.sheetIndex + 1} contains ${formulaCachedValueMissingCount} formula cell(s) without cached values; they were treated as empty.`);
    const nativeCharts = archive.nativeCharts.filter(chart =>
      chart.sheet_name === detail.sheetName || ((!chart.sheet_name || !extractedSheetNames.has(chart.sheet_name)) && tableIndex === 0)
    );
    tables.push({
      schema_version: 'structured_table_v1',
      sheet_name: detail.sheetName,
      sheet_visibility: detail.visibility,
      model_eligible: detail.visibility === 'visible',
      source_range: detail.range,
      header_row_number: headerRow + 1,
      headers,
      rows: sample.rows.map(row => row.map(boundedCell)),
      analysis_rows: analysisRows,
      analysis_row_numbers: analysisRowNumbers,
      sampled_row_numbers: sample.rowNumbers,
      sampled_row_reasons: sample.reasons,
      sample_strategy_version: TABLE_SAMPLE_STRATEGY_VERSION,
      sample_seed_hash: sample.seedHash,
      deterministic_inspection: buildDeterministicTableInspection(headers, analysisRows),
      total_row_count: dataRows.length,
      analysis_complete: true,
      formula_cell_count: formulaCellCount,
      formula_cached_value_missing_count: formulaCachedValueMissingCount,
      merged_range_count: detail.sheet['!merges']?.length || 0,
      native_charts: nativeCharts,
      unsupported_objects: archive.unsupportedObjects,
      truncated: dataRows.length > sample.rows.length || sample.rows.some(row => row.some(value => value.length > MAX_CELL_CHARS))
    });
  }
  if (!tables.some(table => table.model_eligible)) throw new Error('XLSX_NO_VISIBLE_NONEMPTY_SHEET');

  const sheets: XlsxSheetManifest[] = sheetDetails.map(item => ({
    sheet_name: item.sheetName,
    visibility: item.visibility,
    source_range: item.range,
    selected: item.visibility === 'visible' && Boolean(item.range),
    reason: item.visibility === 'visible' && Boolean(item.range)
      ? 'SELECTED'
      : !item.range
        ? 'EMPTY'
        : item.visibility !== 'visible'
          ? 'HIDDEN'
          : 'EMPTY'
  }));
  sheets.forEach((sheet, index) => {
    if (sheet.reason === 'HIDDEN') warnings.push(`Workbook sheet ${index + 1} was fully inspected locally but withheld from model context (${sheet.reason}).`);
  });
  const visibleTables = tables.filter(table => table.model_eligible);
  return {
    schema_version: 'xlsx_extraction_v1',
    parser: 'sheetjs_ce',
    parser_version: '0.20.3',
    archive_inspector: 'zipjs',
    archive_inspector_version: '2.8.49',
    text: visibleTables.map(table => renderStructuredTableContext(table, 'XLSX')).join('\n\n'),
    tables,
    native_charts: archive.nativeCharts,
    sheets,
    warnings
  };
};
