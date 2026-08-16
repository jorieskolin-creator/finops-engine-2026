import type { EvidenceCheckItem, RoutedSourcePacket, SemanticGapRetrievalPassTrace, SourceChunk, SourceRegistry } from '../types';
import { MASTER_BINGO_FINOPS } from '../knowledge_base';
import { expandDomainPacket, routingTermsForDomain } from './sourceRegistryService';

const MAX_SELECTIONS_PER_PASS = 8;
const MAX_TERMS_PER_PASS = 24;
const STOP_WORDS = new Set([
  'about','after','again','against','also','and','are','because','been','before','being','but','cannot','could','does','each','evidence','from','have','into','more','most','not','only','other','over','same','scanner','score','source','status','than','that','the','their','them','then','there','these','they','this','those','through','under','using','verifier','very','was','were','what','when','where','which','while','with','without','would',
  'että','joka','kanssa','kun','mutta','myös','ole','ovat','sen','sitä','tai','tämä'
]);

const normalize = (value: string): string => value
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/src-\d+(?:-[a-z]\d+)+/g, ' ')
  .replace(/[^a-z0-9äöå]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const meaningful = (token: string): boolean =>
  token.length >= 4 && !STOP_WORDS.has(token) && !/^\d+$/.test(token);

const semanticTerms = (items: EvidenceCheckItem[], seenTerms: Set<string>): string[] => {
  const weighted = new Map<string, number>();
  const add = (term: string, weight: number) => {
    const normalized = normalize(term);
    if (!normalized || seenTerms.has(normalized)) return;
    const tokens = normalized.split(' ');
    if (tokens.some(token => !meaningful(token))) return;
    weighted.set(normalized, Math.max(weighted.get(normalized) || 0, weight));
  };
  const addContext = (value: string, baseWeight: number) => {
    const tokens = normalize(value).split(' ').filter(meaningful);
    for (const token of tokens) add(token, baseWeight);
    for (let size = 2; size <= 3; size++) {
      for (let index = 0; index <= tokens.length - size; index++) {
        add(tokens.slice(index, index + size).join(' '), baseWeight + size);
      }
    }
  };
  for (const item of items) {
    const criterion = MASTER_BINGO_FINOPS[item.stream].find(candidate => candidate.id === item.id);
    if (criterion) addContext(`${criterion.title} ${criterion.desc}`, 1);
    addContext(`${item.rationale} ${item.coverage_reason || ''}`, 4);
  }
  return [...weighted.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TERMS_PER_PASS)
    .map(([term]) => term);
};

const matchScore = (chunk: SourceChunk, terms: string[]): number => {
  const text = normalize(chunk.text);
  return terms.reduce((score, term) => {
    if (text.includes(term)) return score + term.split(' ').length * 4;
    const tokens = term.split(' ');
    const matched = tokens.filter(token => text.includes(token)).length;
    return score + (matched === tokens.length ? matched : 0);
  }, 0);
};

export const expandWeakEvidencePacket = (input: {
  registry: SourceRegistry;
  packet: RoutedSourcePacket;
  items: EvidenceCheckItem[];
  pass: 1 | 2;
  seenTerms: Set<string>;
}): {
  packet: RoutedSourcePacket;
  trace: Omit<SemanticGapRetrievalPassTrace, 'packet_hash_before' | 'packet_hash_after' | 'evidence_status_after'>;
} => {
  const weakItems = input.items.filter(item => item.status === 'weak' && item.rescan_recommended === true);
  const domainTerms = routingTermsForDomain(input.packet.domain_id).map(normalize);
  if (input.seenTerms.size === 0) domainTerms.forEach(term => input.seenTerms.add(term));
  const seenTermsBefore = [...input.seenTerms].sort();
  const proposedTerms = semanticTerms(weakItems, input.seenTerms);
  proposedTerms.forEach(term => input.seenTerms.add(term));
  const selected = new Set(input.packet.manifest.map(item => item.chunk_id));
  const candidates = proposedTerms.length === 0 ? [] : input.registry.chunks
    .filter(chunk => !selected.has(chunk.chunk_id))
    .map(chunk => ({ chunk, score: matchScore(chunk, proposedTerms) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.chunk_id.localeCompare(b.chunk.chunk_id));
  const expanded = expandDomainPacket(
    input.registry,
    input.packet,
    candidates.slice(0, MAX_SELECTIONS_PER_PASS).map(candidate => candidate.chunk.chunk_id)
  );
  const stopReason = proposedTerms.length === 0
    ? 'NO_NEW_TERMS' as const
    : candidates.length === 0
      ? 'NO_NEW_CANDIDATES' as const
      : expanded.selected_chunk_ids.length === 0
        ? 'PACKET_LIMIT_REACHED' as const
        : input.pass === 2
          ? 'MAX_PASSES_REACHED' as const
          : 'NEW_EVIDENCE_SELECTED' as const;
  return {
    packet: expanded.packet,
    trace: {
      domain_id: input.packet.domain_id,
      pass: input.pass,
      trigger_status: 'weak',
      criterion_ids: weakItems.map(item => `${item.stream}.${item.id}`).sort(),
      strategy: 'verifier_derived_semantic_expansion',
      seen_terms_before: seenTermsBefore,
      proposed_terms: proposedTerms,
      matched_candidate_count: candidates.length,
      selected_chunk_ids: expanded.selected_chunk_ids,
      evidence_status_before: Object.fromEntries(weakItems.map(item => [`${item.stream}.${item.id}`, item.status])),
      stop_reason: stopReason
    }
  };
};
