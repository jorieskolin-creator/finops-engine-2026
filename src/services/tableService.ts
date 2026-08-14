export interface ParsedDelimitedTable {
  delimiter: ',' | '\t';
  headers: string[];
  /** Complete normalized row population for local deterministic processing. */
  analysisRows: string[][];
  /** Bounded and clipped rows eligible for model context. */
  rows: string[][];
  sampledRowNumbers: number[];
  sampledRowReasons: string[][];
  sampleSeedHash: string;
  rowCount: number;
  clippedCellCount: number;
  cellCharacterCoverageRatio: number;
  warnings: string[];
}

const MAX_RENDERED_ROWS = 150;
const MAX_CELL_CHARS = 240;
const MAX_COLUMNS = 200;
const MAX_ANALYSIS_ROWS = 250_000;
export const TABLE_SAMPLE_STRATEGY_VERSION = 'deterministic_table_sample_v1' as const;

const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const normalizedHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const evidenceField = (value: string): boolean => /^(?:owner|cost_cent(?:er|re)|product|application|app|environment|env|allocation|allocated|tag|tags|label|labels)(?:_|$)/.test(normalizedHeader(value));
const numericValue = (value: string): number | null => {
  const normalized = value.trim().replace(/[A-Z]{3}/gi, '').replace(/[$€£¥,\s]/g, '');
  const signed = /^\(.*\)$/.test(normalized) ? `-${normalized.slice(1, -1)}` : normalized;
  if (!/^-?\d+(?:\.\d+)?$/.test(signed)) return null;
  const parsed = Number(signed);
  return Number.isFinite(parsed) ? parsed : null;
};

const evenlySpaced = (indexes: number[], limit: number): number[] => {
  if (indexes.length <= limit) return indexes;
  if (limit <= 1) return [indexes[0]];
  return Array.from({ length: limit }, (_, position) => indexes[Math.round(position * (indexes.length - 1) / (limit - 1))]);
};

export const selectDeterministicTableSample = (input: {
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
  sourceHash?: string;
  limit?: number;
}): { rows: string[][]; rowNumbers: number[]; reasons: string[][]; seedHash: string } => {
  const { headers, rows, rowNumbers } = input;
  const limit = input.limit || MAX_RENDERED_ROWS;
  if (rows.length !== rowNumbers.length) throw new Error('TABLE_SAMPLE_ROW_LOCATOR_MISMATCH');
  const seedHash = input.sourceHash || `fnv1a_${fnv1a(JSON.stringify({ headers, rows })).toString(16).padStart(8, '0')}`;
  const selected = new Map<number, Set<string>>();
  const add = (index: number, reason: string): void => {
    if (index < 0 || index >= rows.length) return;
    const reasons = selected.get(index) || new Set<string>();
    reasons.add(reason);
    selected.set(index, reasons);
  };
  if (rows.length <= limit) rows.forEach((_, index) => add(index, 'FULL_POPULATION'));
  else {
    for (let index = 0; index < Math.min(10, rows.length); index++) add(index, 'BOUNDARY_FIRST');
    for (let index = Math.max(0, rows.length - 10); index < rows.length; index++) add(index, 'BOUNDARY_LAST');
    evenlySpaced(Array.from({ length: rows.length }, (_, index) => index), 30).forEach(index => add(index, 'FIXED_INTERVAL'));

    const evidenceIndexes = headers.flatMap((header, index) => evidenceField(header) ? [index] : []);
    if (evidenceIndexes.length > 0) {
      const missing = rows.flatMap((row, index) => evidenceIndexes.some(column => !(row[column] || '').trim()) ? [index] : []);
      evenlySpaced(missing, 30).forEach(index => add(index, 'MISSING_RECOGNIZED_FIELD'));
    }

    const firstBySignature = new Map<number, number>();
    const duplicateIndexes: number[] = [];
    rows.forEach((row, index) => {
      const signature = fnv1a(JSON.stringify(row));
      const first = firstBySignature.get(signature);
      if (first === undefined) firstBySignature.set(signature, index);
      else if (JSON.stringify(rows[first]) === JSON.stringify(row)) duplicateIndexes.push(first, index);
    });
    evenlySpaced([...new Set(duplicateIndexes)].sort((a, b) => a - b), 10).forEach(index => add(index, 'EXACT_DUPLICATE_EXAMPLE'));

    const extrema = new Set<number>();
    const numericColumns = headers.flatMap((_, column) =>
      rows.slice(0, 100).some(row => numericValue(row[column] || '') !== null) ? [column] : []
    ).slice(0, 20);
    for (const column of numericColumns) {
      let minimum: { index: number; value: number } | undefined;
      let maximum: { index: number; value: number } | undefined;
      rows.forEach((row, index) => {
        const value = numericValue(row[column] || '');
        if (value === null) return;
        if (!minimum || value < minimum.value) minimum = { index, value };
        if (!maximum || value > maximum.value) maximum = { index, value };
      });
      if (minimum) extrema.add(minimum.index);
      if (maximum) extrema.add(maximum.index);
    }
    evenlySpaced([...extrema].sort((a, b) => a - b), 20).forEach(index => add(index, 'NUMERIC_EXTREME'));

    let state = fnv1a(seedHash) || 1;
    let attempts = 0;
    while (selected.size < limit && attempts < rows.length * 4) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      add((state >>> 0) % rows.length, 'SOURCE_HASH_SEEDED');
      attempts++;
    }
    for (let index = 0; selected.size < limit && index < rows.length; index++) add(index, 'DETERMINISTIC_FILL');
  }
  const indexes = [...selected.keys()].sort((a, b) => a - b).slice(0, limit);
  return {
    rows: indexes.map(index => rows[index]),
    rowNumbers: indexes.map(index => rowNumbers[index]),
    reasons: indexes.map(index => [...selected.get(index)!].sort()),
    seedHash
  };
};

const normalizeAnalysisCell = (value: string): string => value.replace(/\s+/g, ' ').trim();

const normalizeCell = (value: string): { value: string; originalLength: number; retainedLength: number } => {
  const normalized = normalizeAnalysisCell(value);
  return {
    value: normalized.length > MAX_CELL_CHARS ? `${normalized.slice(0, MAX_CELL_CHARS)}...` : normalized,
    originalLength: normalized.length,
    retainedLength: Math.min(normalized.length, MAX_CELL_CHARS)
  };
};

export const parseDelimitedTable = (raw: string, delimiter: ',' | '\t', sourceHash?: string): ParsedDelimitedTable => {
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
  const sample = selectDeterministicTableSample({
    headers: analysisHeaders,
    rows: analysisRows,
    rowNumbers: analysisRows.map((_, index) => index + 2),
    sourceHash
  });
  const renderedRows = sample.rows.map(cells => cells.map(normalizeCell));
  const renderedCells = [...headerCells, ...renderedRows.flat()];
  const originalCharacters = renderedCells.reduce((sum, cell) => sum + cell.originalLength, 0);
  const retainedCharacters = renderedCells.reduce((sum, cell) => sum + cell.retainedLength, 0);
  const clippedCellCount = renderedCells.filter(cell => cell.retainedLength < cell.originalLength).length;
  const warnings: string[] = [];
  if (rowCount > MAX_RENDERED_ROWS) {
    warnings.push(`Table has ${rowCount} data rows; a deterministic bounded sample of ${MAX_RENDERED_ROWS} rows was included for model context.`);
  }
  if (clippedCellCount > 0) warnings.push(`${clippedCellCount} table cell(s) exceeded the per-cell context limit and were truncated.`);

  return {
    delimiter,
    headers: headerCells.map(cell => cell.value),
    analysisRows,
    rows: renderedRows.map(cells => cells.map(cell => cell.value)),
    sampledRowNumbers: sample.rowNumbers,
    sampledRowReasons: sample.reasons,
    sampleSeedHash: sample.seedHash,
    rowCount,
    clippedCellCount,
    cellCharacterCoverageRatio: originalCharacters > 0 ? retainedCharacters / originalCharacters : 1,
    warnings
  };
};

export const renderDelimitedTableForAnalysis = (
  raw: string,
  opts: { fileName: string; delimiter: ',' | '\t'; sourceHash?: string }
): { text: string; warnings: string[]; rowCount: number; renderedRowCount: number; clippedCellCount: number; cellCharacterCoverageRatio: number; structuredTable: import('../types').StructuredTableData } => {
  const table = parseDelimitedTable(raw, opts.delimiter, opts.sourceHash);
  const delimiterLabel = opts.delimiter === '\t' ? 'TSV' : 'CSV';
  const lines = [
    `Format: ${delimiterLabel}`,
    'Source table: browser-local tabular evidence',
    `Rows: ${table.rowCount}`,
    `Columns: ${table.headers.length}`,
    `Sample strategy: ${TABLE_SAMPLE_STRATEGY_VERSION}`,
    'Sample scope: supporting rows for model context only; population metrics are calculated separately from the complete local table.',
    table.headers.length > 0 ? `Headers: ${table.headers.join(' | ')}` : 'Headers: not detected',
    '',
    '[TABLE_SAMPLE]',
    table.headers.join(' | ')
  ];

  for (const [index, row] of table.rows.entries()) {
    lines.push(`[ROW ${table.sampledRowNumbers[index]} reasons=${table.sampledRowReasons[index].join(',')}] ${row.join(' | ')}`);
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
      analysis_row_numbers: table.analysisRows.map((_, index) => index + 2),
      sampled_row_numbers: table.sampledRowNumbers,
      sampled_row_reasons: table.sampledRowReasons,
      sample_strategy_version: TABLE_SAMPLE_STRATEGY_VERSION,
      sample_seed_hash: table.sampleSeedHash,
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
    `Sample strategy: ${table.sample_strategy_version || 'not recorded'}`,
    'Sample scope: supporting rows for model context only; population metrics are calculated separately from the complete local table.',
    table.headers.length > 0 ? `Headers: ${table.headers.join(' | ')}` : 'Headers: not detected',
    '',
    '[TABLE_SAMPLE]',
    table.headers.join(' | ')
  ];
  table.rows.forEach((row, index) => {
    const reasons = table.sampled_row_reasons?.[index]?.join(',') || 'not recorded';
    lines.push(`[ROW ${table.sampled_row_numbers?.[index] || index + 1} reasons=${reasons}] ${row.join(' | ')}`);
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
