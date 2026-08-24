import type { DerivedAnalyticalEvidence, SourceChunk, SourceRecord, SourceRegistry } from '../../types';
import crucialItemsData from '../../knowledge_base/finops_crucial_items.json';
import aliasData from '../../knowledge_base/finops_term_aliases.json';

export const CRUCIAL_ITEM_COVERAGE_ANALYZER_ID = 'crucial_item_coverage_v1' as const;
export const CRUCIAL_ITEM_COVERAGE_ANALYZER_VERSION = '1.0.0' as const;
export const EVIDENCE_ANALYSIS_REGISTRY_V2 = 'evidence_analysis_registry_v2' as const;

type CrucialItem = { id: string; critical: boolean; aliases: string[] };
type CrucialCriterion = { criterion_id: string; stream: 'maturity'; theme: string; items: CrucialItem[] };

const CRITERIA = crucialItemsData.criteria as CrucialCriterion[];
const CONCEPT_ALIASES = aliasData.concepts as Record<string, string[]>;

const normalize = (value: string): string => value
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9äöå]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const hash = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const coverageBand = (percentValue: number): NonNullable<DerivedAnalyticalEvidence['result']['coverage']>['coverage_band'] => {
  if (percentValue < 25) return '0_25';
  if (percentValue < 50) return '25_50';
  if (percentValue < 75) return '50_75';
  if (percentValue < 90) return '75_90';
  return '90_100';
};

const termHit = (haystack: string, term: string): boolean => {
  const needle = normalize(term);
  if (needle.length < 4) return false;
  if (!haystack.includes(needle)) return false;
  return new RegExp(`(?:^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(` ${haystack} `);
};

const expandAliases = (item: CrucialItem): string[] => {
  const terms = new Set<string>(item.aliases);
  for (const alias of item.aliases) {
    const key = Object.keys(CONCEPT_ALIASES).find(concept => normalize(alias).includes(normalize(concept)));
    if (key) CONCEPT_ALIASES[key].forEach(value => terms.add(value));
  }
  return [...terms];
};

const corpusText = (sources: SourceRecord[], registry?: SourceRegistry): { text: string; chunks: SourceChunk[]; headers: string } => {
  const chunks = registry?.chunks || [];
  const sourceText = sources.map(source => [
    source.text || '',
    ...(source.pages || []).map(page => page.text),
    ...(source.visual_units || []).map(unit => unit.text),
  ].join(' ')).join(' ');
  const headerText = sources.flatMap(source =>
    [...(source.structured_tables || []), ...(source.structured_table ? [source.structured_table] : [])]
      .flatMap(table => table.headers)
  ).join(' ');
  const chunkText = chunks.map(chunk => chunk.text).join(' ');
  return { text: normalize([sourceText, chunkText, headerText].join(' ')), chunks, headers: normalize(headerText) };
};

export interface CoverageLocationMap {
  [criterionId: string]: Record<string, string[]>;
}

export const analyzeCrucialItemCoverage = (
  sources: SourceRecord[],
  registry?: SourceRegistry
): { evidence: DerivedAnalyticalEvidence[]; locations: CoverageLocationMap } => {
  if (sources.length === 0) return { evidence: [], locations: {} };
  const { text, chunks, headers } = corpusText(sources, registry);
  const haystack = `${text} ${headers}`;
  if (!haystack.trim()) return { evidence: [], locations: {} };

  const locations: CoverageLocationMap = {};
  const evidence = CRITERIA.map(criterion => {
    const found: string[] = [];
    const missing: string[] = [];
    const itemChunks: Record<string, string[]> = {};
    for (const item of criterion.items) {
      const terms = expandAliases(item);
      const matched = terms.some(term => termHit(haystack, term));
      if (matched) {
        found.push(item.id);
        itemChunks[item.id] = chunks
          .filter(chunk => terms.some(term => termHit(normalize(chunk.text), term)))
          .map(chunk => chunk.chunk_id)
          .sort();
      } else {
        missing.push(item.id);
      }
    }
    locations[criterion.criterion_id] = itemChunks;
    const expected = criterion.items.length;
    const foundCount = found.length;
    const percentValue = expected > 0 ? Math.round((foundCount / expected) * 100) : 0;
    const criticalMissing = criterion.items.filter(item => item.critical && missing.includes(item.id)).map(item => item.id);
    const criticalCoverage = criticalMissing.length === 0
      ? 'COMPLETE' as const
      : foundCount === 0
        ? 'MISSING' as const
        : 'PARTIAL' as const;
    const confidence = haystack.length > 4000 && foundCount >= 2 ? 'HIGH' as const : haystack.length > 800 ? 'MODERATE' as const : 'LOW' as const;
    const sourceId = sources[0].source_id;
    const coverage = {
      expected,
      found: foundCount,
      not_found: missing.length,
      unusable: 0,
      coverage_band: coverageBand(percentValue),
      critical_coverage: criticalCoverage,
      missing_items: missing.slice().sort(),
    };
    const summaryLines = [
      `${criterion.theme} crucial-item coverage: ${foundCount}/${expected} found; band=${coverage.coverage_band}; critical=${criticalCoverage}.`,
      ...(missing.length ? [`Missing items: ${missing.join(', ')}.`] : ['No missing items.']),
      'NOT_FOUND is coverage, not tested absence and not a maturity score.',
    ];
    const signature = [
      'derived_analytical_evidence_v1',
      CRUCIAL_ITEM_COVERAGE_ANALYZER_ID,
      CRUCIAL_ITEM_COVERAGE_ANALYZER_VERSION,
      EVIDENCE_ANALYSIS_REGISTRY_V2,
      criterion.criterion_id,
      hash(JSON.stringify({ found: found.slice().sort(), missing: missing.slice().sort(), source_ids: sources.map(source => source.source_id).sort() })),
    ].join('|');
    const rowCount = chunks.length || sources.length;
    const object: DerivedAnalyticalEvidence = {
      schema_version: 'derived_analytical_evidence_v1',
      mode: 'authoritative',
      evidence_id: `EVID-DER-${hash(signature)}`,
      evidence_type: 'deterministic_analytical',
      source_id: sourceId,
      targets: [{ stream: 'maturity', criterion_id: criterion.criterion_id }],
      derivation: {
        analyzer_id: CRUCIAL_ITEM_COVERAGE_ANALYZER_ID,
        analyzer_version: CRUCIAL_ITEM_COVERAGE_ANALYZER_VERSION,
        registry_version: EVIDENCE_ANALYSIS_REGISTRY_V2,
        method: 'crucial_item_coverage_analysis',
        calculation_ids: ['expected_vs_found', 'coverage_band', 'critical_coverage'],
      },
      result: {
        status: 'OBSERVED',
        source_row_count: rowCount,
        withheld_source_row_count: 0,
        withheld_source_column_count: 0,
        analyzed_row_count: rowCount,
        eligible_row_count: rowCount,
        excluded_total_row_count: 0,
        row_scope: 'acquired_corpus',
        row_truncated: false,
        detected_signal_count: foundCount,
        mapping_population_coverage: null,
        tagging_population_coverage: null,
        allocation_population_coverage: null,
        field_coverage: [],
        cost_basis: { state: 'NOT_PRESENT', column_index: null, source_column_number: null, currencies: [], excluded_row_count: 0 },
        reconciliation: { state: 'NOT_AVAILABLE' },
        coverage,
      },
      summary_lines: summaryLines,
      locator: {},
      eligibility: { state: 'ELIGIBLE', reasons: [] },
      unit_fingerprint: hash(signature),
      report_eligible: true,
      raw_value_exposure: false,
      quality: {
        population_coverage: haystack.length > 4000 ? 'HIGH' : haystack.length > 800 ? 'MODERATE' : 'LOW',
        confidence,
        limitation: missing.length ? `Missing items remain NOT_FOUND after alias search: ${missing.join(', ')}.` : null,
      },
      llm_policy: {
        may_use_as_evidence: true,
        may_recalculate: false,
        may_infer_exact_values: false,
        causal_authority: 'NONE',
      },
    };
    return object;
  });

  return { evidence, locations };
};
