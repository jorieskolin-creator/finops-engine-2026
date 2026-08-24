import type { SourceRecord, StructuredTableData } from '../../types';
import type { CadenceBand } from './banding';
import associationsData from '../../knowledge_base/finops_permitted_associations.json';
import {
  bindingTarget,
  liveThemeBindings,
  type ThemeBinding,
} from './bindings';

export const normalizeHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const matchesHeader = (header: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern =>
    header === pattern
    || header.startsWith(`${pattern}_`)
    || header.endsWith(`_${pattern}`)
    || header.includes(`_${pattern}_`)
  );

export const headerPatternScore = (header: string, pattern: string): number => {
  if (header === pattern) return 1000 + pattern.length;
  if (
    header.startsWith(`${pattern}_`)
    || header.endsWith(`_${pattern}`)
    || header.includes(`_${pattern}_`)
  ) return pattern.length;
  return 0;
};

export const bestHeaderScore = (header: string, patterns: readonly string[]): number =>
  patterns.reduce((max, pattern) => Math.max(max, headerPatternScore(header, pattern)), 0);

export const matchesTheme = (text: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern => new RegExp(pattern).test(text));

export const totalRow = (row: string[]): boolean =>
  row.slice(0, 3).some(value => /^(?:grand\s+)?(?:sub)?total$/i.test(value.trim()));

export const tablesFor = (source: SourceRecord): StructuredTableData[] =>
  source.structured_tables?.filter(table => table.model_eligible)
  || (source.structured_table ? [source.structured_table] : []);

export const analysisRows = (table: StructuredTableData): string[][] => table.analysis_rows || table.rows;

export const tableRowScope = (table: StructuredTableData, rows: string[][]): 'full_table' | 'bounded_prefix' =>
  rows.length < table.total_row_count ? 'bounded_prefix' : 'full_table';

export const tableEligibilityReasons = (table: StructuredTableData, rows: string[][]): string[] => [
  ...(table.analysis_complete === false || rows.length < table.total_row_count ? ['INCOMPLETE_POPULATION'] : []),
  ...((table.hidden_row_count || 0) > 0 || (table.hidden_column_count || 0) > 0 ? ['HIDDEN_SOURCE_STRUCTURE_WITHHELD'] : []),
];

export const locatorFor = (table: StructuredTableData) => ({
  sheet: table.sheet_name,
  range: table.source_range,
  header_row: table.header_row_number,
});

export const COST_PATTERNS = ['cost', 'spend', 'amount', 'net_cost', 'amortized_cost', 'unblended_cost', 'effective_cost'] as const;
export const isCostHeader = (header: string): boolean =>
  (COST_PATTERNS as readonly string[]).includes(header) || /(?:_cost|_spend|_amount)$/.test(header);

export const parseNumber = (value: string | undefined): number | null => {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const percent = /%/.test(trimmed);
  const normalized = trimmed.replace(/%/g, '').replace(/[A-Z]{3}/gi, '').replace(/[$€£¥,\s]/g, '');
  const signed = /^\(.*\)$/.test(normalized) ? `-${normalized.slice(1, -1)}` : normalized;
  if (!/^-?\d+(?:\.\d+)?$/.test(signed)) return null;
  const parsed = Number(signed);
  if (!Number.isFinite(parsed)) return null;
  return percent ? parsed / 100 : parsed;
};

export const parseTime = (value: string | undefined): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const ts = Date.parse(`${trimmed}-01`);
    return Number.isFinite(ts) ? ts : null;
  }
  if (/^\d{4}$/.test(trimmed)) {
    const ts = Date.parse(`${trimmed}-01-01`);
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? ts : null;
};

const TIME_PATTERNS = ['date', 'period', 'month', 'year', 'week', 'timestamp', 'time', 'day'] as const;
const WEIGHT_PATTERNS = ['count', 'quantity', 'rows'] as const;
const ADOPTION_PATTERNS = ['enabled', 'adopted', 'implemented', 'compliant', 'active', 'in_use', 'enforced'] as const;
const STATUS_PATTERNS = ['status', 'state', 'ticket_status', 'item_status'] as const;
const OWNER_PATTERNS = ['owner', 'assignee', 'omistaja'] as const;
const EXCEPTION_PATTERNS = ['exception', 'override', 'incident', 'alert', 'anomaly', 'violation', 'breach', 'poikkeama'] as const;
const ENTITY_PATTERNS = ['resource_id', 'ticket_id', 'item_id', 'id'] as const;
const EVENT_TIME_PATTERNS = ['created', 'opened', 'updated', 'closed_at', 'last_refresh', 'freshness', 'refreshed'] as const;

const TRUTHY = /^(?:true|yes|y|1|enabled|adopted|implemented|compliant|active|on|applied|enforced)$/i;
const FALSY = /^(?:false|no|n|0|disabled|not[_ -]?adopted|inactive|off|missing|absent)$/i;
const CLOSED = /^(?:closed|done|resolved|complete|completed|fixed)$/i;
const OPEN = /^(?:open|todo|in[_ -]?progress|pending|new|wip)$/i;
const EXCEPTION_VALUE = /^(?:exception|override|incident|alert|anomaly|violation|breach|escalated|true|yes|y|1)$/i;

type Target = { stream: 'maturity' | 'antipattern'; criterion_id: string };

export interface NumericSeries {
  name: string;
  semantic: 'ratio' | 'count' | 'duration';
  higherIs: 'better' | 'worse';
  targets: Target[];
  points: number[];
  binding_id?: string;
}

const firstMatchingBinding = (
  header: string,
  bindings: ThemeBinding[],
  patternsOf: (binding: ThemeBinding) => readonly string[] | undefined,
): ThemeBinding | undefined =>
  bindings.find(binding => {
    const patterns = patternsOf(binding);
    return patterns ? matchesHeader(header, patterns) : false;
  });

const orderedRows = (table: StructuredTableData): string[][] => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const timeIndexes = headers.flatMap((header, index) => matchesHeader(header, TIME_PATTERNS) ? [index] : []);
  if (timeIndexes.length !== 1) return rows;
  const timeIndex = timeIndexes[0];
  return [...rows].sort((a, b) => (parseTime(a[timeIndex]) ?? 0) - (parseTime(b[timeIndex]) ?? 0));
};

export const detectTrendSeries = (table: StructuredTableData): NumericSeries | null => {
  const rows = orderedRows(table);
  const headers = table.headers.map(normalizeHeader);
  const trendBindings = liveThemeBindings('trend_v1');

  for (const binding of trendBindings) {
    if (binding.detection !== 'paired_ratio') continue;
    const leftIdx = headers.findIndex(header => matchesHeader(header, binding.left_patterns || []));
    const rightIdx = headers.findIndex(header => matchesHeader(header, binding.right_patterns || []));
    if (leftIdx < 0 || rightIdx < 0 || leftIdx === rightIdx) continue;
    const points = rows.flatMap(row => {
      const left = parseNumber(row[leftIdx]);
      const right = parseNumber(row[rightIdx]);
      if (left === null || right === null || left === 0) return [];
      return [(right - left) / Math.abs(left)];
    });
    if (points.length === 0) return null;
    return {
      name: binding.series_name || binding.theme.toLowerCase(),
      semantic: binding.semantic_type || 'ratio',
      higherIs: binding.higher_is || 'worse',
      targets: [bindingTarget(binding)],
      points,
      binding_id: binding.binding_id,
    };
  }

  let best: { binding: ThemeBinding; index: number; score: number } | undefined;
  for (const binding of trendBindings) {
    if (binding.detection !== 'numeric_series') continue;
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (!binding.allow_cost_header && isCostHeader(header)) continue;
      const score = bestHeaderScore(header, binding.header_patterns);
      if (score > 0 && (!best || score > best.score)) {
        best = { binding, index, score };
      }
    }
  }
  if (!best) return null;
  const selected = best;
  const points = rows
    .map(row => parseNumber(row[selected.index]))
    .filter((value): value is number => value !== null && (!selected.binding.non_negative || value >= 0));
  if (points.length === 0) return null;
  return {
    name: selected.binding.series_name || selected.binding.theme.toLowerCase(),
    semantic: selected.binding.semantic_type || 'ratio',
    higherIs: selected.binding.higher_is || 'worse',
    targets: [bindingTarget(selected.binding)],
    points,
    binding_id: selected.binding.binding_id,
  };
};

export const detectConcentration = (table: StructuredTableData): {
  weights: number[];
  eligible: number;
  targets: Target[];
  binding_id: string;
  theme: string;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const bindings = liveThemeBindings('concentration_v1');
  let segmentIdx = -1;
  let binding: ThemeBinding | undefined;
  for (let index = 0; index < headers.length; index += 1) {
    binding = firstMatchingBinding(headers[index], bindings, item => item.header_patterns);
    if (binding) {
      segmentIdx = index;
      break;
    }
  }
  if (segmentIdx < 0 || !binding) return null;
  const weightIdx = headers.findIndex(header => isCostHeader(header) || matchesHeader(header, WEIGHT_PATTERNS));
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = (row[segmentIdx] || '').trim().toLowerCase();
    if (!key) continue;
    const weight = weightIdx >= 0 ? parseNumber(row[weightIdx]) : 1;
    if (weight === null || weight < 0) continue;
    groups.set(key, (groups.get(key) || 0) + weight);
  }
  if (groups.size < 3) return null;
  return {
    weights: [...groups.values()],
    eligible: rows.length,
    targets: [bindingTarget(binding)],
    binding_id: binding.binding_id,
    theme: binding.theme,
  };
};

export const encodeFlagOrNumber = (value: string | undefined): number | null => {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (TRUTHY.test(trimmed)) return 1;
  if (FALSY.test(trimmed)) return 0;
  return parseNumber(trimmed);
};

const GENERIC_PROCESS = /^(?:status|state)$/;
const isGenericProcess = (binding: ThemeBinding): boolean =>
  (binding.theme_patterns || binding.header_patterns).every(pattern => GENERIC_PROCESS.test(pattern));

export const detectAdoption = (table: StructuredTableData): {
  percent: number;
  present: boolean;
  eligible: number;
  targets: Target[];
  binding_id?: string;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  if (rows.length === 0) return null;
  const adoptionBindings = liveThemeBindings('adoption_v1');
  let index = headers.findIndex(header => matchesHeader(header, ADOPTION_PATTERNS));
  let binding: ThemeBinding | undefined;
  if (index >= 0) {
    binding = adoptionBindings.find(item =>
      matchesTheme(headers[index], item.theme_patterns || item.header_patterns)
    );
  }
  if (!binding) {
    for (const item of adoptionBindings) {
      if (item.phase === 'F0') continue;
      const idx = headers.findIndex(header => matchesHeader(header, item.header_patterns));
      if (idx < 0) continue;
      index = idx;
      binding = item;
      break;
    }
  }
  if (index < 0 || !binding) return null;
  let present = 0;
  let classified = 0;
  for (const row of rows) {
    const value = (row[index] || '').trim();
    if (TRUTHY.test(value)) { present += 1; classified += 1; }
    else if (FALSY.test(value)) classified += 1;
  }
  if (classified === 0) return null;
  return {
    percent: Math.round((present / rows.length) * 100),
    present: present > 0,
    eligible: rows.length,
    targets: [bindingTarget(binding)],
    binding_id: binding.binding_id,
  };
};

export const detectProcess = (table: StructuredTableData): {
  targets: Target[];
  eligible: number;
  closed: number;
  ownerless: number | null;
  timestamps: number[];
  openAges: number[];
  recurrence: boolean;
  binding_id?: string;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const processBindings = liveThemeBindings('process_v1');
  const statusIdx = headers.findIndex(header => matchesHeader(header, STATUS_PATTERNS));
  let timeIdx = headers.findIndex(header =>
    matchesHeader(header, TIME_PATTERNS) || matchesHeader(header, EVENT_TIME_PATTERNS)
  );
  const ownerlessBinding = processBindings.find(item => item.binding_id === 'E2.ownerless.process');
  const ownerlessFlagIdx = ownerlessBinding
    ? headers.findIndex(header => matchesHeader(header, ownerlessBinding.header_patterns))
    : -1;
  let forcedBinding: ThemeBinding | undefined;
  if (statusIdx < 0 && timeIdx < 0) {
    for (const item of processBindings) {
      if (item.phase !== 'F2') continue;
      const idx = headers.findIndex(header => matchesHeader(header, item.header_patterns));
      if (idx < 0) continue;
      const timeHits = rows.filter(row => parseTime(row[idx]) !== null).length;
      if (timeHits > 0) timeIdx = idx;
      forcedBinding = item;
      break;
    }
  }
  if (statusIdx < 0 && timeIdx < 0 && ownerlessFlagIdx < 0) return null;
  const joined = headers.join(' ');
  const processMatches = processBindings.filter(item =>
    matchesTheme(joined, item.theme_patterns || item.header_patterns)
  );
  const binding = forcedBinding
    || processMatches.find(item => !isGenericProcess(item))
    || processMatches[0];
  if (!binding) return null;
  const ownerIdx = headers.findIndex(header => matchesHeader(header, OWNER_PATTERNS));
  const entityIdx = headers.findIndex(header => matchesHeader(header, ENTITY_PATTERNS));
  let closed = 0;
  let ownerless = 0;
  const timestamps: number[] = [];
  const openTimes: number[] = [];
  const openKeys = new Map<string, number>();
  for (const row of rows) {
    const status = (row[statusIdx] || '').trim();
    if (CLOSED.test(status)) closed += 1;
    if (ownerlessFlagIdx >= 0) {
      if (TRUTHY.test((row[ownerlessFlagIdx] || '').trim())) ownerless += 1;
    } else if (ownerIdx >= 0 && !(row[ownerIdx] || '').trim()) {
      ownerless += 1;
    }
    const ts = timeIdx >= 0 ? parseTime(row[timeIdx]) : null;
    if (ts !== null) {
      timestamps.push(ts);
      if (statusIdx < 0 || OPEN.test(status) || !status) openTimes.push(ts);
    }
    if (entityIdx >= 0 && (statusIdx < 0 || OPEN.test(status))) {
      const key = (row[entityIdx] || '').trim().toLowerCase();
      if (key) openKeys.set(key, (openKeys.get(key) || 0) + 1);
    }
  }
  const asOf = timestamps.length ? Math.max(...timestamps) : null;
  const openAges = asOf === null ? [] : openTimes.map(ts => (asOf - ts) / 86400000);
  return {
    targets: [bindingTarget(binding)],
    eligible: rows.length,
    closed,
    ownerless: ownerlessFlagIdx >= 0 || ownerIdx >= 0 ? ownerless : null,
    timestamps: timestamps.sort((a, b) => a - b),
    openAges,
    recurrence: [...openKeys.values()].some(count => count > 1),
    binding_id: binding.binding_id,
  };
};

export const detectException = (table: StructuredTableData): {
  targets: Target[];
  eligible: number;
  exceptionCount: number;
  recurrence: boolean;
  openAges: number[];
  closed: number | null;
  binding_id?: string;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  if (rows.length === 0) return null;
  const exceptionBindings = liveThemeBindings('exception_v1');
  let exceptionIdx = headers.findIndex(header => matchesHeader(header, EXCEPTION_PATTERNS));
  let binding: ThemeBinding | undefined;
  if (exceptionIdx >= 0) {
    const column = headers[exceptionIdx];
    const joined = `${headers.join(' ')} ${column}`;
    binding = exceptionBindings.find(item => {
      const patterns = item.theme_patterns || item.header_patterns;
      const haystack = item.match_scope === 'headers_joined' ? joined : column;
      return matchesTheme(haystack, patterns);
    });
  }
  if (!binding) {
    for (const item of exceptionBindings) {
      if (item.phase === 'F0' || item.match_scope === 'headers_joined') continue;
      const idx = headers.findIndex(header => matchesHeader(header, item.header_patterns));
      if (idx < 0) continue;
      exceptionIdx = idx;
      binding = item;
      break;
    }
  }
  if (exceptionIdx < 0 || !binding) return null;
  const statusIdx = headers.findIndex(header => matchesHeader(header, STATUS_PATTERNS));
  const timeIdx = headers.findIndex(header =>
    matchesHeader(header, TIME_PATTERNS) || matchesHeader(header, EVENT_TIME_PATTERNS)
  );
  const entityIdx = headers.findIndex(header => matchesHeader(header, ENTITY_PATTERNS));
  let exceptionCount = 0;
  let closed = 0;
  let classifiedClosed = 0;
  const exceptionTimes: number[] = [];
  const openTimes: number[] = [];
  const allTimes: number[] = [];
  const keys = new Map<string, number>();
  for (const row of rows) {
    const raw = (row[exceptionIdx] || '').trim();
    const flagged = EXCEPTION_VALUE.test(raw) || TRUTHY.test(raw);
    const ts = timeIdx >= 0 ? parseTime(row[timeIdx]) : null;
    if (ts !== null) allTimes.push(ts);
    if (!flagged) continue;
    exceptionCount += 1;
    if (entityIdx >= 0) {
      const key = (row[entityIdx] || '').trim().toLowerCase();
      if (key) keys.set(key, (keys.get(key) || 0) + 1);
    }
    if (ts !== null) exceptionTimes.push(ts);
    if (statusIdx >= 0) {
      const status = (row[statusIdx] || '').trim();
      if (CLOSED.test(status)) { closed += 1; classifiedClosed += 1; }
      else if (OPEN.test(status)) classifiedClosed += 1;
      if (OPEN.test(status) && ts !== null) openTimes.push(ts);
    } else if (ts !== null) {
      openTimes.push(ts);
    }
  }
  const asOf = allTimes.length ? Math.max(...allTimes) : (exceptionTimes.length ? Math.max(...exceptionTimes) : null);
  const ages = asOf === null ? [] : openTimes.map(ts => (asOf - ts) / 86400000);
  return {
    targets: [bindingTarget(binding)],
    eligible: rows.length,
    exceptionCount,
    recurrence: [...keys.values()].some(count => count > 1),
    openAges: ages,
    closed: classifiedClosed > 0 ? closed : null,
    binding_id: binding.binding_id,
  };
};

type AssociationPair = {
  pair_id: string;
  left_patterns: string[];
  right_patterns: string[];
  min_observations: number;
  targets: Target[];
};

const ASSOCIATION_PAIRS = (associationsData.pairs || []) as AssociationPair[];
const liveAssociationPairIds = new Set(
  liveThemeBindings('association_v1').map(binding => binding.pair_id).filter((id): id is string => Boolean(id))
);

const exactLiveHeader = (header: string): boolean =>
  liveThemeBindings().some(binding => binding.header_patterns.includes(header));

const matchesPairSide = (header: string, patterns: readonly string[]): boolean => {
  if (patterns.includes(header)) return true;
  if (exactLiveHeader(header)) return false;
  return matchesHeader(header, patterns);
};

export const detectAssociationPairs = (table: StructuredTableData): Array<{
  pair_id: string;
  targets: Target[];
  min_observations: number;
  left: number[];
  right: number[];
}> => {
  const rows = orderedRows(table);
  const headers = table.headers.map(normalizeHeader);
  return ASSOCIATION_PAIRS.flatMap(pair => {
    if (liveAssociationPairIds.size > 0 && !liveAssociationPairIds.has(pair.pair_id)) return [];
    const leftIdx = headers.findIndex(header => matchesPairSide(header, pair.left_patterns));
    const rightIdx = headers.findIndex(header => matchesPairSide(header, pair.right_patterns));
    if (leftIdx < 0 || rightIdx < 0 || leftIdx === rightIdx) return [];
    const left: number[] = [];
    const right: number[] = [];
    for (const row of rows) {
      const a = encodeFlagOrNumber(row[leftIdx]);
      const b = encodeFlagOrNumber(row[rightIdx]);
      if (a === null || b === null) continue;
      left.push(a);
      right.push(b);
    }
    if (left.length === 0) return [];
    return [{ pair_id: pair.pair_id, targets: pair.targets, min_observations: pair.min_observations, left, right }];
  });
};

const CADENCE_PATTERNS: Array<{ cadence: CadenceBand; re: RegExp }> = [
  { cadence: 'WEEKLY', re: /\b(?:weekly|every\s+week|viikoittain)\b/gi },
  { cadence: 'MONTHLY', re: /\b(?:monthly|every\s+month|month-end|kuukausittain)\b/gi },
  { cadence: 'QUARTERLY', re: /\b(?:quarterly|every\s+quarter|qbr|neljannesvuosittain)\b/gi },
];

export const corpusHaystack = (sources: SourceRecord[]): string => sources.map(source => [
  source.text || '',
  ...(source.pages || []).map(page => page.text),
  ...(source.structured_tables || []).flatMap(table => table.headers),
  ...(source.structured_table ? source.structured_table.headers : []),
].join(' ')).join(' ').toLowerCase();

export const detectDeclaredCadences = (sources: SourceRecord[]): Array<{ criterion_id: string; cadence: CadenceBand }> => {
  const haystack = corpusHaystack(sources);
  const cadenceBindings = liveThemeBindings('consistency_v1').filter(item => item.detection === 'declared_cadence');
  const found: Array<{ criterion_id: string; cadence: CadenceBand }> = [];
  for (const { cadence, re } of CADENCE_PATTERNS) {
    const copy = new RegExp(re.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = copy.exec(haystack))) {
      const context = haystack.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
      const binding = cadenceBindings.find(item =>
        matchesTheme(context, item.theme_patterns || item.header_patterns)
      );
      if (binding) found.push({ criterion_id: binding.criterion_id, cadence });
    }
  }
  const unique = new Map<string, Set<CadenceBand>>();
  for (const item of found) {
    const set = unique.get(item.criterion_id) || new Set<CadenceBand>();
    set.add(item.cadence);
    unique.set(item.criterion_id, set);
  }
  return [...unique.entries()].flatMap(([criterion_id, cadences]) =>
    cadences.size === 1 ? [{ criterion_id, cadence: [...cadences][0] }] : []
  );
};
