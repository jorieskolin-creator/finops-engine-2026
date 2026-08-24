import type { SourceRecord, StructuredTableData } from '../../types';
import type { CadenceBand } from './banding';
import associationsData from '../../knowledge_base/finops_permitted_associations.json';

export const normalizeHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const matchesHeader = (header: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern =>
    header === pattern
    || header.startsWith(`${pattern}_`)
    || header.endsWith(`_${pattern}`)
    || header.includes(`_${pattern}_`)
  );

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
const FORECAST_PATTERNS = ['forecast', 'ennuste'] as const;
const ACTUAL_PATTERNS = ['actual', 'actuals', 'realized'] as const;

type Target = { stream: 'maturity' | 'antipattern'; criterion_id: string };

export interface NumericSeries {
  name: string;
  semantic: 'ratio' | 'count' | 'duration';
  higherIs: 'better' | 'worse';
  targets: Target[];
  points: number[];
}

const RATIO_HINTS: Array<{ patterns: string[]; higherIs: 'better' | 'worse'; targets: Target[]; name: string }> = [
  { patterns: ['variance', 'budjettipoikkeama'], higherIs: 'worse', targets: [{ stream: 'maturity', criterion_id: 'C2' }], name: 'forecast_variance' },
  { patterns: ['utilization', 'utilisation', 'kayttoaste'], higherIs: 'better', targets: [{ stream: 'maturity', criterion_id: 'B1' }], name: 'commitment_utilization' },
  { patterns: ['idle', 'waste'], higherIs: 'worse', targets: [{ stream: 'maturity', criterion_id: 'B3' }], name: 'idle_waste' },
  { patterns: ['coverage'], higherIs: 'better', targets: [{ stream: 'maturity', criterion_id: 'B1' }], name: 'commitment_coverage' },
];

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
  const forecastIdx = headers.findIndex(header => matchesHeader(header, FORECAST_PATTERNS));
  const actualIdx = headers.findIndex(header => matchesHeader(header, ACTUAL_PATTERNS));
  if (forecastIdx >= 0 && actualIdx >= 0 && forecastIdx !== actualIdx) {
    const points = rows.flatMap(row => {
      const forecast = parseNumber(row[forecastIdx]);
      const actual = parseNumber(row[actualIdx]);
      if (forecast === null || actual === null || forecast === 0) return [];
      return [(actual - forecast) / Math.abs(forecast)];
    });
    if (points.length === 0) return null;
    return {
      name: 'forecast_variance',
      semantic: 'ratio',
      higherIs: 'worse',
      targets: [{ stream: 'maturity', criterion_id: 'C2' }],
      points,
    };
  }
  for (const hint of RATIO_HINTS) {
    const index = headers.findIndex(header => matchesHeader(header, hint.patterns) && !isCostHeader(header));
    if (index < 0) continue;
    const points = rows.map(row => parseNumber(row[index])).filter((value): value is number => value !== null);
    if (points.length === 0) continue;
    return { name: hint.name, semantic: 'ratio', higherIs: hint.higherIs, targets: hint.targets, points };
  }
  const durationIdx = headers.findIndex(header => matchesHeader(header, ['aging_days', 'age_days', 'mttr', 'duration_days']));
  if (durationIdx >= 0) {
    const points = rows.map(row => parseNumber(row[durationIdx])).filter((value): value is number => value !== null && value >= 0);
    if (points.length > 0) {
      return {
        name: 'duration',
        semantic: 'duration',
        higherIs: 'worse',
        targets: [{ stream: 'maturity', criterion_id: 'C3' }],
        points,
      };
    }
  }
  return null;
};

const SEGMENT_PATTERNS = ['environment', 'env', 'product', 'application', 'app', 'service', 'region', 'storage_class', 'instance_family', 'model', 'workload_type'];

export const detectConcentration = (table: StructuredTableData): { weights: number[]; eligible: number } | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const segmentIdx = headers.findIndex(header => matchesHeader(header, SEGMENT_PATTERNS));
  if (segmentIdx < 0) return null;
  const weightIdx = headers.findIndex(header => isCostHeader(header) || matchesHeader(header, ['count', 'quantity', 'rows']));
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = (row[segmentIdx] || '').trim().toLowerCase();
    if (!key) continue;
    const weight = weightIdx >= 0 ? parseNumber(row[weightIdx]) : 1;
    if (weight === null || weight < 0) continue;
    groups.set(key, (groups.get(key) || 0) + weight);
  }
  if (groups.size < 3) return null;
  return { weights: [...groups.values()], eligible: rows.length };
};

const ADOPTION_PATTERNS = ['enabled', 'adopted', 'implemented', 'compliant', 'active', 'in_use', 'enforced'];
const TRUTHY = /^(?:true|yes|y|1|enabled|adopted|implemented|compliant|active|on|applied|enforced)$/i;
const FALSY = /^(?:false|no|n|0|disabled|not[_ -]?adopted|inactive|off|missing|absent)$/i;

export const encodeFlagOrNumber = (value: string | undefined): number | null => {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (TRUTHY.test(trimmed)) return 1;
  if (FALSY.test(trimmed)) return 0;
  return parseNumber(trimmed);
};

const adoptionTargets = (header: string): Target[] | null => {
  if (/(?:tag|tunniste)/.test(header)) return [{ stream: 'maturity', criterion_id: 'A1' }];
  if (/(?:showback|chargeback)/.test(header)) return [{ stream: 'maturity', criterion_id: 'A2' }];
  if (/(?:commitment|ri|sp|cud|sitoumus)/.test(header)) return [{ stream: 'maturity', criterion_id: 'B1' }];
  if (/(?:rightsiz)/.test(header)) return [{ stream: 'maturity', criterion_id: 'B2' }];
  if (/(?:idle|shutdown|schedule)/.test(header)) return [{ stream: 'maturity', criterion_id: 'B3' }];
  if (/(?:spot|preempt)/.test(header)) return [{ stream: 'maturity', criterion_id: 'B4' }];
  if (/(?:lifecycle)/.test(header)) return [{ stream: 'maturity', criterion_id: 'B5' }];
  if (/(?:guardrail|iac|policy_as_code|infracost|opa)/.test(header)) return [{ stream: 'maturity', criterion_id: 'D2' }];
  if (/(?:autoscale|scaling)/.test(header)) return [{ stream: 'maturity', criterion_id: 'D3' }];
  return null;
};

export const detectAdoption = (table: StructuredTableData): { percent: number; present: boolean; eligible: number; targets: Target[] } | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const index = headers.findIndex(header => matchesHeader(header, ADOPTION_PATTERNS));
  if (index < 0 || rows.length === 0) return null;
  const targets = adoptionTargets(headers[index]);
  if (!targets) return null;
  let present = 0;
  let classified = 0;
  for (const row of rows) {
    const value = (row[index] || '').trim();
    if (TRUTHY.test(value)) { present += 1; classified += 1; }
    else if (FALSY.test(value)) classified += 1;
  }
  if (classified === 0) return null;
  return { percent: Math.round((present / rows.length) * 100), present: present > 0, eligible: rows.length, targets };
};

const STATUS_PATTERNS = ['status', 'state', 'ticket_status', 'item_status'];
const OWNER_PATTERNS = ['owner', 'assignee', 'omistaja'];
const CLOSED = /^(?:closed|done|resolved|complete|completed|fixed)$/i;
const OPEN = /^(?:open|todo|in[_ -]?progress|pending|new|wip)$/i;

const processTargets = (headers: string[]): Target[] | null => {
  const joined = headers.join(' ');
  if (/(?:forecast|budget|variance|ennuste)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'C2' }];
  if (/(?:anomaly|alert|incident)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'A3' }];
  if (/(?:rightsiz|recommendation)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'B2' }];
  if (/(?:campaign)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'E1' }];
  if (/(?:status|state)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'C3' }];
  return null;
};

export const detectProcess = (table: StructuredTableData): {
  targets: Target[];
  eligible: number;
  closed: number;
  ownerless: number | null;
  timestamps: number[];
  openAges: number[];
  recurrence: boolean;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const statusIdx = headers.findIndex(header => matchesHeader(header, STATUS_PATTERNS));
  const timeIdx = headers.findIndex(header => matchesHeader(header, TIME_PATTERNS) || matchesHeader(header, ['created', 'opened', 'updated', 'closed_at']));
  if (statusIdx < 0 && timeIdx < 0) return null;
  const targets = processTargets(headers);
  if (!targets) return null;
  const ownerIdx = headers.findIndex(header => matchesHeader(header, OWNER_PATTERNS));
  const entityIdx = headers.findIndex(header => matchesHeader(header, ['resource_id', 'ticket_id', 'item_id', 'id']));
  let closed = 0;
  let ownerless = 0;
  const timestamps: number[] = [];
  const openTimes: number[] = [];
  const openKeys = new Map<string, number>();
  for (const row of rows) {
    const status = (row[statusIdx] || '').trim();
    if (CLOSED.test(status)) closed += 1;
    if (ownerIdx >= 0 && !(row[ownerIdx] || '').trim()) ownerless += 1;
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
    targets,
    eligible: rows.length,
    closed,
    ownerless: ownerIdx >= 0 ? ownerless : null,
    timestamps: timestamps.sort((a, b) => a - b),
    openAges,
    recurrence: [...openKeys.values()].some(count => count > 1),
  };
};

const EXCEPTION_PATTERNS = ['exception', 'override', 'incident', 'alert', 'anomaly', 'violation', 'breach', 'poikkeama'];
const EXCEPTION_VALUE = /^(?:exception|override|incident|alert|anomaly|violation|breach|escalated|true|yes|y|1)$/i;

const exceptionTargets = (headers: string[], header: string): Target[] => {
  const joined = `${headers.join(' ')} ${header}`;
  if (/(?:compliance|residency|audit)/.test(joined)) return [{ stream: 'maturity', criterion_id: 'C5' }];
  if (/(?:anomaly|alert|incident|poikkeama)/.test(header)) return [{ stream: 'maturity', criterion_id: 'A3' }];
  if (/(?:override|exception|violation|breach)/.test(header)) return [{ stream: 'maturity', criterion_id: 'C1' }];
  return [{ stream: 'maturity', criterion_id: 'A3' }];
};

export const detectException = (table: StructuredTableData): {
  targets: Target[];
  eligible: number;
  exceptionCount: number;
  recurrence: boolean;
  openAges: number[];
  closed: number | null;
} | null => {
  const rows = analysisRows(table).filter(row => !totalRow(row));
  const headers = table.headers.map(normalizeHeader);
  const exceptionIdx = headers.findIndex(header => matchesHeader(header, EXCEPTION_PATTERNS));
  if (exceptionIdx < 0 || rows.length === 0) return null;
  const statusIdx = headers.findIndex(header => matchesHeader(header, STATUS_PATTERNS));
  const timeIdx = headers.findIndex(header => matchesHeader(header, TIME_PATTERNS) || matchesHeader(header, ['created', 'opened', 'updated', 'closed_at']));
  const entityIdx = headers.findIndex(header => matchesHeader(header, ['resource_id', 'ticket_id', 'item_id', 'id']));
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
    targets: exceptionTargets(headers, headers[exceptionIdx]),
    eligible: rows.length,
    exceptionCount,
    recurrence: [...keys.values()].some(count => count > 1),
    openAges: ages,
    closed: classifiedClosed > 0 ? closed : null,
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
    const leftIdx = headers.findIndex(header => matchesHeader(header, pair.left_patterns));
    const rightIdx = headers.findIndex(header => matchesHeader(header, pair.right_patterns));
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
  const found: Array<{ criterion_id: string; cadence: CadenceBand }> = [];
  for (const { cadence, re } of CADENCE_PATTERNS) {
    const copy = new RegExp(re.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = copy.exec(haystack))) {
      const context = haystack.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
      let criterionId: string | null = null;
      if (/(?:forecast|budget|ennuste|variance|budjetti)/.test(context)) criterionId = 'C2';
      else if (/(?:policy|approval|guardrail|governance|politiikka)/.test(context)) criterionId = 'C1';
      else if (/(?:operating|raci|cadence|review)/.test(context)) criterionId = 'C3';
      if (criterionId) found.push({ criterion_id: criterionId, cadence });
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

