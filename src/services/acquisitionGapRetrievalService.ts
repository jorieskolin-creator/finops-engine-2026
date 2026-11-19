import type { AcquisitionGapPassTrace, DerivedAnalyticalEvidence, RoutedSourcePacket, SourceRegistry } from '../types';
import catalog from '../knowledge_base/finops_crucial_items.json';
import { hasCustomerFinOpsContext, normalizeEvidenceSearchText as normalize } from './evidenceAdmissionService';
import { analyzeEvidenceGaps, type EvidenceGapRequest } from './evidenceGapAnalysisService';
import { expandDomainPacket, isChunkEligibleForDomain } from './sourceRegistryService';
import type { RunContext } from './modelRouter';

interface SearchLead {
  chunkId: string;
  text: string;
  cuePositions: Array<{ term: string; index: number }>;
}

interface DomainGapPlan {
  gaps: EvidenceGapRequest['gaps'];
  leads: Map<string, SearchLead[]>;
  fallbackTerms: Map<string, string[]>;
}

const MAX_LEADS_PER_CRITERION = 32;
const MAX_ADDITIONS_PER_DOMAIN = 8;
const MAX_CUE_DISTANCE = 256;
const catalogById = new Map(catalog.criteria.map(criterion => [criterion.criterion_id, criterion]));

const wholeMatchPositions = (text: string, term: string): number[] => {
  const phrase = ` ${term} `;
  const positions: number[] = [];
  for (let index = text.indexOf(phrase); index >= 0; index = text.indexOf(phrase, index + 1)) {
    positions.push(index);
  }
  return positions;
};

export const planAcquisitionGapQueries = (
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
  derived: DerivedAnalyticalEvidence[],
): Map<string, DomainGapPlan> => {
  const plans = new Map<string, DomainGapPlan>();
  const scoped = registry.chunks.filter(chunk => hasCustomerFinOpsContext(chunk.text))
    .map(chunk => ({ chunk, text: ` ${normalize(chunk.text)} ` }));
  for (const observation of derived) {
    const target = observation.targets[0];
    const coverage = observation.result.coverage;
    if (observation.derivation.analyzer_id !== 'crucial_item_coverage_v1' || !target || !coverage
      || (coverage.critical_coverage === 'COMPLETE' && coverage.found * 2 >= coverage.expected)) continue;
    const criterion = catalogById.get(target.criterion_id);
    if (!criterion) continue;
    const domain = criterion.criterion_id[0];
    const packet = packets[domain];
    // Keep both deterministic rounds available if already-routed candidates remain.
    if (!packet || packet.total_candidate_chunks > packet.included_chunk_count) continue;
    const plan: DomainGapPlan = plans.get(domain) ?? { gaps: [], leads: new Map(), fallbackTerms: new Map() };
    if (plan.gaps.length >= 3) continue;
    const missing = criterion.items.filter(item => coverage.missing_items.includes(item.id))
      .sort((left, right) => Number(right.critical) - Number(left.critical)).slice(0, 3);
    if (!missing.length) continue;
    const cues = [...new Set(criterion.items.flatMap(item => item.aliases).map(normalize))].filter(term => term.length >= 4);
    const leads: SearchLead[] = [];
    for (const { chunk, text } of scoped) {
      if (isChunkEligibleForDomain(chunk, domain)) continue;
      const cuePositions = cues.flatMap(term => wholeMatchPositions(text, term).map(index => ({ term, index })));
      if (cuePositions.length === 0) continue;
      leads.push({ chunkId: chunk.chunk_id, text, cuePositions });
      if (leads.length >= MAX_LEADS_PER_CRITERION) break;
    }
    if (!leads.length) continue;
    const criterionId = `${criterion.stream}.${criterion.criterion_id}`;
    plan.gaps.push({ criterion_id: criterionId, missing_concept_ids: missing.map(item => item.id) });
    plan.leads.set(criterionId, leads);
    plan.fallbackTerms.set(criterionId, missing.flatMap(item => item.aliases));
    plans.set(domain, plan);
  }
  return plans;
};

const hasLocalCorroboration = (lead: SearchLead, terms: readonly string[]): boolean => terms.some(raw => {
  const term = normalize(raw);
  if (!term.includes(' ')) return false;
  const phrase = ` ${term} `;
  if (!lead.text.includes(phrase)) return false;
  return lead.cuePositions.some(cue => {
    const cuePhrase = ` ${cue.term} `;
    if (phrase.includes(cuePhrase) || cuePhrase.includes(phrase)) return false;
    const start = Math.max(0, cue.index - MAX_CUE_DISTANCE);
    const index = lead.text.indexOf(phrase, start);
    return index >= 0 && index <= cue.index + MAX_CUE_DISTANCE;
  });
});

export const retrieveAcquisitionGaps = async (
  registry: SourceRegistry,
  packets: Record<string, RoutedSourcePacket>,
  plans: Map<string, DomainGapPlan>,
  ctx: RunContext,
): Promise<{ registry: SourceRegistry; packets: Record<string, RoutedSourcePacket>; passes: AcquisitionGapPassTrace[] }> => {
  const passes: AcquisitionGapPassTrace[] = [];
  const updatedPackets = { ...packets };
  let updatedRegistry = registry;
  for (const [domain, plan] of plans) {
    const request: EvidenceGapRequest = { schema_version: 'finops_evidence_gap_input_v1', domain_id: domain, round: 2, gaps: plan.gaps };
    const result = await analyzeEvidenceGaps(request, ctx);
    const matches = new Map<string, string>();
    const candidateIds = new Set<string>();
    for (const [criterionId, leads] of plan.leads) {
      const terms = result.failed ? plan.fallbackTerms.get(criterionId) ?? [] : result.termsByCriterion[criterionId] ?? [];
      for (const lead of leads) {
        candidateIds.add(lead.chunkId);
        if (hasLocalCorroboration(lead, terms) && !matches.has(lead.chunkId) && matches.size < MAX_ADDITIONS_PER_DOMAIN) {
          matches.set(lead.chunkId, criterionId);
        }
      }
    }
    const withNewRoutes = (ids: ReadonlySet<string>): SourceRegistry => ({
      ...updatedRegistry,
      chunks: updatedRegistry.chunks.map(chunk => ids.has(chunk.chunk_id) ? {
        ...chunk,
        routing: [...chunk.routing.filter(hint => hint.domain !== domain), {
          domain, score: 3, tier: 'medium', reasons: [`catalog_gap:${matches.get(chunk.chunk_id)}`],
        }],
      } : chunk),
    });
    const selected = matches.size > 0
      ? expandDomainPacket(withNewRoutes(new Set(matches.keys())), updatedPackets[domain], [...matches.keys()]).selected_chunk_ids
      : [];
    if (selected.length > 0) {
      updatedRegistry = withNewRoutes(new Set(selected));
      const previous = updatedPackets[domain];
      updatedPackets[domain] = expandDomainPacket(updatedRegistry, {
        ...previous, total_candidate_chunks: previous.total_candidate_chunks + selected.length,
      }, selected).packet;
    }
    passes.push({
      domain_id: domain, round: 2, criterion_ids: plan.gaps.map(gap => gap.criterion_id),
      candidate_count: candidateIds.size, selected_chunk_ids: selected, model_used: result.model_used,
      outcome: selected.length > 0 ? 'NEW_EVIDENCE_SELECTED' : result.failed ? 'PLANNER_UNAVAILABLE' : 'NO_ELIGIBLE_GAIN',
    });
  }
  // An added route can change another packet's routed-domain metadata.
  if (updatedRegistry !== registry) {
    for (const domain of Object.keys(updatedPackets)) {
      updatedPackets[domain] = expandDomainPacket(updatedRegistry, updatedPackets[domain], []).packet;
    }
  }
  return { registry: updatedRegistry, packets: updatedPackets, passes };
};
