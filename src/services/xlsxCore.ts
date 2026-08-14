import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import * as XLSX from 'xlsx';
import type { StructuredTableData } from '../types';
import { renderStructuredTableContext } from './tableService';

const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_SHEETS = 20;
const MAX_ROWS = 250_000;
const MAX_COLUMNS = 200;
const MAX_CONTEXT_ROWS = 150;
const MAX_CELL_CHARS = 240;

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
  table: StructuredTableData;
  sheets: XlsxSheetManifest[];
  warnings: string[];
}

const blockedEntry = (name: string): string | null => {
  const normalized = name.toLowerCase();
  if (/vbaproject|\.bin$/.test(normalized)) return 'XLSX_ACTIVE_CONTENT_REJECTED';
  if (/^xl\/(?:embeddings|oleobjects)\//.test(normalized)) return 'XLSX_EMBEDDED_OBJECT_REJECTED';
  if (/^xl\/externallinks\//.test(normalized)) return 'XLSX_EXTERNAL_LINK_REJECTED';
  return null;
};

export const inspectXlsxArchive = async (bytes: Uint8Array): Promise<{ unsupportedObjects: string[] }> => {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    const entries = await reader.getEntries();
    if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('XLSX_ARCHIVE_ENTRY_LIMIT_EXCEEDED');
    const names = new Set(entries.map(entry => entry.filename));
    if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('XLSX_STRUCTURE_INVALID');
    let totalUncompressed = 0;
    const unsupportedObjects = new Set<string>();
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
      if (/^xl\/charts\//.test(normalized)) unsupportedObjects.add('NATIVE_CHART_REQUIRES_EXTRACTION');
      if (/^xl\/media\//.test(normalized)) unsupportedObjects.add('WORKBOOK_IMAGE_REQUIRES_VISUAL_INSPECTION');
      if (/^xl\/(?:comments|threadedcomments)\//.test(normalized)) unsupportedObjects.add('CELL_COMMENTS_NOT_INSPECTED');
    }
    return { unsupportedObjects: [...unsupportedObjects].sort() };
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

export const parseXlsxBytes = async (bytes: Uint8Array): Promise<XlsxExtractionResult> => {
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
    return { sheetName, sheet, visibility, range: sheet['!ref'] };
  });
  const selected = sheetDetails.find(item => item.visibility === 'visible' && Boolean(item.range));
  if (!selected?.range) throw new Error('XLSX_NO_VISIBLE_NONEMPTY_SHEET');
  if (sheetDetails.some(item => item.sheetName !== selected.sheetName && Boolean(item.range))) {
    // Until every worksheet becomes its own fully scanned ContentUnit, allowing
    // another non-empty sheet would violate complete-source privacy inspection.
    throw new Error('XLSX_MULTISHEET_ANALYSIS_NOT_IMPLEMENTED');
  }

  const range = XLSX.utils.decode_range(selected.range);
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
      const cell = selected.sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
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
  if (headerRow < 0 || physicalRows.length === 0) throw new Error('XLSX_SELECTED_SHEET_EMPTY');

  const headers = uniqueHeaders(physicalRows[0].values, range.s.c);
  const dataRows = physicalRows.slice(1);
  const analysisRows = dataRows.map(row => row.values);
  const analysisRowNumbers = dataRows.map(row => row.rowNumber);
  const sampled = dataRows.slice(0, MAX_CONTEXT_ROWS);
  const warnings: string[] = [];
  if (dataRows.length > MAX_CONTEXT_ROWS) warnings.push(`Selected sheet has ${dataRows.length} data rows; first ${MAX_CONTEXT_ROWS} rows were included for model context.`);
  if (formulaCellCount > 0) warnings.push(`${formulaCellCount} formula cell(s) were recorded from cached values; formulas were not executed.`);
  if (formulaCachedValueMissingCount > 0) warnings.push(`${formulaCachedValueMissingCount} formula cell(s) had no cached value and were treated as empty.`);
  warnings.push(...archive.unsupportedObjects.map(code => `Unsupported workbook object: ${code}.`));

  const sheets: XlsxSheetManifest[] = sheetDetails.map(item => ({
    sheet_name: item.sheetName,
    visibility: item.visibility,
    source_range: item.range,
    selected: item.sheetName === selected.sheetName,
    reason: item.sheetName === selected.sheetName
      ? 'SELECTED'
      : item.visibility !== 'visible'
        ? 'HIDDEN'
        : !item.range
          ? 'EMPTY'
          : 'ADDITIONAL_VISIBLE_SHEET'
  }));
  for (const sheet of sheets.filter(item => !item.selected)) warnings.push(`Sheet "${sheet.sheet_name}" was not analyzed (${sheet.reason}).`);

  const table: StructuredTableData = {
    schema_version: 'structured_table_v1',
    sheet_name: selected.sheetName,
    sheet_visibility: selected.visibility,
    source_range: selected.range,
    header_row_number: headerRow + 1,
    headers,
    rows: sampled.map(row => row.values.map(boundedCell)),
    analysis_rows: analysisRows,
    analysis_row_numbers: analysisRowNumbers,
    sampled_row_numbers: sampled.map(row => row.rowNumber),
    total_row_count: dataRows.length,
    analysis_complete: true,
    formula_cell_count: formulaCellCount,
    formula_cached_value_missing_count: formulaCachedValueMissingCount,
    merged_range_count: selected.sheet['!merges']?.length || 0,
    unsupported_objects: archive.unsupportedObjects,
    truncated: dataRows.length > MAX_CONTEXT_ROWS || sampled.some(row => row.values.some(value => value.length > MAX_CELL_CHARS))
  };
  return {
    schema_version: 'xlsx_extraction_v1',
    parser: 'sheetjs_ce',
    parser_version: '0.20.3',
    archive_inspector: 'zipjs',
    archive_inspector_version: '2.8.49',
    text: renderStructuredTableContext(table, 'XLSX'),
    table,
    sheets,
    warnings
  };
};
