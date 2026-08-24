import type { EvidenceCheckItem } from '../types';
import { MASTER_BINGO_FINOPS } from '../knowledge_base';
import { runStage, type RunContext } from './modelRouter';
// @ts-expect-error Pure JS contract is also consumed by the serverless API.
import { OUTPUT_CONTRACT_IDS, validateOutputContractText } from '../../lib/outputContracts.js';

const MAX_QUERY_TEXT_LENGTH = 80;

interface GapQueryOutput {
  schema_version: 'finops_evidence_gap_query_v1';
  domain_id: string;
  queries: Array<{ criterion_id: string; themes: string[]; terms: string[] }>;
}

export interface EvidenceGapAnalysisResult {
  terms?: string[];
  model_used?: string;
  failed: boolean;
}

const safeSummary = (value: string | undefined): string => (value || '')
  .replace(/[<>]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500);

const validateSemanticOutput = (
  text: string,
  domainId: string,
  expectedCriterionIds: Set<string>,
): GapQueryOutput => {
  const parsed = validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, text) as GapQueryOutput;
  if (parsed.domain_id !== domainId
    || parsed.queries.length !== expectedCriterionIds.size
    || parsed.queries.some(query => !expectedCriterionIds.has(query.criterion_id))
    || new Set(parsed.queries.map(query => query.criterion_id)).size !== parsed.queries.length
    || parsed.queries.some(query => [...query.themes, ...query.terms].some(value =>
      value !== value.trim() || value.length < 2 || value.length > MAX_QUERY_TEXT_LENGTH || /[\u0000-\u001f]/.test(value)
    ))) {
    throw new Error('INVALID_EVIDENCE_GAP_QUERY');
  }
  return parsed;
};

const interleaveQueryTerms = (queries: GapQueryOutput['queries']): string[] => {
  const pools = queries.map(query => [...query.themes, ...query.terms]);
  const terms: string[] = [];
  for (let index = 0; pools.some(pool => index < pool.length); index++) {
    for (const pool of pools) if (index < pool.length) terms.push(pool[index]);
  }
  return [...new Set(terms)];
};

export const analyzeEvidenceGaps = async (input: {
  domainId: string;
  items: EvidenceCheckItem[];
  pass: 1 | 2;
  seenTerms: Set<string>;
  ctx: RunContext;
}): Promise<EvidenceGapAnalysisResult> => {
  const weakItems = input.items.filter(item => item.status === 'weak' && item.rescan_recommended === true);
  if (weakItems.length === 0) return { failed: false };
  const criteria = weakItems.map(item => {
    const definition = MASTER_BINGO_FINOPS[item.stream].find(candidate => candidate.id === item.id);
    return {
      criterion_id: `${item.stream}.${item.id}`,
      title: safeSummary(definition?.title),
      assessment_question: safeSummary(definition?.desc),
      low_evidence_summary: safeSummary(item.rationale),
      coverage_summary: safeSummary(item.coverage_reason),
    };
  });
  const expectedCriterionIds = new Set(criteria.map(item => item.criterion_id));
  const userText = JSON.stringify({
    domain_id: input.domainId,
    pass: input.pass,
    weak_criteria: criteria,
    previously_used_terms: [...input.seenTerms].sort().slice(0, 48),
  });
  const systemInstruction = `You are a bounded evidence-retrieval query planner. Convert only the supplied low-evidence criterion summaries into concise semantic search themes and terms for deterministic local search of the already-approved customer Source Registry.

Return the exact finops_evidence_gap_query_v1 JSON contract. Use each supplied criterion_id exactly. Propose synonyms, domain language, and likely labels that may retrieve relevant passages even when wording differs. Do not score, classify, diagnose, recommend, infer facts, request external search, or include source quotes. Do not use or request a knowledge base. Maximum four themes and eight terms per criterion.`;

  try {
    let validated: GapQueryOutput | undefined;
    const response = await runStage('evidence_gap_analysis', {
      userText,
      systemInstruction,
      outputContract: OUTPUT_CONTRACT_IDS.evidenceGapQuery,
      validateOutput: text => { validated = validateSemanticOutput(text, input.domainId, expectedCriterionIds); },
    }, input.ctx);
    const output = validated || validateSemanticOutput(response.text, input.domainId, expectedCriterionIds);
    const terms = interleaveQueryTerms(output.queries);
    return { terms, model_used: response.modelUsed.id, failed: false };
  } catch {
    // Gap-query generation is advisory. Deterministic semantic expansion remains
    // the governed fallback and a model failure must not fail the evidence lane.
    return { failed: true };
  }
};
