export interface ParsedDelimitedTable {
  delimiter: ',' | '\t';
  headers: string[];
  rows: string[][];
  rowCount: number;
  warnings: string[];
}

const MAX_RENDERED_ROWS = 150;
const MAX_CELL_CHARS = 240;

const normalizeCell = (value: string): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_CELL_CHARS
    ? `${normalized.slice(0, MAX_CELL_CHARS)}...`
    : normalized;
};

export const parseDelimitedTable = (raw: string, delimiter: ',' | '\t'): ParsedDelimitedTable => {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

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
      if (row.some(cell => cell.trim().length > 0)) rows.push(row);
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.some(cell => cell.trim().length > 0)) rows.push(row);

  const headers = (rows.shift() || []).map(normalizeCell);
  const warnings: string[] = [];
  if (rows.length > MAX_RENDERED_ROWS) {
    warnings.push(`Table has ${rows.length} data rows; first ${MAX_RENDERED_ROWS} rows were included for model context.`);
  }

  return {
    delimiter,
    headers,
    rows: rows.slice(0, MAX_RENDERED_ROWS).map(cells => cells.map(normalizeCell)),
    rowCount: rows.length,
    warnings
  };
};

export const renderDelimitedTableForAnalysis = (
  raw: string,
  opts: { fileName: string; delimiter: ',' | '\t' }
): { text: string; warnings: string[] } => {
  const table = parseDelimitedTable(raw, opts.delimiter);
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
    warnings: table.warnings
  };
};
