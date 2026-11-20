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
