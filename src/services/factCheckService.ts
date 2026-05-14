
import { AuditItem, FactCheckClaim, FactCheckResult, Phase1AuditLogs, Phase2Validation, ClaimFailureType, ClaimSourceLocation } from '../types';

const VALID_FAILURE_TYPES: ClaimFailureType[] = ['fabricated_number', 'unverifiable_entity', 'unsupported_org_claim', 'out_of_scope', 'other'];
const VALID_SOURCE_LOCATIONS: ClaimSourceLocation[] = ['finops_lead', 'cfo', 'engineering_lead', 'roadmap'];

export interface FactCheckInputs {
  executiveSummary: string;
  remediationRoadmapText: string;
  sourceDocument: string;
  phase1: Phase1AuditLogs;
  phase2: Phase2Validation;
  imageCount?: number;
}

const MAX_SOURCE_CHARS = 40000;

const compactEvidence = (phase1: Phase1AuditLogs): string => {
  const lines: string[] = [];
  for (const stream of ['maturity', 'antipattern'] as const) {
    for (const [id, item] of Object.entries(phase1[stream])) {
      const a = item as AuditItem;
      if (a.evidence_quotes.length === 0) continue;
      const quotes = a.evidence_quotes.map(q => `"${q.quote.replace(/"/g, "'").substring(0, 200)}"`).join(' | ');
      lines.push(`${stream}.${id} (count=${a.count}): ${quotes}`);
    }
  }
  return lines.join('\n');
};

const compactMetrics = (phase2: Phase2Validation): string => {
  const m = phase2.metrics;
  return [
    `finops_readiness=${Math.round(m.finops_readiness)}%`,
    `maturity_depth=${Math.round(m.maturity_depth)}%`,
    `antipattern_burden=${Math.round(m.antipattern_burden)}%`,
    `maturity_ratio=${Math.round(m.maturity_ratio)}%`,
    `antipattern_ratio=${Math.round(m.antipattern_ratio)}%`,
    `delivery_integrity=${m.delivery_integrity}%`,
    `evidence_density=${m.evidence_density}%`,
    `classification=${phase2.crawl_walk_run}`,
    `silent_areas_count=${phase2.silent_areas.length}`,
    `maturity_gaps_count=${phase2.maturity_gaps.length}`,
    `antipattern_findings_count=${phase2.antipattern_findings.length}`
  ].join(', ');
};

export const buildFactCheckPrompt = (inputs: FactCheckInputs): string => `
<role>
You are a fact-checker for a FinOps maturity assessment.
Your job: extract every distinct factual claim from the STRATEGY OUTPUT below, then classify each claim against the source material the strategy was generated from.
</role>

<classifications>
- "supported_by_source": the claim is directly stated or clearly implied in the SOURCE_DOCUMENT, OR is clearly visible in one of the attached SOURCE_IMAGES (dashboard screenshot, architecture diagram, org chart, PDF page rendered as image).
- "supported_by_audit": the claim is derived from PHASE_1_EVIDENCE or PHASE_2_METRICS (both produced by this engine from the source).
- "unsupported": the claim cannot be traced to either above. This includes invented numbers, named entities not in the source, organizational claims with no evidence, and confident assertions about facts not present in the inputs.
</classifications>

<image_verification_rule>
${(inputs.imageCount ?? 0) > 0
  ? `This submission includes ${inputs.imageCount} source image(s) attached as additional content parts after this prompt. When verifying claims, inspect those images for visible evidence — a claim asserting "the dashboard breaks down cost per team" is supported_by_source if a screenshot visibly shows that breakdown. A claim asserting facts about a diagram or screenshot that are NOT actually visible in the attached image must be classified as unsupported.`
  : `No source images are attached for this submission. Verify against text only.`}
</image_verification_rule>

<rules>
- ONLY flag CONCRETE FACTUAL CLAIMS. Skip stylistic adjectives ("dangerously misleading"), generic FinOps principles ("FinOps requires culture change"), and uncontroversial truths.
- Specifically check: percentages, named tools/companies/teams/products, numerical counts (e.g. "22 anti-patterns"), claims about specific organizational structures, claims about specific named processes.
- Be skeptical: if a claim is specific enough to be falsifiable but you cannot find it in the inputs, classify as "unsupported".
- Maximum 15 claims per pass — focus on the most consequential.
- The strategy output below is divided into sections with [Persona: finops_lead | cfo | engineering_lead] headers, followed by REMEDIATION ROADMAP ACTIONS. For every claim you flag, tag "source_location" as the persona id the claim was found under, or "roadmap" if it was found in the roadmap actions block.
- For every claim classified "unsupported", you MUST additionally emit:
  - "failure_type": one of "fabricated_number" (invented %, $, count), "unverifiable_entity" (named tool / company / team / product not in source), "unsupported_org_claim" (assertion about org structure or behavior not in source), "out_of_scope" (claim about something the inputs simply do not address), or "other".
  - "missing_material": one short sentence describing what specific evidence in a future source document would make this claim supportable (e.g., "a tagging policy document", "a monthly cost review meeting note", "a named FinOps team headcount").
- Output JSON ONLY, no prose.
</rules>

<output_format>
{
  "claims": [
    {
      "claim": "exact phrase from the strategy output",
      "classification": "supported_by_source" | "supported_by_audit" | "unsupported",
      "rationale": "one short sentence",
      "source_location": "finops_lead | cfo | engineering_lead | roadmap",
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other (REQUIRED when classification is unsupported, otherwise omit)",
      "missing_material": "what additional source content would make this claim supportable (REQUIRED when classification is unsupported, otherwise omit)"
    }
  ]
}
</output_format>

<phase_2_metrics>
${compactMetrics(inputs.phase2)}
</phase_2_metrics>

<phase_1_evidence>
${compactEvidence(inputs.phase1)}
</phase_1_evidence>

<source_document>
${inputs.sourceDocument.substring(0, MAX_SOURCE_CHARS)}
</source_document>

<strategy_output_to_check>
EXECUTIVE SUMMARY:
${inputs.executiveSummary}

REMEDIATION ROADMAP ACTIONS:
${inputs.remediationRoadmapText}
</strategy_output_to_check>
`;

export const parseFactCheckResponse = (text: string, attempts: number): FactCheckResult => {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      attempts,
      total_claims: 0,
      supported_count: 0,
      unsupported_claims: [],
      failed: true,
      failure_reason: 'Fact-check response contained no JSON.'
    };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
    const validClaims: FactCheckClaim[] = claims
      .filter((c: any) => c && typeof c.claim === 'string' && typeof c.classification === 'string')
      .map((c: any) => {
        const classification = ['supported_by_source', 'supported_by_audit', 'unsupported'].includes(c.classification)
          ? c.classification
          : 'unsupported';
        const claim: FactCheckClaim = {
          claim: c.claim,
          classification,
          rationale: typeof c.rationale === 'string' ? c.rationale : ''
        };
        if (typeof c.source_location === 'string' && VALID_SOURCE_LOCATIONS.includes(c.source_location)) {
          claim.source_location = c.source_location;
        }
        if (classification === 'unsupported') {
          if (typeof c.failure_type === 'string' && VALID_FAILURE_TYPES.includes(c.failure_type)) {
            claim.failure_type = c.failure_type;
          }
          if (typeof c.missing_material === 'string' && c.missing_material.length > 0) {
            claim.missing_material = c.missing_material;
          }
        }
        return claim;
      });
    const unsupported = validClaims.filter(c => c.classification === 'unsupported');
    return {
      attempts,
      total_claims: validClaims.length,
      supported_count: validClaims.length - unsupported.length,
      unsupported_claims: unsupported,
      failed: false
    };
  } catch (e) {
    return {
      attempts,
      total_claims: 0,
      supported_count: 0,
      unsupported_claims: [],
      failed: true,
      failure_reason: 'Fact-check response was not valid JSON.'
    };
  }
};

const FAILURE_TYPE_GUIDANCE: Record<ClaimFailureType, string> = {
  fabricated_number: 'You invented a number not present in Phase 2 metrics or the source. Do not replace it with another invented number. Reference the relevant metric generically ("the audit shows significant burden") or omit the figure.',
  unverifiable_entity: 'You named a tool, team, company, or product not present in the source. Remove the named entity. Reference it generically ("the deployment pipeline", "the central team") or omit it.',
  unsupported_org_claim: 'You asserted something about the organization (structure, behavior, ownership) that is not in the source. Remove the assertion or qualify it as a recommended state, not a current one.',
  out_of_scope: 'You made a claim about something the source simply does not address. Do not address it at all in the regenerated output.',
  other: 'The claim could not be verified. Remove it or replace with a verified statement from the Phase 1 evidence.'
};

export const buildRegenerateAppendix = (unsupported: FactCheckClaim[]): string => {
  const grouped: Partial<Record<ClaimFailureType, FactCheckClaim[]>> = {};
  const ungrouped: FactCheckClaim[] = [];
  for (const c of unsupported) {
    if (c.failure_type) {
      (grouped[c.failure_type] ||= []).push(c);
    } else {
      ungrouped.push(c);
    }
  }

  const groupBlocks = (Object.keys(grouped) as ClaimFailureType[]).map(type => {
    const items = grouped[type]!;
    return `**Failure mode: ${type}** — ${FAILURE_TYPE_GUIDANCE[type]}
${items.map(c => `  - "${c.claim}"\n      Found in: ${c.source_location || 'unspecified'}\n      Reason: ${c.rationale}`).join('\n')}`;
  }).join('\n\n');

  const ungroupedBlock = ungrouped.length > 0
    ? `\n\n**Other unverified claims:**\n${ungrouped.map(c => `  - "${c.claim}"\n      Reason: ${c.rationale}`).join('\n')}`
    : '';

  return `

### REGENERATE INSTRUCTIONS — your previous output failed fact-check

A separate fact-check pass found these claims in your previous executive summaries or roadmap that were not supported by the source document or the verified Phase 1 evidence. Each is grouped by failure mode with specific guidance for how to fix it.

${groupBlocks}${ungroupedBlock}

Regenerate the executive summaries (all three personas) AND remediation roadmap. The new output:
- MUST NOT include any of the above claims, even rephrased.
- MUST follow the failure-mode-specific guidance above.
- MUST cite only facts that appear in <SOURCE_DOCUMENT_TO_AUDIT> or in the Phase 1 evidence quotes already provided.
- Prefer fewer specific claims over inventing replacements. It is better to be vague but truthful than precise but unsupported.
- Keep the exact same JSON output shape (executive_summaries with finops_lead / cfo / engineering_lead, visual_scorecard, remediation_roadmap).
`;
};
