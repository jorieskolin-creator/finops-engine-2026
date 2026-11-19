import { readFileSync } from 'node:fs';

// The allowlist comes from the maintained criterion catalog, never run content.
const catalog = JSON.parse(readFileSync(new URL('../src/knowledge_base/finops_crucial_items.json', import.meta.url), 'utf8'));
const criteria = new Map(catalog.criteria.map(criterion => [`${criterion.stream}.${criterion.criterion_id}`, criterion]));
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const gapSearchInstruction = 'Suggest alternative FinOps search language for each supplied criterion and concept. Return only finops_evidence_gap_query_v1 JSON with exactly one query per supplied criterion. Use multi-word synonyms or equivalent record labels in English or Finnish. Keep concepts within their supplied criterion. Do not score, infer customer facts, or request external information.';

export function hydrateEvidenceGapRequest(text) {
  if (text.length > 4096) throw new Error('INVALID_EVIDENCE_GAP_INPUT');
  const request = JSON.parse(text);
  const invalid = () => { throw new Error('INVALID_EVIDENCE_GAP_INPUT'); };
  if (!exactKeys(request, ['schema_version', 'domain_id', 'round', 'gaps'])
    || request.schema_version !== 'finops_evidence_gap_input_v1'
    || typeof request.domain_id !== 'string' || !/^[A-F]$/.test(request.domain_id)
    || (request.round !== 1 && request.round !== 2)
    || !Array.isArray(request.gaps) || request.gaps.length < 1 || request.gaps.length > 3) invalid();

  const seen = new Set();
  const gaps = request.gaps.map(gap => {
    if (!exactKeys(gap, ['criterion_id', 'missing_concept_ids'])) invalid();
    const criterion = criteria.get(gap.criterion_id);
    const ids = gap.missing_concept_ids;
    if (!criterion || criterion.criterion_id[0] !== request.domain_id || seen.has(gap.criterion_id)
      || !Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length) invalid();
    seen.add(gap.criterion_id);
    const missingConcepts = ids.map(id => {
      const item = criterion.items.find(candidate => candidate.id === id);
      if (!item) invalid();
      return { concept_id: item.id, approved_terms: item.aliases };
    });
    return { criterion_id: gap.criterion_id, theme: criterion.theme, missing_concepts: missingConcepts };
  });
  return JSON.stringify({ domain_id: request.domain_id, gaps });
}

export function validateApprovedGapSearch(packet) {
  if (packet.stage !== 'evidence_gap_analysis') return;
  const text = packet.parts[0].text;
  if (packet.output_contract !== 'finops_evidence_gap_query_v1' || packet.system_instruction !== gapSearchInstruction || text.length > 4096) {
    throw new Error('INVALID_EVIDENCE_GAP_INPUT');
  }
  const approved = JSON.parse(text);
  const catalogRequest = JSON.stringify({
    schema_version: 'finops_evidence_gap_input_v1', domain_id: approved.domain_id, round: 2,
    gaps: approved.gaps.map(gap => ({
      criterion_id: gap.criterion_id, missing_concept_ids: gap.missing_concepts.map(concept => concept.concept_id),
    })),
  });
  if (hydrateEvidenceGapRequest(catalogRequest) !== text) throw new Error('INVALID_EVIDENCE_GAP_INPUT');
}
