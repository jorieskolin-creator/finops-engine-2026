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

const VALID_GAP_TERM_RX = /^[\p{L}\p{N}().,:;&'€$_%+/ -]+$/u;

const sanitizeGapTerm = (raw: string): string => raw
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const resolveCriterionId = (rawId: string, requested: ReadonlySet<string>): string | null => {
  const trimmed = rawId.trim();
  if (requested.has(trimmed)) return trimmed;
  if (/^[A-F][1-5]$/.test(trimmed)) {
    const matches = [...requested].filter(candidate => candidate.endsWith(`.${trimmed}`));
    if (matches.length === 1) return matches[0];
  }
  return null;
};

export const analyzeEvidenceGaps = async (request: EvidenceGapRequest, ctx: RunContext): Promise<{
  termsByCriterion: Record<string, string[]>;
  model_used?: string;
  failed: boolean;
}> => {
  if (request.gaps.length === 0) return { termsByCriterion: {}, failed: false };
  const requested = new Set(request.gaps.map(gap => gap.criterion_id));
  const normalizeAndValidate = (text: string): GapQueryOutput => {
    const output = validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, text) as GapQueryOutput;
    if (output.domain_id !== request.domain_id || output.queries.length !== requested.size) {
      throw new Error('INVALID_EVIDENCE_GAP_QUERY');
    }
    const normalizedQueries = output.queries.map(query => {
      const criterionId = resolveCriterionId(query.criterion_id, requested);
      const themes = query.themes.map(sanitizeGapTerm).filter(term => term.length > 0 && VALID_GAP_TERM_RX.test(term));
      const terms = query.terms.map(sanitizeGapTerm).filter(term => term.length > 0 && VALID_GAP_TERM_RX.test(term));
      if (!criterionId || themes.length === 0 || terms.length === 0) {
        throw new Error('INVALID_EVIDENCE_GAP_QUERY');
      }
      return { criterion_id: criterionId, themes, terms };
    });
    if (new Set(normalizedQueries.map(query => query.criterion_id)).size !== requested.size) {
      throw new Error('INVALID_EVIDENCE_GAP_QUERY');
    }
    return { domain_id: output.domain_id, queries: normalizedQueries };
  };
  try {
    const response = await runStage('evidence_gap_analysis', {
      userText: JSON.stringify(request),
      outputContract: OUTPUT_CONTRACT_IDS.evidenceGapQuery,
      validateOutput: normalizeAndValidate,
    }, ctx);
    const parsed = normalizeAndValidate(response.text);
    return {
      termsByCriterion: Object.fromEntries(parsed.queries.map(query => [
        query.criterion_id,
        [...new Set([...query.themes, ...query.terms])],
      ])),
      model_used: response.modelUsed.id,
      failed: false,
    };
  } catch {
    return { termsByCriterion: {}, failed: true };
  }
};
