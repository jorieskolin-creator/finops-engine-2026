export interface ParsedDelimitedTable {
  delimiter: ',' | '\t';
  headers: string[];
  rows: string[][];
  rowCount: number;
  clippedCellCount: number;
  cellCharacterCoverageRatio: number;
  warnings: string[];
}

const MAX_RENDERED_ROWS = 150;
const MAX_CELL_CHARS = 240;

const normalizeCell = (value: string): { value: string; originalLength: number; retainedLength: number } => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return {
    value: normalized.length > MAX_CELL_CHARS ? `${normalized.slice(0, MAX_CELL_CHARS)}...` : normalized,
    originalLength: normalized.length,
    retainedLength: Math.min(normalized.length, MAX_CELL_CHARS)
  };
};

export const parseDelimitedTable = (raw: string, delimiter: ',' | '\t'): ParsedDelimitedTable => {
  let headerRow: string[] | undefined;
  const retainedRows: string[][] = [];
  let rowCount = 0;
  let current = '';
  let row: string[] = [];
  let inQuotes = false;
  const commitRow = (): void => {
    if (!row.some(cell => cell.trim().length > 0)) return;
    if (!headerRow) headerRow = row;
    else {
      rowCount++;
      if (retainedRows.length < MAX_RENDERED_ROWS) retainedRows.push(row);
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const next = raw[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(current);
      commitRow();
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  row.push(current);
  commitRow();

  const headerCells = (headerRow || []).map(normalizeCell);
  const renderedRows = retainedRows.map(cells => cells.map(normalizeCell));
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
  const structuredHeaders = table.headers.slice(0, 200);
  const structuredRows = table.rows.map(row => row.slice(0, 200));
  const structuredColumnTruncated = table.headers.length > structuredHeaders.length || table.rows.some(row => row.length > 200);
  const delimiterLabel = opts.delimiter === '\t' ? 'TSV' : 'CSV';
  const lines = [
    `Format: ${delimiterLabel}`,
    `Source table: ${opts.fileName}`,
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
      headers: structuredHeaders,
      rows: structuredRows,
      total_row_count: table.rowCount,
      truncated: table.rowCount > table.rows.length || table.clippedCellCount > 0 || structuredColumnTruncated
    }
  };
};
