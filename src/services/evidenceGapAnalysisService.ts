import { runStage, type RunContext } from './modelRouter';
// @ts-expect-error Pure JS contract is also consumed by the execution worker.
import { OUTPUT_CONTRACT_IDS, validateOutputContractText } from '../../lib/outputContracts.js';

export interface EvidenceGapRequest {
  schema_version: 'finops_evidence_gap_input_v1';
  domain_id: string;
  round: 1 | 2;
  gaps: Array<{ criterion_id: string; missing_concept_ids: string[] }>;
}

interface GapQueryOutput {
  domain_id: string;
  queries: Array<{ criterion_id: string; themes: string[]; terms: string[] }>;
}

const VALID_GAP_TERM_RX = /^[\p{L}\p{N}().,:&'_%+/ -]+$/u;

export const analyzeEvidenceGaps = async (request: EvidenceGapRequest, ctx: RunContext): Promise<{
  termsByCriterion: Record<string, string[]>;
  model_used?: string;
  failed: boolean;
}> => {
  if (request.gaps.length === 0) return { termsByCriterion: {}, failed: false };
  const requested = new Set(request.gaps.map(gap => gap.criterion_id));
  const validate = (text: string): GapQueryOutput => {
    const output = validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, text) as GapQueryOutput;
    if (output.domain_id !== request.domain_id || output.queries.length !== requested.size
      || new Set(output.queries.map(query => query.criterion_id)).size !== requested.size
      || output.queries.some(query => !requested.has(query.criterion_id)
        || [...query.themes, ...query.terms].some(term => term !== term.trim() || !VALID_GAP_TERM_RX.test(term)))) {
      throw new Error('INVALID_EVIDENCE_GAP_QUERY');
    }
    return output;
  };
  try {
    const response = await runStage('evidence_gap_analysis', {
      userText: JSON.stringify(request),
      outputContract: OUTPUT_CONTRACT_IDS.evidenceGapQuery,
      validateOutput: validate,
    }, ctx);
    return {
      termsByCriterion: Object.fromEntries(validate(response.text).queries.map(query => [query.criterion_id, [...new Set([...query.themes, ...query.terms])]])),
      model_used: response.modelUsed.id,
      failed: false,
    };
  } catch {
    return { termsByCriterion: {}, failed: true };
  }
};
