export interface ParsedDelimitedTable {
  delimiter: ',' | '\t';
  headers: string[];
  /** Complete normalized row population for local deterministic processing. */
  analysisRows: string[][];
  /** Bounded and clipped rows eligible for model context. */
  rows: string[][];
  rowCount: number;
  clippedCellCount: number;
  cellCharacterCoverageRatio: number;
  warnings: string[];
}

const MAX_RENDERED_ROWS = 150;
const MAX_CELL_CHARS = 240;
const MAX_COLUMNS = 200;
const MAX_ANALYSIS_ROWS = 250_000;

const normalizeAnalysisCell = (value: string): string => value.replace(/\s+/g, ' ').trim();

const normalizeCell = (value: string): { value: string; originalLength: number; retainedLength: number } => {
  const normalized = normalizeAnalysisCell(value);
  return {
    value: normalized.length > MAX_CELL_CHARS ? `${normalized.slice(0, MAX_CELL_CHARS)}...` : normalized,
    originalLength: normalized.length,
    retainedLength: Math.min(normalized.length, MAX_CELL_CHARS)
  };
};

export const parseDelimitedTable = (raw: string, delimiter: ',' | '\t'): ParsedDelimitedTable => {
  let headerRow: string[] | undefined;
  const analysisRows: string[][] = [];
  let rowCount = 0;
  let current = '';
  let row: string[] = [];
  let inQuotes = false;
  let quotedCellClosed = false;
  const commitRow = (): void => {
    if (!row.some(cell => cell.trim().length > 0)) return;
    if (!headerRow) headerRow = row;
    else {
      rowCount++;
      if (rowCount > MAX_ANALYSIS_ROWS) throw new Error('DELIMITED_TABLE_ROW_LIMIT_EXCEEDED');
      analysisRows.push(row.map(normalizeAnalysisCell));
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];

    if (quotedCellClosed && char !== delimiter && char !== '\n' && char !== '\r' && !/\s/.test(char)) {
      throw new Error('INVALID_DELIMITED_TABLE_TRAILING_QUOTED_CONTENT');
    }

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        if (!inQuotes && current.trim().length > 0) throw new Error('INVALID_DELIMITED_TABLE_QUOTE_IN_UNQUOTED_CELL');
        inQuotes = !inQuotes;
        quotedCellClosed = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(current);
      current = '';
      quotedCellClosed = false;
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(current);
      commitRow();
      row = [];
      current = '';
      quotedCellClosed = false;
      continue;
    }

    current += char;
  }

  if (inQuotes) throw new Error('INVALID_DELIMITED_TABLE_UNCLOSED_QUOTE');

  row.push(current);
  commitRow();

  if ((headerRow?.length || 0) > MAX_COLUMNS || analysisRows.some(rowValue => rowValue.length > MAX_COLUMNS)) {
    throw new Error('DELIMITED_TABLE_COLUMN_LIMIT_EXCEEDED');
  }

  const analysisHeaders = (headerRow || []).map(normalizeAnalysisCell);
  const headerCells = analysisHeaders.map(normalizeCell);
  const renderedRows = analysisRows.slice(0, MAX_RENDERED_ROWS).map(cells => cells.map(normalizeCell));
  const renderedCells = [...headerCells, ...renderedRows.flat()];
  const originalCharacters = renderedCells.reduce((sum, cell) => sum + cell.originalLength, 0);
  const retainedCharacters = renderedCells.reduce((sum, cell) => sum + cell.retainedLength, 0);
  const clippedCellCount = renderedCells.filter(cell => cell.retainedLength < cell.originalLength).length;
  const warnings: string[] = [];
  if (rowCount > MAX_RENDERED_ROWS) {
    warnings.push(`Table has ${rowCount} data rows; first ${MAX_RENDERED_ROWS} rows were included for model context.`);
  }
  if (clippedCellCount > 0) warnings.push(`${clippedCellCount} table cell(s) exceeded the per-cell context limit and were truncated.`);

  return {
    delimiter,
    headers: headerCells.map(cell => cell.value),
    analysisRows,
    rows: renderedRows.map(cells => cells.map(cell => cell.value)),
    rowCount,
    clippedCellCount,
    cellCharacterCoverageRatio: originalCharacters > 0 ? retainedCharacters / originalCharacters : 1,
    warnings
  };
};

export const renderDelimitedTableForAnalysis = (
  raw: string,
  opts: { fileName: string; delimiter: ',' | '\t' }
): { text: string; warnings: string[]; rowCount: number; renderedRowCount: number; clippedCellCount: number; cellCharacterCoverageRatio: number; structuredTable: import('../types').StructuredTableData } => {
  const table = parseDelimitedTable(raw, opts.delimiter);
  const delimiterLabel = opts.delimiter === '\t' ? 'TSV' : 'CSV';
  const lines = [
    `Format: ${delimiterLabel}`,
    'Source table: browser-local tabular evidence',
    `Rows: ${table.rowCount}`,
    `Columns: ${table.headers.length}`,
    table.headers.length > 0 ? `Headers: ${table.headers.join(' | ')}` : 'Headers: not detected',
    '',
    '[TABLE_SAMPLE]',
    table.headers.join(' | ')
  ];

  for (const row of table.rows) {
    lines.push(row.join(' | '));
  }

  lines.push('[/TABLE_SAMPLE]');

  return {
    text: lines.join('\n'),
    warnings: table.warnings,
    rowCount: table.rowCount,
    renderedRowCount: table.rows.length,
    clippedCellCount: table.clippedCellCount,
    cellCharacterCoverageRatio: table.cellCharacterCoverageRatio,
    structuredTable: {
      schema_version: 'structured_table_v1',
      headers: table.headers,
      rows: table.rows,
      analysis_rows: table.analysisRows,
      sampled_row_numbers: table.rows.map((_, index) => index + 1),
      total_row_count: table.rowCount,
      analysis_complete: table.analysisRows.length === table.rowCount,
      truncated: table.rowCount > table.rows.length || table.clippedCellCount > 0
    }
  };
};

export const renderStructuredTableContext = (
  table: import('../types').StructuredTableData,
  format: 'XLSX'
): string => {
  const lines = [
    `Format: ${format}`,
    `Sheet: ${table.sheet_name || 'unknown'}`,
    `Range: ${table.source_range || 'unknown'}`,
    `Rows: ${table.total_row_count}`,
    `Columns: ${table.headers.length}`,
    `Formula cells: ${table.formula_cell_count || 0}`,
    `Formula cells missing cached values: ${table.formula_cached_value_missing_count || 0}`,
    table.headers.length > 0 ? `Headers: ${table.headers.join(' | ')}` : 'Headers: not detected',
    '',
    '[TABLE_SAMPLE]',
    table.headers.join(' | ')
  ];
  table.rows.forEach((row, index) => {
    lines.push(`[ROW ${table.sampled_row_numbers?.[index] || index + 1}] ${row.join(' | ')}`);
  });
  lines.push('[/TABLE_SAMPLE]');
  if (table.native_charts?.length) {
    lines.push('', `[NATIVE_CHARTS total="${table.native_charts.length}"]`);
    let remainingPoints = 200;
    for (const chart of table.native_charts.slice(0, 10)) {
      lines.push(`Chart ${chart.chart_id}: type=${chart.chart_type}; title=${chart.title || 'not available'}; part=${chart.chart_part}; extraction=${chart.extraction_status}`);
      for (const [index, series] of chart.series.entries()) {
        const take = Math.min(remainingPoints, 20, Math.max(series.categories.length, series.values.length));
        lines.push(`Series ${index + 1}: name=${series.name || 'not available'}; category_range=${series.category_range || 'not available'}; value_range=${series.value_range || 'not available'}; cached_categories=${JSON.stringify(series.categories.slice(0, take))}; cached_values=${JSON.stringify(series.values.slice(0, take))}`);
        remainingPoints -= take;
        if (remainingPoints === 0) break;
      }
      if (remainingPoints === 0) break;
    }
    lines.push('Native chart context is bounded to 10 charts, 20 points per series and 200 cached points total; full extracted chart caches remain local for deterministic privacy inspection.');
    lines.push('[/NATIVE_CHARTS]');
  }
  return lines.join('\n');
};
