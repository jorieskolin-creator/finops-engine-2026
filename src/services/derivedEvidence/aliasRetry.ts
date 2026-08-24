import type { SourceRecord, StructuredTableData } from '../../types';
import aliasData from '../../knowledge_base/finops_term_aliases.json';
import { liveThemeBindings } from './bindings';
import {
  FALSY,
  TRUTHY,
  analysisRows,
  headerIsRecognised,
  matchesHeader,
  normalizeHeader,
  parseNumber,
  parseTime,
  totalRow,
} from './shape';

export const MAX_COLUMN_ALIAS_RETRY = 2;

export const CANONICAL_BY_CONCEPT: Record<string, string> = Object.freeze({
  tagging: 'tag',
  allocation: 'allocated',
  forecast: 'forecast',
  budget: 'budget',
  commitment: 'commitment',
  rightsizing: 'rightsiz',
  anomaly: 'anomaly',
  ownership: 'owner',
  unit: 'unit_cost',
  autoscaling: 'autoscale',
  showback: 'showback',
  utilization: 'utilization',
  waste: 'idle',
  guardrail: 'guardrail',
});

const CONCEPT_ALIASES = aliasData.concepts as Record<string, string[]>;

export type ColumnKind = 'numeric' | 'flag' | 'time' | 'label';
export type ColumnAliasSubstitution = { from: string; to: string };

const detectionsForCanonical = (canonical: string): string[] =>
  liveThemeBindings()
    .filter(binding =>
      matchesHeader(canonical, binding.header_patterns)
      || (binding.left_patterns ? matchesHeader(canonical, binding.left_patterns) : false)
      || (binding.right_patterns ? matchesHeader(canonical, binding.right_patterns) : false)
    )
    .map(binding => binding.detection);

const compatible = (kind: ColumnKind, detections: readonly string[]): boolean => {
  if (kind === 'numeric') {
    return detections.some(detection =>
      detection === 'numeric_series' || detection === 'paired_ratio' || detection === 'association_pair'
    );
  }
  if (kind === 'flag') {
    return detections.some(detection =>
      detection === 'adoption_flag' || detection === 'exception_flag' || detection === 'process_records'
    );
  }
  if (kind === 'time') return detections.includes('process_records');
  return detections.some(detection => detection === 'segment_weights' || detection === 'process_records');
};

export const columnKind = (rows: string[][], index: number): ColumnKind => {
  let nonempty = 0;
  let numeric = 0;
  let flag = 0;
  let time = 0;
  for (const row of rows) {
    const value = (row[index] || '').trim();
    if (!value) continue;
    nonempty += 1;
    if (TRUTHY.test(value) || FALSY.test(value)) flag += 1;
    else if (parseTime(value) !== null && Number.isNaN(Number(value))) time += 1;
    else if (parseNumber(value) !== null) numeric += 1;
  }
  if (nonempty === 0) return 'label';
  if (time / nonempty >= 0.5) return 'time';
  if (flag / nonempty >= 0.5) return 'flag';
  if (numeric / nonempty >= 0.5) return 'numeric';
  return 'label';
};

export const resolveColumnAlias = (header: string, kind: ColumnKind): string | null => {
  const normalized = normalizeHeader(header);
  if (!normalized || headerIsRecognised(normalized)) return null;

  for (const binding of liveThemeBindings()) {
    for (const alias of binding.aliases || []) {
      if (normalizeHeader(alias) !== normalized) continue;
      const to = binding.header_patterns[0];
      if (to && compatible(kind, [binding.detection])) return to;
    }
  }

  for (const [concept, aliases] of Object.entries(CONCEPT_ALIASES)) {
    const hit = normalizeHeader(concept) === normalized
      || aliases.some(alias => normalizeHeader(alias) === normalized);
    if (!hit) continue;
    const to = CANONICAL_BY_CONCEPT[concept];
    if (!to) continue;
    if (compatible(kind, detectionsForCanonical(to))) return to;
  }
  return null;
};

export const applyColumnAliasRetry = (
  table: StructuredTableData,
): { table: StructuredTableData; substitutions: ColumnAliasSubstitution[] } | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const substitutions: ColumnAliasSubstitution[] = [];
  const headers = table.headers.map((header, index) => {
    if (substitutions.length >= MAX_COLUMN_ALIAS_RETRY) return header;
    const resolved = resolveColumnAlias(header, columnKind(rows, index));
    if (!resolved || normalizeHeader(resolved) === normalizeHeader(header)) return header;
    substitutions.push({ from: header, to: resolved });
    return resolved;
  });
  if (substitutions.length === 0) return null;
  return { table: { ...table, headers }, substitutions };
};

export const aliasRetrySource = (source: SourceRecord): SourceRecord | null => {
  let changed = false;
  const rewrite = (table?: StructuredTableData): StructuredTableData | undefined => {
    if (!table) return table;
    const aliased = applyColumnAliasRetry(table);
    if (!aliased) return table;
    changed = true;
    return aliased.table;
  };
  const next: SourceRecord = {
    ...source,
    structured_table: rewrite(source.structured_table),
    structured_tables: source.structured_tables?.map(table => rewrite(table) || table),
  };
  return changed ? next : null;
};
