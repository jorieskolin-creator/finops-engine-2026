import type { DerivedAnalyticalEvidence, GapRetrievalPlan, RoutedSourcePacket } from '../types';
import type { CoverageLocationMap } from './derivedEvidence/coverageAnalyzer';
import aliasData from '../knowledge_base/finops_term_aliases.json';
import crucialItemsData from '../knowledge_base/finops_crucial_items.json';

const CONCEPT_ALIASES = aliasData.concepts as Record<string, string[]>;
const CRITERIA = crucialItemsData.criteria as Array<{
  criterion_id: string;
  items: Array<{ id: string; aliases: string[] }>;
}>;

const LOW_BANDS = new Set(['0_25', '25_50']);

const aliasesForItem = (itemId: string): string[] => {
  const terms = new Set<string>();
  for (const criterion of CRITERIA) {
    const item = criterion.items.find(entry => entry.id === itemId);
    if (!item) continue;
    item.aliases.forEach(alias => terms.add(alias.toLowerCase()));
    for (const alias of item.aliases) {
      const key = Object.keys(CONCEPT_ALIASES).find(concept => alias.toLowerCase().includes(concept));
      if (key) CONCEPT_ALIASES[key].forEach(value => terms.add(value.toLowerCase()));
    }
  }
  return [...terms].sort();
};

export const planGapRetrieval = (input: {
  packets: Record<string, RoutedSourcePacket>;
  derived: DerivedAnalyticalEvidence[];
  locations?: CoverageLocationMap;
}): GapRetrievalPlan => {
  const termsByDomain: Record<string, string[]> = {};
  const chunkIdsByDomain: Record<string, string[]> = {};
  const reasons: GapRetrievalPlan['reasons'] = [];
  const trigger = new Set<string>();

  for (const [domainId, packet] of Object.entries(input.packets)) {
    const domainDerived = input.derived.filter(item =>
      item.targets.some(target => target.criterion_id.startsWith(domainId))
    );
    const coverageDerived = domainDerived.filter(item => item.derivation.analyzer_id === 'crucial_item_coverage_v1');
    const selected = new Set(packet.manifest.map(item => item.chunk_id));
    const terms = new Set<string>();
    const chunks = new Set<string>();

    for (const evidence of coverageDerived) {
      const coverage = evidence.result.coverage;
      if (!coverage) continue;
      const criterionId = evidence.targets[0]?.criterion_id;
      if (LOW_BANDS.has(coverage.coverage_band) || coverage.critical_coverage !== 'COMPLETE') {
        coverage.missing_items.forEach(itemId => aliasesForItem(itemId).forEach(term => terms.add(term)));
        trigger.add(domainId);
        reasons.push({
          domain_id: domainId,
          reason: `${criterionId || domainId} coverage_band=${coverage.coverage_band} critical=${coverage.critical_coverage}`,
        });
      }
      if (criterionId && input.locations?.[criterionId]) {
        for (const chunkIds of Object.values(input.locations[criterionId])) {
          chunkIds.filter(id => !selected.has(id)).forEach(id => chunks.add(id));
        }
      }
    }

    if (packet.weak_coverage) {
      trigger.add(domainId);
      reasons.push({ domain_id: domainId, reason: 'packet weak_coverage' });
    }
    if (domainDerived.some(item => item.result.status === 'NO_STATISTICALLY_USABLE_POPULATION')) {
      trigger.add(domainId);
      reasons.push({ domain_id: domainId, reason: 'NO_STATISTICALLY_USABLE_POPULATION' });
    }
    if (chunks.size > 0) {
      trigger.add(domainId);
      reasons.push({ domain_id: domainId, reason: `unrouted supporting chunks=${chunks.size}` });
    }

    if (terms.size) termsByDomain[domainId] = [...terms].sort();
    if (chunks.size) chunkIdsByDomain[domainId] = [...chunks].sort();
  }

  return {
    schema_version: 'gap_retrieval_plan_v1',
    generative: false,
    trigger_domains: [...trigger].sort(),
    terms_by_domain: termsByDomain,
    chunk_ids_by_domain: chunkIdsByDomain,
    reasons: reasons.sort((a, b) => a.domain_id.localeCompare(b.domain_id) || a.reason.localeCompare(b.reason)),
  };
};
