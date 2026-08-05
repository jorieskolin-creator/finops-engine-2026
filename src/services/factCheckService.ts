
import { AuditItem, FactCheckClaim, FactCheckResult, Phase1AuditLogs, Phase2Validation, ClaimFailureType, ClaimSeverity, ClaimSourceLocation, StrategicTactic, TacticActivityPlaybookEntry } from '../types';

const VALID_FAILURE_TYPES: ClaimFailureType[] = ['fabricated_number', 'unverifiable_entity', 'unsupported_org_claim', 'out_of_scope', 'other'];
const VALID_SEVERITIES: ClaimSeverity[] = ['BLOCKING_UNSUPPORTED_FACT', 'BLOCKING_UNSAFE_ROADMAP', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE', 'SUPPORTED'];
const VALID_SOURCE_LOCATIONS: ClaimSourceLocation[] = ['finops_lead', 'cfo', 'engineering_lead', 'diagnosis', 'planning_decision', 'roadmap'];
const VALID_CLASSIFICATIONS = ['supported_by_source', 'supported_by_audit', 'supported_by_tactics_db', 'unsupported'] as const;

export interface FactCheckParseContract {
  allowedClassifications: readonly string[];
  allowedSourceLocations: readonly ClaimSourceLocation[];
  allowedUnsupportedSeverities: readonly ClaimSeverity[];
}

export const SUMMARY_FACT_CHECK_CONTRACT: FactCheckParseContract = {
  allowedClassifications: ['supported_by_source', 'supported_by_audit', 'unsupported'],
  allowedSourceLocations: ['finops_lead', 'cfo', 'engineering_lead', 'diagnosis'],
  allowedUnsupportedSeverities: ['BLOCKING_UNSUPPORTED_FACT', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE']
};

export const ROADMAP_FACT_CHECK_CONTRACT: FactCheckParseContract = {
  allowedClassifications: VALID_CLASSIFICATIONS,
  allowedSourceLocations: ['planning_decision', 'roadmap'],
  allowedUnsupportedSeverities: VALID_SEVERITIES.filter(severity => severity !== 'SUPPORTED')
};

export interface FactCheckInputs {
  contentToCheck: string;
  remediationRoadmapText: string;
  sourceDocument: string;
  phase1: Phase1AuditLogs;
  phase2: Phase2Validation;
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
    `${entry.tactic_id}: maturity=${entry.maturity_criteria.join(', ')}; antipattern=${entry.antipattern_criteria.join(', ')}`,
    `goal=${entry.activity_goal}`,
    `activities=${entry.implementation_activities.slice(0, 5).join('; ')}`,
    `artifacts=${entry.expected_artifacts.join(', ')}`,
    `acceptance=${entry.acceptance_criteria.slice(0, 4).join('; ')}`
  ].join('\n')).join('\n\n');
};

const compactMetrics = (phase2: Phase2Validation): string => {
  const m = phase2.metrics;
  const categoryScoreLines = Object.entries(phase2.category_scores || {})
    .map(([cat, score]) => `  ${cat}: ${score}/15`)
    .join('\n');
  return [
    `finops_readiness=${Math.round(m.finops_readiness)}%`,
    `maturity_depth=${Math.round(m.maturity_depth)}%`,
    `antipattern_burden=${Math.round(m.antipattern_burden)}%`,
    `antipattern_clearance=${Math.round(m.antipattern_clearance)}%`,
    `antipattern_coverage=${Math.round(m.antipattern_coverage)}%`,
    `maturity_ratio=${Math.round(m.maturity_ratio)}%`,
    `antipattern_ratio=${Math.round(m.antipattern_ratio)}%`,
    `delivery_integrity=${m.delivery_integrity}%`,
    `evidence_density=${m.evidence_density}%`,
    `classification=${phase2.crawl_walk_run}`,
    `silent_areas_count=${phase2.silent_areas.length}`,
    `maturity_gaps_count=${phase2.maturity_gaps.length}`,
    `antipattern_findings_count=${phase2.antipattern_findings.length}`,
    `verified_antipattern_absences_count=${phase2.verified_antipattern_absences.length}`,
    `unknown_antipattern_absences_count=${phase2.unknown_antipattern_absences.length}`,
  ].join(', ') + (categoryScoreLines ? `\n\nCATEGORY SCORES (these are the X/15 numbers the strategy may legitimately quote):\n${categoryScoreLines}` : '');
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

<phase_2_metrics>
${compactMetrics(inputs.phase2)}
</phase_2_metrics>

<phase_1_evidence>
${compactEvidence(inputs.phase1)}
</phase_1_evidence>

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
  }
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
      } : {})
    }));
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

A separate split fact-check pass found these claims in your previous output. Evidence summaries and diagnosis are verified ONLY against the source document, Phase 1 evidence, and Phase 2 metrics. Planning decisions and roadmap actions are verified against the locked findings plus the Verified Tactics Database. Each issue is grouped by failure mode with specific guidance for how to fix it.

${groupBlocks}${ungroupedBlock}

Regenerate the evidence summaries (all three personas), diagnosis, planning decision, AND remediation roadmap. The new output:
- MUST NOT include any of the above claims, even rephrased.
- MUST follow the failure-mode-specific guidance above.
- Evidence summaries and diagnosis MUST cite only facts that appear in <SOURCE_DOCUMENT_TO_AUDIT>, Phase 1 evidence quotes, or Phase 2 metrics. Do not use tactics DB knowledge there.
- Planning decisions and roadmap actions MUST trace to the locked findings and may use only tactic IDs/companies actually paired in the Verified Tactics Database.
- Prefer fewer specific claims over inventing replacements. It is better to be vague but truthful than precise but unsupported.
- Keep the exact same JSON output shape (executive_summaries with finops_lead / cfo / engineering_lead, evidence_summary, diagnosis, planning_decision, visual_scorecard, remediation_roadmap).
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
- Maximum 15 claims per pass — focus on consequential claims.
- For every unsupported claim, emit failure_type, severity, and missing_material.
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
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other (REQUIRED when unsupported)",
      "severity": "BLOCKING_UNSUPPORTED_FACT | WARN_MISCLASSIFIED_BUT_REAL | WARN_TACTIC_HYGIENE | SUPPORTED",
      "missing_material": "what evidence would make this claim supportable (REQUIRED when unsupported)"
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
- Ask: do the WHY, WHAT, and HOW sections answer the findings? If a phase rationale, intended outcome, or action does not address a confirmed gap, anti-pattern, missing-evidence item, or diagnosis statement, classify it as unsupported.
- Planning decision must be proportionate to confidence. If the plan says GO while locked findings contain major uncertainty, unsupported claims, or evidence gaps, flag the GO rationale as unsupported or overconfident.
- Tactic IDs are allowed only in roadmap actions and must exist in the tactics DB.
- If tactic IDs appear in the planning decision but the underlying action is grounded, classify the issue as unsupported with severity "WARN_TACTIC_HYGIENE" instead of a blocking roadmap failure.
- A grounded roadmap action may have zero tactic IDs when no exact tactics DB match exists. Do not flag zero tactic IDs by itself.
- Activity-playbook details support roadmap HOW language only. They do not support new claims about what the audited organization currently has or does.
- If the action is grounded but the output uses a wrong label/category for the finding, classify unsupported with severity "WARN_MISCLASSIFIED_BUT_REAL".
- WHY and WHAT may summarize context and intended change, but they may not invent new current-state claims, unsupported financial impacts, or claim that a gap is fully closed unless LOCKED_FINDINGS provide acceptance criteria proving closure.
- Maximum 15 claims per pass — focus on consequential grounding errors.
- For every unsupported claim, emit failure_type, severity, and missing_material.
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
      "failure_type": "fabricated_number | unverifiable_entity | unsupported_org_claim | out_of_scope | other (REQUIRED when unsupported)",
      "severity": "BLOCKING_UNSUPPORTED_FACT | BLOCKING_UNSAFE_ROADMAP | WARN_MISCLASSIFIED_BUT_REAL | WARN_TACTIC_HYGIENE | SUPPORTED",
      "missing_material": "what evidence or locked finding would make this supportable (REQUIRED when unsupported)"
    }
  ]
}
</output_format>

<locked_findings>
${inputs.lockedFindingsText}
</locked_findings>

<phase_2_metrics>
${compactMetrics(inputs.phase2)}
</phase_2_metrics>

<phase_1_evidence>
${compactEvidence(inputs.phase1)}
</phase_1_evidence>

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
