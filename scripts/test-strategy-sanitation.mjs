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

const qualityGateSource = await readFile(new URL('../src/services/qualityGateService.ts', import.meta.url), 'utf8');
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
const { sanitizeStrategyAfterFactCheck } = await import(`file://${join(dir, 'strategySanitationService.mjs')}`);

const ids = ['A', 'B', 'C', 'D', 'E'].flatMap(batch => [1, 2, 3, 4, 5].map(n => `${batch}${n}`));
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

const sanitized = sanitizeStrategyAfterFactCheck(strategyData, factCheck);
assert.equal(sanitized.sanitized.length, 2);
assert.equal(sanitized.factCheck.unsupported_claims.length, 1);
assert.match(sanitized.strategyData.phase_3_strategy.executive_summaries.cfo, /burden index is 7%/);
assert.doesNotMatch(sanitized.strategyData.phase_3_strategy.executive_summaries.cfo, /share of cloud spend/);
assert.deepEqual(sanitized.strategyData.phase_3_strategy.remediation_roadmap[0].actions, [
  'Enforce object storage lifecycle tiering for product telemetry.'
]);

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

const warnGate = runQualityGate(phase1, strongPhase2, validationOk, validationOk, undefined, sanitized.factCheck);
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
const blockGate = runQualityGate(phase1, strongPhase2, validationOk, validationOk, undefined, unsanitizable.factCheck);
assert.equal(blockGate.decision, 'BLOCK');

const lowEvidenceGate = runQualityGate(
  phase1,
  { metrics: { evidence_density: 10, antipattern_coverage: 10 }, silent_areas: ids },
  validationOk,
  validationOk,
  undefined,
  sanitized.factCheck,
);
assert.equal(lowEvidenceGate.decision, 'BLOCK');

console.log('strategy sanitation regression tests passed');
