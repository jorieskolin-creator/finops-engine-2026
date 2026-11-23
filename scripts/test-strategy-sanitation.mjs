import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-strategy-sanitation-'));
await writeFile(join(dir, 'modelRouter.mjs'), 'export const runStage = async () => ({ text: "{}", modelUsed: { id: "stub" } });\n', 'utf8');

const qualityGateSource = (await readFile(new URL('../src/services/qualityGateService.ts', import.meta.url), 'utf8')).replace(
  "import { FINOPS_CRITERIA } from '../knowledge_base';",
  'const FINOPS_CRITERIA = Array(30);'
);
await writeFile(
  join(dir, 'qualityGateService.mjs'),
  compile(qualityGateSource).replace("from './modelRouter'", "from './modelRouter.mjs'"),
  'utf8'
);

const sanitationSource = await readFile(new URL('../src/services/strategySanitationService.ts', import.meta.url), 'utf8');
await writeFile(
  join(dir, 'strategySanitationService.mjs'),
  compile(sanitationSource).replace("from './qualityGateService'", "from './qualityGateService.mjs'"),
  'utf8'
);

const { runQualityGate } = await import(`file://${join(dir, 'qualityGateService.mjs')}`);
const {
  buildDeterministicBlockedFindingsStrategy,
  sanitizeBlockedStrategy,
  sanitizeEvidenceSummaryUncertainty,
  sanitizeStrategyAfterFactCheck,
} = await import(`file://${join(dir, 'strategySanitationService.mjs')}`);

const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(batch => [1, 2, 3, 4, 5].map(n => `${batch}${n}`));
const emptyItem = {
  count: 0,
  status: 'NOK',
  evidence: 'Document is silent.',
  evidence_quotes: [],
  reasoning: 'Not found.'
};
const phase1 = {
  maturity: Object.fromEntries(ids.map(id => [id, emptyItem])),
  antipattern: Object.fromEntries(ids.map(id => [id, { ...emptyItem, status: 'OK' }]))
};
const validationOk = { valid: true, errors: [], warnings: [] };
const evidenceCheckOk = {
  total_items: 60,
  supported_count: 60,
  weak_count: 0,
  unsupported_count: 0,
  missing_count: 0,
  downgraded_count: 0,
  rescan_count: 0,
  items: [],
  adjustments: [],
  failed: false
};
const strongPhase2 = {
  metrics: { evidence_density: 92, antipattern_coverage: 92 },
  silent_areas: [],
};

const strategyData = {
  phase_3_strategy: {
    executive_summaries: {
      cfo: 'The anti-pattern burden is confirmed at 7%, meaning a material but bounded share of cloud spend is affected by identified inefficiency patterns. Governance is otherwise documented.'
    },
    diagnosis: {
      primary_bottleneck: 'The bottleneck is known.',
      root_causes: ['Known gap.'],
      domain_diagnosis: {},
      confidence: 'medium',
      confidence_rationale: 'Supported.'
    },
    planning_decision: { decision: 'CONDITIONAL_GO', rationale: 'Proceed carefully.', safe_to_act_on: [], evidence_needed_before_action: [] },
    remediation_roadmap: [
      {
        phase: '1. Crawl',
        why: 'Implement FinOps outcome tracking to shift measurement from documented activities toward quantified optimization outcomes.',
        what: 'Enforce object storage lifecycle tiering for product telemetry while preserving validated operational controls.',
        actions: [
          'Implement FinOps outcome tracking to shift measurement from documented activities toward quantified optimization outcomes.',
          'Enforce object storage lifecycle tiering for product telemetry.'
        ]
      }
    ]
  }
};

const factCheck = {
  attempts: 3,
  total_claims: 3,
  supported_count: 0,
  failed: false,
  unsupported_claims: [
    {
      claim: 'The anti-pattern burden is confirmed at 7%, meaning a material but bounded share of cloud spend is affected by identified inefficiency patterns.',
      classification: 'unsupported',
      source_location: 'cfo',
      failure_type: 'fabricated_number',
      severity: 'BLOCKING_UNSUPPORTED_FACT',
      rationale: 'Phase 2 defines a 7% anti-pattern burden but does not state that this percentage represents share of cloud spend.'
    },
    {
      claim: 'Implement FinOps outcome tracking to shift measurement from documented activities toward quantified optimization outcomes.',
      classification: 'unsupported',
      source_location: 'roadmap',
      failure_type: 'unsupported_org_claim',
      severity: 'BLOCKING_UNSUPPORTED_FACT',
      rationale: 'The locked findings already include quantified optimization outcomes.'
    },
    {
      claim: 'Unit economics coverage incomplete — only two metrics defined.',
      classification: 'unsupported',
      source_location: 'diagnosis',
      failure_type: 'unsupported_org_claim',
      severity: 'WARN_MISCLASSIFIED_BUT_REAL',
      rationale: 'The underlying gap is real, but it is not a confirmed anti-pattern.'
    }
  ]
};

const hygieneStrategyData = {
  phase_3_strategy: {
    executive_summaries: {
      cfo: 'The confirmed anti-pattern is low-severity anomaly escalation, and every confirmed gap maps to exact verified tactics database patterns.'
    },
    diagnosis: {
      primary_bottleneck: 'The confirmed anti-pattern is low-severity anomaly escalation.',
      root_causes: ['Every confirmed gap maps to exact verified tactics database patterns.'],
      domain_diagnosis: {},
      confidence: 'medium',
      confidence_rationale: 'Supported.'
    },
    planning_decision: { decision: 'CONDITIONAL_GO', rationale: 'Proceed carefully.', safe_to_act_on: [], evidence_needed_before_action: [] },
    remediation_roadmap: []
  }
};

const hygieneSanitized = sanitizeStrategyAfterFactCheck(hygieneStrategyData, {
  attempts: 1,
  total_claims: 2,
  supported_count: 0,
  failed: false,
  unsupported_claims: [
    {
      claim: 'The confirmed anti-pattern is low-severity anomaly escalation.',
      classification: 'unsupported',
      source_location: 'diagnosis',
      failure_type: 'unsupported_org_claim',
      severity: 'WARN_MISCLASSIFIED_BUT_REAL',
      rationale: 'The underlying finding is real, but the anti-pattern label is not supported.'
    },
    {
      claim: 'Every confirmed gap maps to exact verified tactics database patterns.',
      classification: 'unsupported',
      source_location: 'diagnosis',
      failure_type: 'unsupported_org_claim',
      severity: 'WARN_TACTIC_HYGIENE',
      rationale: 'The findings do not prove an exact KB tactic match for every gap.'
    }
  ]
});
assert.equal(hygieneSanitized.sanitized.length, 2);
assert.equal(hygieneSanitized.factCheck.unsupported_claims.length, 0);
assert.doesNotMatch(JSON.stringify(hygieneSanitized.strategyData), /low-severity anomaly escalation/);
assert.doesNotMatch(JSON.stringify(hygieneSanitized.strategyData), /exact verified tactics database patterns/);

const contraindicatedTacticClaim = 'The engineering platform owner will extend [TAC-ARCH-002] from platform pull requests to product repositories [D2].';
const roadmapHygieneSanitized = sanitizeStrategyAfterFactCheck({
  phase_3_strategy: {
    remediation_roadmap: [{
      phase: '3. Walk',
      actions: [
        `${contraindicatedTacticClaim} Preserve existing architecture cost reviews and use time-bound exceptions.`,
        'Retain this independently grounded action.'
      ]
    }]
  }
}, {
  attempts: 1,
  total_claims: 1,
  supported_count: 0,
  failed: false,
  unsupported_claims: [{
    claim: contraindicatedTacticClaim,
    classification: 'unsupported',
    source_location: 'roadmap',
    failure_type: 'other',
    severity: 'WARN_TACTIC_HYGIENE',
    tactic_disposition: 'contraindicated',
    rationale: 'The action is grounded, but this tactic assumes cost-blind architecture decisions that the locked findings contradict.'
  }]
});
assert.deepEqual(roadmapHygieneSanitized.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [
  'The engineering platform owner will extend the existing practice from platform pull requests to product repositories [D2]. Preserve existing architecture cost reviews and use time-bound exceptions.',
  'Retain this independently grounded action.'
]);
assert.equal(roadmapHygieneSanitized.sanitized[0].action, 'rewritten');
assert.equal(roadmapHygieneSanitized.sanitized[0].tactic_disposition, 'contraindicated', 'sanitation must preserve the explicit tactic disposition');

const sanitized = sanitizeStrategyAfterFactCheck(strategyData, factCheck);
assert.equal(sanitized.sanitized.length, 2);
assert.equal(sanitized.factCheck.unsupported_claims.length, 1);
assert.match(sanitized.strategyData.phase_3_strategy.executive_summaries.cfo, /burden index is 7%/);
assert.doesNotMatch(sanitized.strategyData.phase_3_strategy.executive_summaries.cfo, /share of cloud spend/);
assert.deepEqual(sanitized.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [
  'Enforce object storage lifecycle tiering for product telemetry.'
]);
assert.equal(sanitized.strategyData.phase_3_strategy.remediation_roadmap[0].why, '');
assert.match(sanitized.strategyData.phase_3_strategy.remediation_roadmap[0].what, /object storage lifecycle/);

const emptyClaim = sanitizeStrategyAfterFactCheck(strategyData, {
  attempts: 1,
  total_claims: 1,
  supported_count: 0,
  failed: false,
  unsupported_claims: [{
    claim: '   ',
    classification: 'unsupported',
    source_location: 'roadmap',
    failure_type: 'unsupported_org_claim',
    severity: 'BLOCKING_UNSUPPORTED_FACT',
    rationale: 'Malformed fact-check claim.'
  }]
});
assert.equal(emptyClaim.sanitized.length, 0);
assert.deepEqual(emptyClaim.strategyData.phase_3_strategy.remediation_roadmap[0].actions, strategyData.phase_3_strategy.remediation_roadmap[0].actions);

const caseMismatch = sanitizeStrategyAfterFactCheck(strategyData, {
  attempts: 1,
  total_claims: 1,
  supported_count: 0,
  failed: false,
  unsupported_claims: [{
    claim: 'implement finops outcome tracking to shift measurement from documented activities toward quantified optimization outcomes.',
    classification: 'unsupported',
    source_location: 'roadmap',
    failure_type: 'unsupported_org_claim',
    severity: 'BLOCKING_UNSUPPORTED_FACT',
    rationale: 'The locked findings already include quantified optimization outcomes.'
  }]
});
assert.equal(caseMismatch.sanitized.length, 1);
assert.deepEqual(caseMismatch.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [
  'Enforce object storage lifecycle tiering for product telemetry.'
]);

const warnGate = runQualityGate(phase1, strongPhase2, validationOk, validationOk, evidenceCheckOk, sanitized.factCheck);
assert.equal(warnGate.decision, 'WARN');
assert.equal(warnGate.blocking_reasons.length, 0);
assert.ok(warnGate.warnings.some(w => w.startsWith('Strategy sanitation removed')));

const unsanitizable = sanitizeStrategyAfterFactCheck(strategyData, {
  attempts: 1,
  total_claims: 1,
  supported_count: 0,
  failed: false,
  unsupported_claims: [{
    claim: 'Savings will be EUR 2 million.',
    classification: 'unsupported',
    source_location: 'roadmap',
    failure_type: 'fabricated_number',
    severity: 'BLOCKING_UNSUPPORTED_FACT',
    rationale: 'The number is not in the source.'
  }]
});
assert.equal(unsanitizable.factCheck.unsupported_claims.length, 1);
const blockGate = runQualityGate(phase1, strongPhase2, validationOk, validationOk, evidenceCheckOk, unsanitizable.factCheck);
assert.equal(blockGate.decision, 'BLOCK');
const blockedStrategy = sanitizeBlockedStrategy(strategyData, blockGate.blocking_reasons, {
  evidenceDensity: 75,
  evidenceCheckCompleted: true,
  scoreEvidenceGaps: ['[F1] Not demonstrated by supplied material.'],
});
assert.deepEqual(blockedStrategy.phase_3_strategy.remediation_roadmap, []);
assert.equal(blockedStrategy.phase_3_strategy.effective_bracket, 'LOW');
assert.equal(blockedStrategy.phase_3_strategy.planning_decision.decision, 'NO_GO');
assert.ok(blockedStrategy.phase_3_strategy.planning_decision.safe_to_act_on.some(item => item.startsWith('Review confirmed')));
assert.ok(blockedStrategy.phase_3_strategy.planning_decision.evidence_needed_before_action.some(item => item.startsWith('[F1]')));
const missingBlockedStrategy = sanitizeBlockedStrategy({}, ['Required fact-check result is missing.']);
assert.equal(missingBlockedStrategy.phase_3_strategy.planning_decision.decision, 'NO_GO');
assert.equal(missingBlockedStrategy.phase_3_strategy.effective_bracket, 'LOW');
assert.deepEqual(missingBlockedStrategy.phase_3_strategy.remediation_roadmap, []);
assert.ok(missingBlockedStrategy.phase_3_strategy.planning_decision.safe_to_act_on.every(item => !item.startsWith('Review confirmed')));

const uncertaintySanitized = sanitizeEvidenceSummaryUncertainty({ phase_3_strategy: { evidence_summary: {
  confirmed_gaps: ['Complete absence of AI/GenAI cost visibility', 'Storage lifecycle policy is planned but not enforced'],
  silent_or_missing_evidence: ['Existing evidence question'],
} } });
assert.deepEqual(uncertaintySanitized.phase_3_strategy.evidence_summary.confirmed_gaps, ['Storage lifecycle policy is planned but not enforced']);
assert.ok(uncertaintySanitized.phase_3_strategy.evidence_summary.silent_or_missing_evidence.includes('Not demonstrated by the supplied material: AI/GenAI cost visibility'));

const lowEvidenceGate = runQualityGate(
  phase1,
  { metrics: { evidence_density: 10, antipattern_coverage: 10 }, silent_areas: ids },
  validationOk,
  validationOk,
  evidenceCheckOk,
  sanitized.factCheck,
);
assert.equal(lowEvidenceGate.decision, 'BLOCK');

// Clear BLOCK deterministic findings-only report regression:
// - 0/3 observations stay scoped and are never promoted to Confirmed gaps or Primary bottleneck;
// - AP-A1 scoped derived quote and B1 observation are preserved in scoped_observations and findings_mode;
// - deterministic fact-check pass with attempts=0 keeps Quality Gate BLOCK cleanly without unsupported claims.
const clearBlockAuditLogs = {
  maturity: {
    ...phase1.maturity,
    A1: {
      count: 0,
      status: 'NOK',
      assessment_status: 'assessed',
      evidence_check_status: 'supported',
      question_results: ['not_supported', 'unknown', 'unknown'],
      evidence: 'Four May 2026 billing rows carry cost center tags; organization-wide showback policy is absent from extract.',
      reasoning: 'Four billing rows show allocation fields, but organization-wide tagging governance is not in scope.',
      evidence_quotes: [{ quote: '2026-05-01,CC-100,EUR', source_id: 'src-billing', chunk_id: 'c1' }],
    },
    B1: {
      count: 1,
      status: 'Partial',
      assessment_status: 'assessed',
      evidence_check_status: 'supported',
      question_results: ['supported', 'unknown', 'unknown'],
      evidence: 'Five optimization backlog rows list estimated savings without stated savings period or verified realization.',
      reasoning: 'Backlog estimates exist without savings horizon or realized verification.',
      evidence_quotes: [{ quote: 'Rightsize compute,Estimated,open', source_id: 'src-backlog', chunk_id: 'c2' }],
    },
  },
  antipattern: {
    ...phase1.antipattern,
    A1: {
      count: 0,
      status: 'OK',
      assessment_status: 'assessed',
      evidence_check_status: 'supported',
      antipattern_absence_status: 'unknown_absent',
      coverage_reason: 'Four-row extract confirms sample allocation only; anti-pattern remains Not assessed.',
      evidence: 'Scoped allocation observation.',
      reasoning: 'Sample-only extract.',
      evidence_quotes: [{
        evidence_source: 'derived',
        derived_evidence_id: 'EVID-DER-a1',
        source_id: 'src-billing',
        quote: 'allocation row coverage: 100%; valid=4/4; invalid placeholders=0; state=FIELD_PRESENT_VALID.',
      }],
    },
  },
};
const clearBlockPhase2 = {
  metrics: {
    evidence_density: 8,
    delivery_integrity: 100,
    antipattern_coverage: 0,
    antipattern_burden: 0,
    antipattern_clearance: 0,
    maturity_depth: 1.1,
    maturity_assessed_count: 5,
    antipattern_assessed_count: 0,
    corroborated_maturity: null,
    observed_maturity: 16.7,
    assessment_resolution: 8.3,
    adjusted_maturity: 4.8,
  },
  assessment_sufficiency: {
    decision: 'BLOCK',
    silent_domain_ids: ['C', 'D', 'E', 'F'],
    blocking_reasons: ['Criterion evidence density 8.3% (5/60 assessed criteria) is below 30%.'],
    warning_reasons: [],
  },
  crawl_walk_run: 'Insufficient evidence',
  category_scores: { A: 0, B: 1, C: 0, D: 0, E: 0, F: 0 },
  confirmed_maturity_gaps: [],
  scoped_observations: ['[A1] Scoped observation (0/3; full criterion scope not established): Four billing rows show allocation fields.'],
  antipattern_findings: [],
  verified_antipattern_absences: [],
  unknown_antipattern_absences: ['[A1] Not assessed: Four-row extract confirms sample allocation only.'],
  silent_areas: ['Capability not demonstrated by supplied material: C1'],
  score_evidence_gaps: [
    '[A2] Not demonstrated by the supplied material. Evidence needed: showback cadence.',
    '[B2] Not demonstrated by the supplied material. Evidence needed: realized savings verification.',
    '[C1] Not demonstrated by the supplied material. Evidence needed: FinOps governance charter.',
  ],
  verification_unresolved: [],
};
const deterministicBlocked = buildDeterministicBlockedFindingsStrategy({
  auditLogs: clearBlockAuditLogs,
  validationData: clearBlockPhase2,
  skippedDomains: { C: 'h1', D: 'h2', E: 'h3', F: 'h4' },
  derivedEvidence: [{
    mode: 'authoritative',
    report_eligible: true,
    evidence_id: 'EVID-DER-a1',
    eligibility: { state: 'ELIGIBLE', reasons: [] },
    derivation: { analyzer_id: 'tagging_allocation_v1' },
    summary_lines: ['Analyzed population: 4 row(s); scope=full_table.', 'allocation row coverage: 100%; valid=4/4; invalid placeholders=0; state=FIELD_PRESENT_VALID.'],
  }],
  bracketDetail: 'bracket=LOW evidence_density=8% delivery_integrity=100% silent_areas=55',
});
assert.deepEqual(deterministicBlocked.phase_3_strategy.evidence_summary.confirmed_gaps, [], 'Clear BLOCK must not promote 0/3 observations to confirmed gaps');
assert.doesNotMatch(deterministicBlocked.phase_3_strategy.diagnosis.primary_bottleneck, /\[A1\]/, 'Clear BLOCK must not promote A1 as primary bottleneck');
assert.match(deterministicBlocked.phase_3_strategy.diagnosis.primary_bottleneck, /Not established .*\(5\/60, 8%\)/);
assert.doesNotMatch(deterministicBlocked.phase_3_strategy.executive_summary, /\b(?:24|25|30)%/, 'deterministic BLOCK summary must not emit ungrounded threshold percentages');
assert.ok(deterministicBlocked.phase_3_strategy.evidence_summary.scoped_observations.some(line => line.startsWith('[A1] Scoped observation')));
assert.ok(deterministicBlocked.phase_3_strategy.evidence_summary.scoped_observations.some(line => line.startsWith('[AP-A1] Scoped observation (anti-pattern not assessed)')));
assert.ok(deterministicBlocked.phase_3_strategy.evidence_summary.scoped_observations.some(line => line.startsWith('[B1] Scoped observation (1/3)')));
assert.ok(deterministicBlocked.phase_3_strategy.findings_mode.missing_evidence[0].includes('Unassessed domains (C, D, E, F)'));
assert.doesNotMatch(JSON.stringify(deterministicBlocked), /primary constraint/i);

const skippedFactCheck = { attempts: 0, total_claims: 0, supported_count: 0, unsupported_claims: [], sanitized_claims: [], trajectory: [], failed: false };
const clearBlockGate = runQualityGate(clearBlockAuditLogs, clearBlockPhase2, validationOk, validationOk, evidenceCheckOk, skippedFactCheck);
assert.equal(clearBlockGate.decision, 'BLOCK');
assert.ok(clearBlockGate.blocking_reasons.some(reason => /Evidence density 8% <= 24% floor \(5\/60 assessed criteria\)/.test(reason)));
assert.equal(clearBlockGate.blocking_reasons.some(reason => /fact-check/i.test(reason)), false, 'deterministic findings-only skip must not create a false fact-check failure blocker');

const postGateBlocked = sanitizeBlockedStrategy(deterministicBlocked, clearBlockGate.blocking_reasons, {
  evidenceDensity: 8,
  evidenceCheckCompleted: true,
  scoreEvidenceGaps: clearBlockPhase2.score_evidence_gaps,
});
assert.ok(postGateBlocked.phase_3_strategy.planning_decision.evidence_needed_before_action.some(item => item.includes('Unassessed domains (C, D, E, F)')));

assert.equal(clearBlockPhase2.metrics.adjusted_maturity, 4.8);
assert.equal(clearBlockPhase2.crawl_walk_run, 'Insufficient evidence');
assert.equal(postGateBlocked.phase_3_strategy.planning_decision.decision, 'NO_GO');
assert.deepEqual(postGateBlocked.phase_3_strategy.remediation_roadmap, []);

const analysisSource = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
assert.match(
  analysisSource,
  /if \(deterministicSynthesisFallback\) \{\s*await checkpoint\('fact_check', 'pass_1', \{ fact_check: factCheck \}\);\s*\} else \{\s*acceptedFactChecks = await runFactCheck/,
  'evidence-floor BLOCK must skip narrative fact-check and regeneration loops'
);

console.log('strategy sanitation regression tests passed');

// A shared criterion can support a narrow reservation review after its
// estate-wide governance premise was quarantined. Test every publishing field.
const premise = 'There is no commitment governance.';
const rebuild = 'Build commitment governance from scratch [B1].';
const reservation = 'Review the identified reservation against its utilization threshold [B1].';
const cultureQuestion = 'Request a variance decision record for Culture & Organization [E1].';
const missingTacticAction = 'Establish a portfolio governance office using [TAC-GOV-004] [B1].';
const basisByCriterion = new Map([
  ['maturity.B1', { details: ['For this reservation the utilization threshold is 75%.'] }],
  ['antipattern.B1', { details: ['The single sampled quarterly review was tested.'] }],
  ['maturity.E1', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
]);
const planningFixture = { phase_3_strategy: {
  diagnosis: { primary_bottleneck: premise },
  planning_decision: { decision: 'CONDITIONAL_GO', rationale: rebuild, safe_to_act_on: [rebuild, reservation], evidence_needed_before_action: [cultureQuestion] },
  remediation_roadmap: [{ phase: 'Crawl', why: rebuild, what: reservation, actions: [rebuild, reservation, missingTacticAction], assumptions: [rebuild] }],
} };
const reviewedPremise = { claim: premise, source_location: 'diagnosis', classification: 'unsupported', severity: 'BLOCKING_UNSUPPORTED_FACT', failure_type: 'unsupported_org_claim', rationale: 'The accepted record describes a reservation review.' };
const independentlySupported = ['roadmap', 'planning_decision'].map(location => ({
  claim: reservation, source_location: location, classification: 'supported_by_audit',
  rationale: 'maturity.B1 "For this reservation the utilization threshold is 75%."',
}));
const review = { basisByCriterion, excludedPremises: [], verifiedClaims: [
  ...independentlySupported,
  { claim: cultureQuestion, source_location: 'planning_decision', classification: 'supported_by_audit', rationale: 'maturity.E1 "UNKNOWN | unscored | NO_GOVERNED_EVIDENCE"' },
  { claim: rebuild, source_location: 'roadmap', classification: 'supported_by_audit', rationale: 'antipattern.B1 "The single sampled quarterly review was tested."' },
  { claim: missingTacticAction, source_location: 'roadmap', classification: 'supported_by_tactics_db', rationale: 'maturity.B1 "For this reservation the utilization threshold is 75%."' },
] };
const removedPremise = sanitizeStrategyAfterFactCheck(planningFixture, { ...factCheck, unsupported_claims: [reviewedPremise] }, review);
const reconciled = removedPremise.strategyData.phase_3_strategy;
assert.deepEqual(reconciled.planning_decision.safe_to_act_on, [reservation]);
assert.deepEqual(reconciled.planning_decision.evidence_needed_before_action, [cultureQuestion]);
assert.equal(reconciled.planning_decision.rationale, '');
assert.deepEqual(reconciled.remediation_roadmap[0], { phase: 'Crawl', why: '', what: reservation, actions: [reservation], assumptions: [] });
assert.doesNotMatch(JSON.stringify(reconciled), /from scratch|no commitment governance|TAC-GOV-004/);
assert.ok(removedPremise.sanitized.filter(i => i.claim === missingTacticAction).every(i => !i.tactic_disposition));
// A later successful check with no new unsupported claims still reconciles
// the exact final candidate using retained quarantine history.
const laterCandidate = structuredClone(removedPremise.strategyData);
laterCandidate.phase_3_strategy.remediation_roadmap[0].actions.push(missingTacticAction);
const finalCheck = sanitizeStrategyAfterFactCheck(laterCandidate, { ...removedPremise.factCheck, unsupported_claims: [] }, review);
assert.deepEqual(finalCheck.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [reservation]);

// Regression for run ef617ca3: quarantining a narrow A3 alert-magnitude premise
// must remove tainted A3 prescriptions unless verified on surviving A3 facts,
// WITHOUT wiping out unaffected B2/A1 roadmap actions, Domain E evidence-collection
// actions, or bullet-prefixed verified claims when roadmapFactCheck focuses its
// claim budget on affected statements.
{
  const a3Premise = 'add affected account and magnitude context to anomaly alerts';
  const taintedA3Action = 'FinOps analyst applies [TAC-VIS-004] to [A3]: define alert account and magnitude context.';
  const narrowedA3Action = 'FinOps analyst adds affected account context to anomaly alerts [A3].';
  const unaffectedB2Action = 'FinOps analyst and service owners apply [TAC-OPT-002] to [B2]: extend PL-W12 right-sizing into a regular candidate register.';
  const domainECollection = 'FinOps lead collects Domain E evidence for [E1] [E2] [E3] [E4] [E5] from stakeholder records; no remediation tactic is prescribed.';
  const cleanAssumption = 'Source owners can supply records within the quarter.';

  const basis = new Map([
    ['maturity.A3', { details: ['The cited alert does not establish account context.'] }],
    ['maturity.B2', { details: ['One 14-day PL-W12 right-sizing change was closed.'] }],
    ['maturity.E1', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E2', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E3', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E4', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E5', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
  ]);

  const multiPhaseStrategy = {
    phase_3_strategy: {
      planning_decision: {
        decision: 'CONDITIONAL_GO',
        rationale: 'Proceed with bounded actions on verified gaps while collecting silent-domain evidence.',
        safe_to_act_on: [unaffectedB2Action, taintedA3Action],
        evidence_needed_before_action: ['Domain E evidence for E1 to E5 before any culture conclusion'],
      },
      remediation_roadmap: [{
        phase: 'Phase 1 — Crawl',
        why: 'Focus on assessed gaps and missing evidence.',
        what: `Extend right-sizing, ${a3Premise}, and collect silent-domain records.`,
        actions: [taintedA3Action, narrowedA3Action, unaffectedB2Action, domainECollection],
        assumptions: [cleanAssumption],
      }],
    },
  };

  const a3Sanitized = sanitizeStrategyAfterFactCheck(
    multiPhaseStrategy,
    {
      ...factCheck,
      unsupported_claims: [{
        claim: a3Premise,
        source_location: 'roadmap',
        classification: 'unsupported',
        severity: 'WARN_MISCLASSIFIED_BUT_REAL',
        failure_type: 'other',
        rationale: 'src-007 already records the EUR 388.71 magnitude; only account context is unsupported.',
      }],
    },
    {
      basisByCriterion: basis,
      excludedPremises: [],
      verifiedClaims: [{
        // Leading "- " from [HOW] rendering and lowercase excerpt start must still match
        claim: `- ${narrowedA3Action}`,
        source_location: 'roadmap',
        classification: 'supported_by_audit',
        rationale: 'maturity.A3 "the cited alert does not establish account context"',
      }],
    },
  );

  const survivingRoadmap = a3Sanitized.strategyData.phase_3_strategy.remediation_roadmap;
  assert.equal(survivingRoadmap.length, 1, 'roadmap phase must survive targeted premise quarantine');
  assert.deepEqual(
    survivingRoadmap[0].actions,
    [narrowedA3Action, unaffectedB2Action, domainECollection],
    'tainted A3 action is removed while narrowed A3 action, unaffected B2 action, and Domain E evidence collection survive',
  );
  assert.deepEqual(survivingRoadmap[0].assumptions, [cleanAssumption]);
  assert.deepEqual(
    a3Sanitized.strategyData.phase_3_strategy.planning_decision.safe_to_act_on,
    [unaffectedB2Action],
  );
  assert.equal(
    a3Sanitized.strategyData.phase_3_strategy.planning_decision.evidence_needed_before_action.length,
    1,
    'multi-criterion E1 to E5 evidence request must survive against UNKNOWN Phase 2 basis',
  );
}

// Regression for run 1d1d72f3: quarantining a forward-looking roadmap assumption
// must remove ONLY that assumption without wiping out clean WHY, WHAT, deliverables,
// or actions across phases.
{
  const assumptionText = 'Crawl evidence confirms the commitment inventory is reliable enough to model downside risk';
  const cleanWhy = 'Commitment coverage targets and exchange decisions are currently undocumented in the sampled scope.';
  const cleanWhat = 'Produce a validated reservation inventory and conservative commitment decision model.';
  const cleanDeliverable = 'Validated reservation inventory reconciling eligible usage, coverage, utilization and expiry.';
  const cleanAction = 'FinOps analyst and finance controller assemble the reservation inventory [B1].';

  const assumptionFixture = {
    phase_3_strategy: {
      planning_decision: {
        decision: 'CONDITIONAL_GO',
        rationale: 'Proceed with bounded commitment validation.',
        safe_to_act_on: [cleanDeliverable],
        evidence_needed_before_action: [],
      },
      remediation_roadmap: [{
        phase: '1. Crawl — Foundation (0-3 Months)',
        why: cleanWhy,
        what: cleanWhat,
        deliverables: [cleanDeliverable],
        actions: [cleanAction],
        assumptions: [assumptionText],
      }],
    },
  };

  const sanitizedAssumption = sanitizeStrategyAfterFactCheck(
    assumptionFixture,
    {
      ...factCheck,
      unsupported_claims: [{
        claim: assumptionText,
        source_location: 'roadmap',
        classification: 'unsupported',
        severity: 'BLOCKING_UNSAFE_ROADMAP',
        failure_type: 'unsupported_org_claim',
        rationale: 'Locked findings do not establish inventory reliability.',
      }],
    },
    {
      basisByCriterion: new Map([['maturity.B1', { details: ['The team reviews reservations quarterly.'] }]]),
      excludedPremises: [],
      verifiedClaims: [],
    },
  );
  const phase = sanitizedAssumption.strategyData.phase_3_strategy.remediation_roadmap[0];
  assert.deepEqual(phase.assumptions, [], 'unsupported assumption itself is removed');
  assert.equal(phase.why, cleanWhy, 'clean phase WHY must survive assumption removal');
  assert.equal(phase.what, cleanWhat, 'clean phase WHAT must survive assumption removal');
  assert.deepEqual(phase.deliverables, [cleanDeliverable], 'clean deliverables must survive assumption removal');
  assert.deepEqual(phase.actions, [cleanAction], 'clean actions must survive assumption removal');
}

// Regression for run 0087d3d4:
// 1. Multi-sentence composite planning_decision.rationale and persona-summary claims must NOT
//    dump valid FinOps vocabulary into a global bag-of-words that wipes out unrelated phases.
// 2. Roadmap actions explicitly rewritten and preserved under WARN_TACTIC_HYGIENE must NOT be
//    deleted or used to transitively taint criteria in reconcilePlanning().
// 3. Multi-sentence WHY/WHAT paragraphs preserve clean sentences when one bad sentence is excised.
// 4. Silent-domain [E1-E5] evidence-request actions ("evidence requests", "repeat the ... assessment") survive.
{
  const longRationale = 'Assessed findings are source-backed, with sufficiency passing and delivery integrity at 100%, so several actions follow directly from confirmed gaps: the underused reservation with no recorded exchange, anomaly detection that is not shown as repeatable, a cost-per-task figure that is not a primary metric, and no token or inference spend reporting. Confidence is medium, though. Evidence density and assessment resolution are both 30%, below the 60% target. The records are synthetic and cover two Azure scopes in one month. Culture and Organization has no evidence, and 29 anti-pattern checks could not be assessed. No savings or investment figures are asserted.';
  const personaSummaryNuance = 'An architecture decision compared a fixed-size worker with a managed event worker on cost, p95 latency (211 ms against 250 ms) and recovery (7 against 10 minutes).';
  const badWhatSentence = 'The allocation suspense balance has an owner, an expiry for its exception, and a measured view of policy violations in audit mode.';
  const cleanWhatSentences = 'By the end of this phase, the FinOps team, finance, and engineering share a validated view of what is and is not evidenced. Commitment owners hold a recorded disposition for the underused reservation instead of an open review item.';
  const tacticHygieneAction = 'Finance controller and engineering service owners run tag policy rules in audit mode against the EUR 1,412.50 of shared spend in allocation suspense, recording owner, rationale, and expiry [A1] [A2] [TAC-VIS-001]';
  const b1Action = 'Finance controller and cloud platform owner reconcile the reservation inventory for eligible usage, utilization, expiry, and owner, then record an exchange or retain decision for ENT-RI-00032 [B1]';
  const domainERangeAction = 'FinOps lead and finance partner compile a register of evidence requests for Culture and Organization and for criteria with no governed evidence [E1-E5]';
  const phase2B1Action = 'FinOps lead and finance controller segment stable eligible usage and model conservative purchase scenarios [B1] [TAC-OPT-001]';
  const phase4RepeatAction = 'FinOps lead and finance controller repeat the evidence-bounded assessment across the previously silent and unassessed areas [E1-E5]';

  const run0087Fixture = {
    phase_3_strategy: {
      executive_summaries: { engineering_lead: personaSummaryNuance },
      diagnosis: {
        primary_bottleneck: 'Evidence resolution is 30%.',
        root_causes: ['token spend reporting and recurring unit economics were not shown'],
        domain_diagnosis: {},
        confidence: 'medium',
      },
      planning_decision: {
        decision: 'CONDITIONAL_GO',
        rationale: longRationale,
        safe_to_act_on: ['Assign an owner and expiry to the EUR 1,412.50 of shared spend in allocation suspense'],
        evidence_needed_before_action: ['Evidence beyond two Azure scopes, since the source records are labelled synthetic'],
      },
      remediation_roadmap: [
        {
          phase: '1. Crawl — Foundation (0-3 Months)',
          why: 'The assessment classifies maturity as Crawl, with 30% assessment resolution and 30% criterion evidence density. Several gaps are confirmed on that scoped evidence: a reservation at 36.3% utilization has no recorded exchange.',
          what: `${cleanWhatSentences} ${badWhatSentence}`,
          deliverables: [
            'Reservation inventory and disposition record covering eligible usage, utilization, expiry, and approver for the underused commitment',
            'Allocation suspense exception register with owner, rationale, and expiry date',
          ],
          actions: [domainERangeAction, b1Action, tacticHygieneAction],
          assumptions: ['Records requested for silent areas exist and can be shared'],
        },
        {
          phase: '2. Walk — Optimization (3-6 Months)',
          why: 'With the Crawl records in place, this phase addresses commitment portfolio management and a primary cost-per-task metric.',
          what: 'The target state is a commitment portfolio with a coverage target distinct from the existing utilization threshold.',
          deliverables: ['Commitment coverage policy and quarterly review log'],
          actions: [phase2B1Action],
          assumptions: [],
        },
        {
          phase: '4. Run — Continuous (12+ Months)',
          why: 'Run-level outcomes can only be justified once earlier evidence exists across the 29 anti-pattern checks.',
          what: 'The target state is an updated assessment that covers the originally silent and partially assessed areas.',
          deliverables: ['Updated evidence-bounded FinOps assessment pack'],
          actions: [phase4RepeatAction],
          assumptions: [],
        },
      ],
    },
  };

  const run0087Basis = new Map([
    ['maturity.A1', { details: ['Application-tag enforcement and a tagging-remediation SLA are not established.'] }],
    ['maturity.A2', { details: ['Finance and teams acknowledged the May showback and the shared exception.'] }],
    ['maturity.B1', { details: ['ENT-RI-00032 at 36.3% utilization has no recorded exchange.'] }],
    ['maturity.E1', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E2', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E3', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E4', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
    ['maturity.E5', { unknownStatus: 'UNKNOWN | unscored | NO_GOVERNED_EVIDENCE', details: [] }],
  ]);

  const run0087Sanitized = sanitizeStrategyAfterFactCheck(
    run0087Fixture,
    {
      ...factCheck,
      unsupported_claims: [
        {
          claim: 'token spend reporting and recurring unit economics were not shown',
          source_location: 'diagnosis',
          classification: 'unsupported',
          severity: 'BLOCKING_UNSUPPORTED_FACT',
          failure_type: 'other',
          rationale: 'src-011 shows token counts by endpoint.',
        },
        {
          claim: personaSummaryNuance,
          source_location: 'engineering_lead',
          classification: 'unsupported',
          severity: 'WARN_MISCLASSIFIED_BUT_REAL',
          failure_type: 'other',
          rationale: 'Pilot replay vs ADR comparison.',
        },
        {
          claim: longRationale,
          source_location: 'planning_decision',
          classification: 'unsupported',
          severity: 'WARN_MISCLASSIFIED_BUT_REAL',
          failure_type: 'unsupported_org_claim',
          rationale: 'Contains excluded absolute AI reporting phrase.',
        },
        {
          claim: badWhatSentence,
          source_location: 'roadmap',
          classification: 'unsupported',
          severity: 'BLOCKING_UNSAFE_ROADMAP',
          failure_type: 'other',
          rationale: 'Policy violations in audit mode is unsupported.',
        },
        {
          claim: tacticHygieneAction,
          source_location: 'roadmap',
          classification: 'unsupported',
          severity: 'WARN_TACTIC_HYGIENE',
          failure_type: 'other',
          tactic_disposition: 'citation_rejected',
          rationale: 'TAC-VIS-001 use_when requires missing mandatory tags.',
        },
      ],
    },
    { basisByCriterion: run0087Basis, excludedPremises: [], verifiedClaims: [] },
  );

  const phases = run0087Sanitized.strategyData.phase_3_strategy.remediation_roadmap;
  assert.equal(phases.length, 3, 'all three roadmap phases must survive without collateral wipeout');
  assert.ok(phases[0].why.length > 40, 'Phase 1 WHY must survive');
  assert.equal(phases[0].what, cleanWhatSentences, 'Phase 1 WHAT must keep clean sentences after bad sentence is excised');
  assert.equal(phases[0].deliverables.length, 2, 'Phase 1 deliverables must survive');
  assert.equal(phases[0].actions.length, 3, 'Phase 1 [E1-E5], [B1], and rewritten [A1][A2] actions must all survive');
  assert.doesNotMatch(phases[0].actions[2], /TAC-VIS-001/, 'rejected tactic ID is stripped while rewritten action survives');
  assert.deepEqual(phases[1].actions, [phase2B1Action], 'Phase 2 [B1] [TAC-OPT-001] action must survive');
  assert.deepEqual(phases[2].actions, [phase4RepeatAction], 'Phase 4 [E1-E5] repeat-assessment action must survive');
  assert.equal(run0087Sanitized.strategyData.phase_3_strategy.planning_decision.safe_to_act_on.length, 1);
  assert.equal(run0087Sanitized.strategyData.phase_3_strategy.planning_decision.evidence_needed_before_action.length, 1);
}
