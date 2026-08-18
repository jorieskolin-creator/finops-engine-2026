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
const { sanitizeBlockedStrategy, sanitizeEvidenceSummaryUncertainty, sanitizeStrategyAfterFactCheck } = await import(`file://${join(dir, 'strategySanitationService.mjs')}`);

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
    rationale: 'The action is grounded, but this tactic assumes cost-blind architecture decisions that the locked findings contradict.'
  }]
});
assert.deepEqual(roadmapHygieneSanitized.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [
  'The engineering platform owner will extend the existing practice from platform pull requests to product repositories [D2]. Preserve existing architecture cost reviews and use time-bound exceptions.',
  'Retain this independently grounded action.'
]);
assert.equal(roadmapHygieneSanitized.sanitized[0].action, 'rewritten');

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

console.log('strategy sanitation regression tests passed');
