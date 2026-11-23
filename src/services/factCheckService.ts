
import { FactCheckClaim, FactCheckResult, Phase1AuditLogs, Phase2Validation, ClaimFailureType, ClaimSeverity, ClaimSourceLocation, StrategicTactic, TacticActivityPlaybookEntry, TacticReviewDisposition } from '../types';

const VALID_FAILURE_TYPES: ClaimFailureType[] = ['fabricated_number', 'unverifiable_entity', 'unsupported_org_claim', 'out_of_scope', 'other'];
const VALID_SEVERITIES: ClaimSeverity[] = ['BLOCKING_UNSUPPORTED_FACT', 'BLOCKING_UNSAFE_ROADMAP', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE', 'SUPPORTED'];
const VALID_SOURCE_LOCATIONS: ClaimSourceLocation[] = ['finops_lead', 'cfo', 'engineering_lead', 'diagnosis', 'planning_decision', 'roadmap'];
const VALID_CLASSIFICATIONS = ['supported_by_source', 'supported_by_audit', 'supported_by_tactics_db', 'unsupported'] as const;
const VALID_TACTIC_DISPOSITIONS: TacticReviewDisposition[] = ['contraindicated', 'citation_rejected'];
const VALID_ROADMAP_TACTIC_DISPOSITIONS = ['not_applicable', ...VALID_TACTIC_DISPOSITIONS] as const;

export interface FactCheckParseContract {
  allowedClassifications: readonly string[];
  allowedSourceLocations: readonly ClaimSourceLocation[];
  allowedUnsupportedSeverities: readonly ClaimSeverity[];
  requireTacticDisposition?: boolean;
}

export const SUMMARY_FACT_CHECK_CONTRACT: FactCheckParseContract = {
  allowedClassifications: ['supported_by_source', 'supported_by_audit', 'unsupported'],
  allowedSourceLocations: ['finops_lead', 'cfo', 'engineering_lead', 'diagnosis'],
  allowedUnsupportedSeverities: ['BLOCKING_UNSUPPORTED_FACT', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE']
};

export const ROADMAP_FACT_CHECK_CONTRACT: FactCheckParseContract = {
  allowedClassifications: VALID_CLASSIFICATIONS,
  allowedSourceLocations: ['planning_decision', 'roadmap'],
  allowedUnsupportedSeverities: VALID_SEVERITIES.filter(severity => severity !== 'SUPPORTED'),
  requireTacticDisposition: true,
};

export type FactCheckRepairScope = 'summary' | 'roadmap' | 'both';

const SUMMARY_LOCATIONS = new Set<ClaimSourceLocation>(['finops_lead', 'cfo', 'engineering_lead', 'diagnosis']);
const ROADMAP_LOCATIONS = new Set<ClaimSourceLocation>(['planning_decision', 'roadmap']);

export const determineFactCheckRepairScope = (claims: FactCheckClaim[]): FactCheckRepairScope => {
  const hasSummaryDefect = claims.some(claim => claim.source_location && SUMMARY_LOCATIONS.has(claim.source_location));
  const hasRoadmapDefect = claims.some(claim => claim.source_location && ROADMAP_LOCATIONS.has(claim.source_location));
  if (hasSummaryDefect && !hasRoadmapDefect) return 'summary';
  if (hasRoadmapDefect && !hasSummaryDefect) return 'roadmap';
  return 'both';
};

export const claimsForRepairScope = (
  claims: FactCheckClaim[],
  scope: Exclude<FactCheckRepairScope, 'both'>
): FactCheckClaim[] => claims.filter(claim => scope === 'summary'
  ? Boolean(claim.source_location && SUMMARY_LOCATIONS.has(claim.source_location))
  : Boolean(claim.source_location && ROADMAP_LOCATIONS.has(claim.source_location)));

export interface FactCheckInputs {
  contentToCheck: string;
  remediationRoadmapText: string;
  sourceDocument: string;
  phase1: Phase1AuditLogs;
  phase2: Phase2Validation;
  acceptedFacts?: string;
  imageCount?: number;
  // Compact index of the Verified Tactics Database that the synthesis step
  // was instructed to draw from. Prescription claims (e.g. "modeled on
  // Spotify's tag governance" or "Implement [TAC-VIS-002]") are verified
  // against THIS, not the customer source document.
  tactics?: StrategicTactic[];
  tacticActivityPlaybook?: TacticActivityPlaybookEntry[];
}

export interface RoadmapFactCheckInputs extends FactCheckInputs {
  lockedFindingsText: string;
  excludedPremises?: string[];
}

const MAX_SOURCE_CHARS = 100000;

const CANONICAL_DOMAIN_TITLES: Record<string, string> = {
  A: 'Cost Visibility & Allocation',
  B: 'Rate & Usage Optimization',
  C: 'Governance & Policy',
  D: 'Architecture & Engineering',
  E: 'Culture & Organization',
  F: 'GenAI & AI Cost Management',
};

// Extract company names from a tactic's case_study field. Most entries follow
// "COMPANY: ..." but we also pick up any ALL-CAPS word (Spotify, Netflix etc.
// are usually capitalized) as a fallback.
const extractCompanies = (caseStudy: string): string[] => {
  if (!caseStudy) return [];
  const set = new Set<string>();
  const colon = caseStudy.match(/^([A-Z][A-Z0-9 &/.-]+):/);
  if (colon) set.add(colon[1].trim());
  for (const word of caseStudy.match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []) {
    if (word.length <= 30) set.add(word);
  }
  return Array.from(set);
};

const compactTactics = (tactics: StrategicTactic[] | undefined): string => {
  if (!tactics || tactics.length === 0) return '(no tactics database supplied)';
  return tactics.map(t => {
    const companies = extractCompanies(t.case_study);
    const companyList = companies.length > 0 ? companies.join(', ') : '(no named company)';
    return `${t.id} [${t.category}]: "${t.problem_pattern}" → companies: ${companyList}`;
  }).join('\n');
};

const compactTacticActivityPlaybook = (entries: TacticActivityPlaybookEntry[] | undefined): string => {
  if (!entries || entries.length === 0) return '(no tactic activity playbook supplied)';
  return entries.map(entry => [
    `${entry.tactic_id}: maturity=${entry.maturity_bindings.map(binding => `${binding.criterion_id}:${binding.relationship}`).join(', ')}; antipattern=${entry.antipattern_bindings.map(binding => `${binding.criterion_id}:${binding.relationship}`).join(', ')}`,
    `goal=${entry.activity_goal}`,
    `use_when=${entry.when_to_use.join('; ')}`,
    `do_not_use_when=${entry.when_not_to_use.join('; ')}`,
    `activities=${entry.implementation_activities.slice(0, 5).join('; ')}`,
    `artifacts=${entry.expected_artifacts.join(', ')}`,
    `semantic_hints=${entry.semantic_hints.join(', ')}`,
    `acceptance=${entry.acceptance_criteria.slice(0, 4).join('; ')}`,
    `risk_controls=${entry.risks_and_controls.join('; ')}`
  ].join('\n')).join('\n\n');
};

const compactMetrics = (phase2: Phase2Validation): string => {
  const m = phase2.metrics;
  const records = phase2.resolution_maturity?.criterion_resolutions || [];
  const overall = phase2.resolution_maturity?.overall;
  const categoryScoreLines = Object.entries(phase2.category_scores || {})
    .map(([category, score]) => {
      const hasScore = !records.some(r => r.domain_id === category && r.state === 'VERIFICATION_UNRESOLVED')
        && records.some(r => r.domain_id === category && r.stream === 'maturity' && r.state === 'RESOLVED');
      const title = CANONICAL_DOMAIN_TITLES[category];
      const label = title ? `${category} (${title})` : category;
      return `  ${label}: ${hasScore ? `${score}/15 (assessed points on domain surface)` : 'NA'}`;
    }).join('\n');
  return [
    `corroborated_maturity=${m.corroborated_maturity === null ? 'NA' : `${Math.round(m.corroborated_maturity)}%`}`,
    `observed_maturity=${m.observed_maturity === null ? 'NA' : `${Math.round(m.observed_maturity)}%`}`,
    `criterion_evidence_density=${phase2.assessment_sufficiency.criterion_evidence_density}% (${records.filter(r => r.state === 'RESOLVED').length}/${records.length} criteria assessed)`,
    `resolution_basis=${overall?.fully_resolved_pair_count ?? 'NA'} fully resolved and ${overall?.partially_resolved_pair_count ?? 'NA'} partially resolved of ${phase2.resolution_maturity?.pair_results?.length ?? 'NA'} pairs`,
    `capability_0/3_concentration=${m.maturity_zero_ratio == null ? 'NA' : Math.round(m.maturity_zero_ratio) + '%'} (${m.maturity_zero_count ?? 'NA'} of ${m.maturity_assessed_count ?? 'NA'} assessed maturity criteria scored 0/3)`,
    `antipattern_finding_rate=${m.antipattern_finding_ratio ?? 'NA'}% (${m.antipattern_finding_count ?? 'NA'} of ${records.filter(r => r.stream === 'antipattern').length} anti-pattern criteria)`,
    `assessment_resolution=${Math.round(m.assessment_resolution)}%`,
    `adjusted_finops_maturity=${m.adjusted_maturity === null ? 'NA' : `${Math.round(m.adjusted_maturity)}%`}`,
    `assessment_sufficiency=${phase2.assessment_sufficiency.decision}`,
    `assessment_sufficiency_warnings=${phase2.assessment_sufficiency.warning_reasons?.join(' | ') || 'none'}`,
    `silent_domains=${phase2.assessment_sufficiency.silent_domain_ids?.join(',') || 'none'}`,
    `domain_criterion_evidence_density=${Object.entries(phase2.assessment_sufficiency.domain_criterion_evidence_density || {}).map(([domain, density]) => `${domain}:${density}%`).join(',') || 'none'}`,
    `maturity_depth=${Math.round(m.maturity_depth)}%`,
    `antipattern_burden=${Math.round(m.antipattern_burden)}%`,
    `antipattern_burden_confidence=${m.antipattern_burden_confidence || 'unknown'}`,
    `antipattern_clearance=${Math.round(m.antipattern_clearance)}%`,
    `antipattern_coverage=${Math.round(m.antipattern_coverage)}%`,
    `maturity_ratio=${Math.round(m.maturity_ratio)}%`,
    `antipattern_ratio=${Math.round(m.antipattern_ratio)}%`,
    `delivery_integrity=${m.delivery_integrity}%`,
    `evidence_density=${m.evidence_density}%`,
    `classification=${phase2.crawl_walk_run}`,
    `silent_areas_count=${phase2.silent_areas.length}`,
    `score_evidence_gaps_count=${phase2.score_evidence_gaps.length}`,
    `maturity_gaps_count=${phase2.maturity_gaps.length}`,
    `antipattern_findings_count=${phase2.antipattern_findings.length}`,
    `verified_antipattern_absences_count=${phase2.verified_antipattern_absences.length}`,
    `unknown_antipattern_absences_count=${phase2.unknown_antipattern_absences.length}`,
  ].join(', ')
    + (categoryScoreLines ? `\nCategory scores:\n${categoryScoreLines}` : '');
};

// Preserve whole qualified statements. A clipped sentence can reverse a scope limit.
const compactDetail = (value: string | undefined, limit: number): string => {
  const text = value?.replace(/\s+/g, ' ').trim() || '';
  return text.length <= limit ? text : '';
};

export interface AcceptedCriterionBasis {
  details: string[];
  unknownStatus?: string;
}

export const buildAcceptedFacts = (phase1: Phase1AuditLogs, phase2: Phase2Validation) => {
  const basisByCriterion = new Map<string, AcceptedCriterionBasis>();
  const rows = (phase2.resolution_maturity?.criterion_resolutions || []).map(record => {
    const item = phase1[record.stream]?.[record.criterion_id];
    const key = `${record.stream}.${record.criterion_id}`;
    const label = `[${record.stream === 'antipattern' ? 'AP-' : ''}${record.criterion_id}]`;
    const scoped = phase2.scoped_observations?.find(observation => observation.startsWith(`${label} Scoped observation`));
    const quote = item?.evidence_quotes?.find(q => q.source_id && (q.chunk_id || q.derived_evidence_id) && q.quote);
    const locator = quote && compactDetail([quote.source_id, quote.derived_evidence_id || quote.chunk_id, quote.page_id].filter(Boolean).join('/'), 150);
    if (record.state !== 'RESOLVED') {
      const unknownStatus = `${record.state} | unscored | ${record.reason}`;
      basisByCriterion.set(key, { unknownStatus, details: [] });
      // Phase 2 can retain a bounded observation even when the anti-pattern
      // itself is unknown. Only that accepted observation may accompany it.
      const observed = record.state === 'UNKNOWN' && compactDetail(scoped, 550);
      return [key, unknownStatus, observed, observed && locator].filter(Boolean).join(' | ');
    }
    const basis = `${key} | assessed ${record.score_count}/3 | ${record.antipattern_absence_status || record.reason}`;
    const scope = compactDetail(item?.coverage_reason, 350);
    const reason = item?.adjustment_reason || item?.reasoning || item?.evidence;
    const rationale = compactDetail(reason, 680);
    if ((item?.coverage_reason && !scope) || (reason && !rationale)) {
      return [basis, 'scope detail withheld; omit narrative claim', locator].filter(Boolean).join(' | ');
    }
    const questions = item?.question_results?.join(', ');
    const excerpt = compactDetail(quote?.quote, 240);
    basisByCriterion.set(key, { details: [scope, rationale, excerpt].filter(Boolean) });
    return [basis, scoped && 'scoped observation; full criterion scope unverified', questions && `subcriteria: ${questions}`, scope, rationale, excerpt, locator]
      .filter((value, i, values) => value && values.indexOf(value) === i).join(' | ');
  });
  const text = [
    compactMetrics(phase2),
    'Accepted criterion facts. Limit each claim to its recorded scope. Omit claims whose supporting detail is unavailable. Unknown subcriteria are unverified.',
    ...rows,
  ].join('\n');
  return { text, basisByCriterion };
};

export const buildFactCheckPrompt = (inputs: FactCheckInputs): string => `
<role>
You are a fact-checker for a FinOps maturity assessment.
Your job: extract every distinct factual claim from the STRATEGY OUTPUT below, then classify each claim against the source material the strategy was generated from.
</role>

<classifications>
A claim must be verified against the correct source of truth depending on what kind of claim it is.

CURRENT-STATE CLAIMS (about the audited organization — what they have, what they do, what their numbers are):
- "supported_by_source": directly stated or clearly implied in the SOURCE_DOCUMENT, OR clearly visible in one of the attached SOURCE_IMAGES.
- "supported_by_audit": derived from PHASE_1_EVIDENCE or PHASE_2_METRICS (both produced by this engine from the source).

PRESCRIPTION CLAIMS (about external best-practice patterns the strategy is recommending — tactic IDs, mechanism names, named companies cited as exemplars):
- "supported_by_tactics_db": the claim references a tactic ID (e.g. "TAC-VIS-002"), mechanism, or company case study (e.g. "modeled on Spotify") that EXISTS in the VERIFIED_TACTICS_DB section below. This is a legitimate prescription pattern, NOT a hallucination. The synthesis step is explicitly instructed to use this database — these references are sanctioned.
  IMPORTANT: a company name (Spotify, Netflix, Airbnb, etc.) is supported_by_tactics_db ONLY if the database actually pairs that company with the specific tactic/mechanism being prescribed. "Implement TAC-VIS-002 modeled on Spotify" → supported only if TAC-VIS-002's case_study references Spotify. "Implement TAC-VIS-002 modeled on Datadog" → unsupported (Datadog not in the DB at all). "Implement TAC-OPT-001 modeled on Spotify" → unsupported (Spotify is in TAC-VIS-001's case study, not TAC-OPT-001's).

NEITHER:
- "unsupported": the claim cannot be traced to any of the three sources above. This includes invented numbers, named entities not in the source AND not in the tactics DB, organizational claims with no evidence, mismatched pairings (right company / wrong tactic), and confident assertions about facts not present in any input.
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
- The strategy output below is divided into persona evidence summaries (with [Persona: ...] headers), [Diagnosis], [Planning Decision], and REMEDIATION ROADMAP ACTIONS. For every claim you flag, tag "source_location" as the persona id, "diagnosis", "planning_decision", or "roadmap" based on where it was found.
- For every claim classified "unsupported", you MUST additionally emit:
  - "failure_type": one of "fabricated_number" (invented %, $, count), "unverifiable_entity" (named tool / company / team / product that is NOT in the source AND NOT in the VERIFIED_TACTICS_DB; legitimate KB-sanctioned references must be classified "supported_by_tactics_db" instead), "unsupported_org_claim" (assertion about org structure or behavior not in source), "out_of_scope" (claim about something the inputs simply do not address), or "other".
  - "severity": one of:
    - "BLOCKING_UNSUPPORTED_FACT" for fabricated numbers, invented current-state facts, unsupported org facts, or unverifiable entities.
    - "BLOCKING_UNSAFE_ROADMAP" for roadmap prescriptions that do not follow from locked findings, use invalid/mismatched tactic IDs, or introduce unsafe implementation claims.
    - "WARN_MISCLASSIFIED_BUT_REAL" when the underlying fact/gap is real but the output uses the wrong category, domain, anti-pattern label, or wording.
    - "WARN_TACTIC_HYGIENE" when the only problem is tactic citation placement/omission/removal while the action itself is grounded.
  - If a planning_decision contains tactic IDs but the action itself is grounded, classify as unsupported with severity "WARN_TACTIC_HYGIENE", not blocking.
  - If a roadmap action is grounded in locked findings but has no tactic ID, do NOT flag it; no tactic ID is better than a wrong tactic ID.
  - "missing_material": one short sentence describing what specific evidence in a future source document would make this claim supportable (e.g., "a tagging policy document", "a monthly cost review meeting note", "a named FinOps team headcount").
- Output JSON ONLY, no prose.
</rules>

<output_format>
{
  "claims": [
    {
      "claim": "exact phrase from the strategy output",
      "classification": "supported_by_source" | "supported_by_audit" | "supported_by_tactics_db" | "unsupported",
      "rationale": "one short sentence",
      "source_location": "finops_lead | cfo | engineering_lead | diagnosis | planning_decision | roadmap",
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other (REQUIRED when classification is unsupported, otherwise omit)",
      "severity": "BLOCKING_UNSUPPORTED_FACT | BLOCKING_UNSAFE_ROADMAP | WARN_MISCLASSIFIED_BUT_REAL | WARN_TACTIC_HYGIENE | SUPPORTED",
      "missing_material": "what additional source content would make this claim supportable (REQUIRED when classification is unsupported, otherwise omit)"
    }
  ]
}
</output_format>

<accepted_phase_1_and_2_facts>
${inputs.acceptedFacts ?? buildAcceptedFacts(inputs.phase1, inputs.phase2).text}
</accepted_phase_1_and_2_facts>

<verified_tactics_db>
${compactTactics(inputs.tactics)}
</verified_tactics_db>

<source_document>
${inputs.sourceDocument.substring(0, MAX_SOURCE_CHARS)}
</source_document>

<strategy_output_to_check>
EXECUTIVE SUMMARY:
${inputs.contentToCheck}

REMEDIATION ROADMAP ACTIONS:
${inputs.remediationRoadmapText}
</strategy_output_to_check>
`;

export const parseFactCheckResponse = (
  text: string,
  attempts: number,
  contract: FactCheckParseContract = {
    allowedClassifications: VALID_CLASSIFICATIONS,
    allowedSourceLocations: VALID_SOURCE_LOCATIONS,
    allowedUnsupportedSeverities: VALID_SEVERITIES.filter(severity => severity !== 'SUPPORTED')
  },
  onVerifiedClaims?: (claims: FactCheckClaim[]) => void,
): FactCheckResult => {
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
    if (!Array.isArray(parsed?.claims) || parsed.claims.length === 0) {
      return {
        attempts,
        total_claims: 0,
        supported_count: 0,
        unsupported_claims: [],
        failed: true,
        failure_reason: 'Fact-check response contained no claim verdicts for non-empty strategy content.'
      };
    }

    const invalidIndex = parsed.claims.findIndex((c: any) => {
      if (!c || typeof c !== 'object') return true;
      if (typeof c.claim !== 'string' || c.claim.trim().length === 0) return true;
      if (!contract.allowedClassifications.includes(c.classification)) return true;
      if (typeof c.rationale !== 'string' || c.rationale.trim().length === 0) return true;
      if (typeof c.source_location !== 'string' || !contract.allowedSourceLocations.includes(c.source_location)) return true;
      if (contract.requireTacticDisposition
        && !VALID_ROADMAP_TACTIC_DISPOSITIONS.includes(c.tactic_disposition)) return true;
      if (c.classification !== 'unsupported') return c.severity != null && c.severity !== 'SUPPORTED';
      return typeof c.failure_type !== 'string'
        || !VALID_FAILURE_TYPES.includes(c.failure_type)
        || typeof c.severity !== 'string'
        || !contract.allowedUnsupportedSeverities.includes(c.severity)
        || typeof c.missing_material !== 'string'
        || c.missing_material.trim().length === 0;
    });
    if (invalidIndex >= 0) {
      return {
        attempts,
        total_claims: 0,
        supported_count: 0,
        unsupported_claims: [],
        failed: true,
        failure_reason: `Fact-check response contained a malformed claim verdict at index ${invalidIndex}.`
      };
    }

    const validClaims: FactCheckClaim[] = parsed.claims.map((c: any) => ({
      claim: c.claim.trim(),
      classification: c.classification,
      rationale: c.rationale.trim(),
      source_location: c.source_location,
      severity: c.classification === 'unsupported' ? c.severity : 'SUPPORTED',
      ...(c.classification === 'unsupported' ? {
        failure_type: c.failure_type,
        missing_material: c.missing_material.trim(),
        ...(VALID_TACTIC_DISPOSITIONS.includes(c.tactic_disposition) ? { tactic_disposition: c.tactic_disposition } : {}),
      } : {})
    }));
    onVerifiedClaims?.(validClaims.filter(c => c.classification === 'supported_by_source' || c.classification === 'supported_by_audit'));
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

export const mergeRequiredFactChecks = (
  summary: FactCheckResult,
  roadmap: FactCheckResult,
  attemptNumber: number
): FactCheckResult => {
  const failureReason = [
    summary.failed ? `summary: ${summary.failure_reason || 'verification failed'}` : '',
    roadmap.failed ? `roadmap: ${roadmap.failure_reason || 'verification failed'}` : ''
  ].filter(Boolean).join(' | ');

  if (summary.failed || roadmap.failed) {
    return {
      attempts: attemptNumber,
      total_claims: 0,
      supported_count: 0,
      unsupported_claims: [],
      failed: true,
      failure_reason: failureReason
    };
  }

  return {
    attempts: attemptNumber,
    total_claims: summary.total_claims + roadmap.total_claims,
    supported_count: summary.supported_count + roadmap.supported_count,
    unsupported_claims: [...summary.unsupported_claims, ...roadmap.unsupported_claims],
    failed: false
  };
};

const FAILURE_TYPE_GUIDANCE: Record<ClaimFailureType, string> = {
  fabricated_number: 'You invented a number not present in Phase 2 metrics or the source. Do not replace it with another invented number. Reference the relevant metric generically ("the audit shows significant burden") or omit the figure.',
  unverifiable_entity: 'You named a tool, team, company, or product that is NOT in the source AND NOT in the Verified Tactics Database. Legitimate KB-sanctioned references (tactic IDs like [TAC-VIS-002], or companies paired with their actual tactic in the database) are allowed — DO NOT strip those. For the flagged items below, the entity is genuinely not in any source: remove it, reference it generically ("the deployment pipeline", "the central team"), or replace with a verified tactic ID from the database.',
  unsupported_org_claim: 'You asserted something about the organization (structure, behavior, ownership) that is not in the source. Remove the assertion or qualify it as a recommended state, not a current one.',
  out_of_scope: 'You made a claim about something the source simply does not address. Do not address it at all in the regenerated output.',
  other: 'The claim could not be verified. Remove it or replace with a verified statement from the Phase 1 evidence.'
};

export const buildRegenerateAppendix = (
  unsupported: FactCheckClaim[],
  scope: FactCheckRepairScope = 'both'
): string => {
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

  const regenerationInstruction = scope === 'summary'
    ? 'Regenerate ONLY executive_summaries, evidence_summary, diagnosis, and visual_scorecard. The existing planning decision and remediation roadmap are locked and must not be rewritten.'
    : scope === 'roadmap'
      ? 'Regenerate ONLY planning_decision and remediation_roadmap. The existing executive summaries, evidence summary, diagnosis, and visual scorecard are locked and must not be rewritten.'
      : 'Regenerate both the evidence-summary/diagnosis section and the planning-decision/roadmap section because defects cross both contracts.';

  return `

### REGENERATE INSTRUCTIONS — your previous output failed fact-check

A separate split fact-check pass found these claims in your previous output. Evidence summaries and diagnosis are verified ONLY against the source document, Phase 1 evidence, and Phase 2 metrics. Planning decisions and roadmap actions are verified against the locked findings plus the Verified Tactics Database. Each issue is grouped by failure mode with specific guidance for how to fix it.

${groupBlocks}${ungroupedBlock}

${regenerationInstruction} The repaired output:
- MUST NOT include any of the above claims, even rephrased.
- MUST follow the failure-mode-specific guidance above.
- Evidence summaries and diagnosis MUST cite only facts that appear in <SOURCE_DOCUMENT_TO_AUDIT>, Phase 1 evidence quotes, or Phase 2 metrics. Do not use tactics DB knowledge there.
- Planning decisions and roadmap actions MUST trace to the locked findings and may use only tactic IDs/companies actually paired in the Verified Tactics Database.
- Prefer fewer specific claims over inventing replacements. It is better to be vague but truthful than precise but unsupported.
- Keep the exact JSON shape required by the scoped output contract.
`;
};


export const buildSummaryFactCheckPrompt = (inputs: FactCheckInputs): string => `
<role>
You are the evidence-summary fact-checker for a FinOps maturity assessment.
Your job: verify ONLY the evidence summaries and diagnosis. The tactics database is intentionally absent because summaries must be grounded only in source evidence and Phase 1/2 findings.
</role>

<classifications>
- "supported_by_source": directly stated or clearly implied in SOURCE_DOCUMENT or visible in attached SOURCE_IMAGES.
- "supported_by_audit": derived from PHASE_1_EVIDENCE or PHASE_2_METRICS.
- "unsupported": cannot be traced to source, Phase 1 evidence, or Phase 2 metrics.
- Do NOT use "supported_by_tactics_db" in this check. If a summary/diagnosis uses tactic IDs, external case studies, or KB-only facts, classify the claim as unsupported.
</classifications>

<rules>
- Check only current-state and diagnostic claims in the evidence summaries and diagnosis.
- Be especially skeptical of claims about organizational ownership, executive sponsorship, culture, tooling adoption, team behavior, savings, and root causes.
- If the source appears to be a best-practices or case-study document rather than evidence about the audited organization, flag claims that treat document coverage as proven operational adoption.
- If the underlying source fact is real but the output assigns the wrong category/domain/anti-pattern label, classify unsupported with severity "WARN_MISCLASSIFIED_BUT_REAL" rather than a blocking fact.
- If Phase 1/2 marks a criterion unsupported, verification_unresolved, or not_assessed, flag wording that calls the criterion a confirmed weak, partial, missing, or immature control. It is an evidence/verification gap unless separate assessed evidence establishes the deficiency.
- Maximum 15 claims per pass — focus on consequential claims.
- For every unsupported claim, emit failure_type, severity, and missing_material.
- For supported claims, emit severity "SUPPORTED", failure_type "not_applicable", and an empty missing_material string.
- Output JSON ONLY, no prose.
</rules>

<output_format>
{
  "claims": [
    {
      "claim": "exact phrase from the summary or diagnosis",
      "classification": "supported_by_source | supported_by_audit | unsupported",
      "rationale": "one short sentence",
      "source_location": "finops_lead | cfo | engineering_lead | diagnosis",
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other | not_applicable",
      "severity": "BLOCKING_UNSUPPORTED_FACT | WARN_MISCLASSIFIED_BUT_REAL | WARN_TACTIC_HYGIENE | SUPPORTED",
      "missing_material": "what evidence would make this claim supportable (REQUIRED when unsupported)"
    }
  ]
}
</output_format>

<accepted_phase_1_and_2_facts>
${inputs.acceptedFacts ?? buildAcceptedFacts(inputs.phase1, inputs.phase2).text}
</accepted_phase_1_and_2_facts>

<source_document>
${inputs.sourceDocument.substring(0, MAX_SOURCE_CHARS)}
</source_document>

<summary_and_diagnosis_to_check>
${inputs.contentToCheck}
</summary_and_diagnosis_to_check>
`;

export const buildRoadmapFactCheckPrompt = (inputs: RoadmapFactCheckInputs): string => `
<role>
You are the roadmap-grounding reviewer for a FinOps maturity assessment.
Your job: verify that the planning decision and roadmap are logical, grounded responses to the LOCKED FINDINGS, and that any tactic references are valid in the Verified Tactics Database.
</role>

<classifications>
ROADMAP GROUNDING:
- "supported_by_audit": the action or planning rationale logically follows from LOCKED_FINDINGS, PHASE_1_EVIDENCE, or PHASE_2_METRICS.
- "supported_by_source": the action or rationale is directly supported by the SOURCE_DOCUMENT.
- "supported_by_tactics_db": tactic IDs, mechanism names, named case-study references, and implementation activity details are valid and correctly paired in VERIFIED_TACTICS_DB or TACTIC_ACTIVITY_PLAYBOOK.
- "unsupported": the roadmap action, planning rationale, or tactic reference does not trace to locked findings/evidence, uses a mismatched tactic/company pairing, or introduces a new current-state claim not present in LOCKED_FINDINGS.
</classifications>

<rules>
- Do NOT re-score the evidence summary. Treat LOCKED_FINDINGS as the current-state baseline.
- Check each planning rationale, safe-to-act item, evidence request, Why, What, action and assumption against surviving customer evidence. Excluded premises and their paraphrases cannot justify any statement, even if repeated in LOCKED_FINDINGS. A shared criterion ID or an applicable tactic alone cannot establish the premise. A narrower review may stand on the accepted evidence for the same criterion.
- For independently supported statements that share a criterion or topic with <excluded_premises>, return the entire field or list item verbatim as the claim (without any leading "- " markdown bullet prefix). Classify full statements grounded in surviving customer/audit evidence as "supported_by_audit" or "supported_by_source" (even when the action also cites a valid [TAC-*] ID; reserve "supported_by_tactics_db" for standalone tactic-lookup checks when <excluded_premises> is empty). Do NOT emit supported verdicts for unaffected statements on unrelated criteria — those survive automatically. In the rationale cite the exact stream and criterion followed by a short verbatim supporting excerpt in double quotes, e.g. maturity.B1 "monthly utilization review of the sampled reservation". Supply each material criterion and check scope and qualifiers. For an evidence request grounded in an unknown, quote its complete status (UNKNOWN | unscored | NO_GOVERNED_EVIDENCE). For unsupported statements, flag the unsupported premise or action. Prioritize affected statements within the claim limit.
- Ask: do the WHY, WHAT, and HOW sections answer the findings? If a phase rationale, intended outcome, or action does not address a confirmed gap, anti-pattern, missing-evidence item, or diagnosis statement, classify it as unsupported.
- Planning decision must be proportionate to confidence. If the plan says GO while locked findings contain major uncertainty, unsupported claims, or evidence gaps, flag the GO rationale as unsupported or overconfident.
- Tactic IDs are allowed only in roadmap actions and must exist in the tactics DB.
- If tactic IDs appear in the planning decision but the underlying action is grounded, classify the issue as unsupported with severity "WARN_TACTIC_HYGIENE" instead of a blocking roadmap failure.
- A grounded roadmap action may have zero tactic IDs when no exact tactics DB match exists. Do not flag zero tactic IDs by itself.
- Activity-playbook details support roadmap HOW language only. They do not support new claims about what the audited organization currently has or does.
- If the action is grounded but the output uses a wrong label/category for the finding, classify unsupported with severity "WARN_MISCLASSIFIED_BUT_REAL".
- If a criterion is unsupported, verification_unresolved, or not_assessed, the roadmap may collect evidence for it but may not describe it as a confirmed weak/partial control or prescribe deficiency remediation without another assessed locked finding.
- Evaluate each required tactic's supplied use and do-not-use conditions. If locked findings establish a supplied Playbook do-not-use condition or directly refute the tactic's supplied use_when condition through verified customer controls, classify the tactic action as unsupported with severity "WARN_TACTIC_HYGIENE" so it can be recorded as contraindicated rather than forced into the final roadmap.
- Every claim MUST set "tactic_disposition". For an unsupported roadmap claim with severity "WARN_TACTIC_HYGIENE" that contains a tactic ID, use "contraindicated" only when a supplied Playbook do-not-use condition is established by locked findings or when verified customer controls in locked findings directly refute the tactic's supplied use_when condition; otherwise use "citation_rejected" for a misplaced, mismatched, or unsupported tactic reference. For every other claim use "not_applicable".
- WHY and WHAT may summarize context and intended change, but they may not invent new current-state claims, unsupported financial impacts, or claim that a gap is fully closed unless LOCKED_FINDINGS provide acceptance criteria proving closure.
- ${(inputs.excludedPremises?.length || 0) > 0 ? 'Maximum 25 claims per pass when <excluded_premises> is non-empty: report unsupported claims plus verbatim supported verdicts ONLY for surviving statements that touch an excluded premise or its criterion.' : 'Maximum 15 claims per pass — focus on consequential grounding errors.'}
- For every unsupported claim, emit failure_type, severity, and missing_material.
- For supported claims, emit severity "SUPPORTED", failure_type "not_applicable", and an empty missing_material string.
- Output JSON ONLY, no prose.
</rules>

<output_format>
{
  "claims": [
    {
      "claim": "exact phrase from planning decision or roadmap",
      "classification": "supported_by_source | supported_by_audit | supported_by_tactics_db | unsupported",
      "rationale": "one short sentence",
      "source_location": "planning_decision | roadmap",
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other | not_applicable",
      "severity": "BLOCKING_UNSUPPORTED_FACT | BLOCKING_UNSAFE_ROADMAP | WARN_MISCLASSIFIED_BUT_REAL | WARN_TACTIC_HYGIENE | SUPPORTED",
      "tactic_disposition": "not_applicable | contraindicated | citation_rejected (REQUIRED; use not_applicable unless this is an unsupported roadmap WARN_TACTIC_HYGIENE claim containing a tactic ID)",
      "missing_material": "what evidence or locked finding would make this supportable (REQUIRED when unsupported)"
    }
  ]
}
</output_format>

<excluded_premises>
${JSON.stringify(inputs.excludedPremises || [])}
</excluded_premises>

<locked_findings>
${inputs.lockedFindingsText}
</locked_findings>

<accepted_phase_1_and_2_facts>
${inputs.acceptedFacts ?? buildAcceptedFacts(inputs.phase1, inputs.phase2).text}
</accepted_phase_1_and_2_facts>

<verified_tactics_db>
${compactTactics(inputs.tactics)}
</verified_tactics_db>

<tactic_activity_playbook>
${compactTacticActivityPlaybook(inputs.tacticActivityPlaybook)}
</tactic_activity_playbook>

<source_document>
${inputs.sourceDocument.substring(0, MAX_SOURCE_CHARS)}
</source_document>

<planning_and_roadmap_to_check>
PLANNING DECISION:
${inputs.contentToCheck}

REMEDIATION ROADMAP ACTIONS:
${inputs.remediationRoadmapText}
</planning_and_roadmap_to_check>
`;
