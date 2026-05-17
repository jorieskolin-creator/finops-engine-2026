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

const dir = await mkdtemp(join(tmpdir(), 'finops-quality-gate-'));
await writeFile(join(dir, 'modelRouter.mjs'), 'export const runStage = async () => ({ text: "{}", modelUsed: { id: "stub" } });\n', 'utf8');

const source = await readFile(new URL('../src/services/qualityGateService.ts', import.meta.url), 'utf8');
const modulePath = join(dir, 'qualityGateService.mjs');
await writeFile(
  modulePath,
  compile(source).replace("from './modelRouter'", "from './modelRouter.mjs'"),
  'utf8'
);

const {
  isDomainTaxonomyHygieneClaim,
  isMisclassifiedButRealClaim,
  isTacticHygieneClaim,
  isBlockingUnsupportedClaim,
  runQualityGate
} = await import(`file://${modulePath}`);

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
const phase2 = {
  metrics: { evidence_density: 92, antipattern_coverage: 92 },
  silent_areas: [],
};
const validationOk = { valid: true, errors: [], warnings: [] };

const domainClaim = {
  claim: 'Domain D scores 9/15 and represents infrastructure and autoscaling.',
  classification: 'unsupported',
  source_location: 'diagnosis',
  failure_type: 'unsupported_org_claim',
  rationale: 'The diagnosis uses thematic names that do not match how Phase 1 evidence maps domain letters.',
  missing_material: 'Evidence explicitly mapping the framework domain letters to those thematic names.'
};
assert.equal(isDomainTaxonomyHygieneClaim(domainClaim), true);
assert.equal(isBlockingUnsupportedClaim(domainClaim), false);

const misclassifiedRealClaim = {
  claim: 'CI runner spot fallback is manual.',
  classification: 'unsupported',
  source_location: 'diagnosis',
  failure_type: 'unsupported_org_claim',
  severity: 'WARN_MISCLASSIFIED_BUT_REAL',
  rationale: 'While this gap exists in the source, it is incorrectly listed as a confirmed anti-pattern.',
  missing_material: 'Phase 1 evidence explicitly identifying it as a confirmed anti-pattern.'
};
assert.equal(isMisclassifiedButRealClaim(misclassifiedRealClaim), true);
assert.equal(isBlockingUnsupportedClaim(misclassifiedRealClaim), false);

const planningTacticHygieneClaim = {
  claim: 'Enforce lifecycle tiering [TAC-OPT-005].',
  classification: 'unsupported',
  source_location: 'planning_decision',
  failure_type: 'other',
  severity: 'WARN_TACTIC_HYGIENE',
  rationale: 'Tactic IDs are allowed only in roadmap actions; the action itself is grounded.',
  missing_material: 'No additional evidence required.'
};
assert.equal(isTacticHygieneClaim(planningTacticHygieneClaim), true);
assert.equal(isBlockingUnsupportedClaim(planningTacticHygieneClaim), false);

{
  const gate = runQualityGate(
    phase1,
    phase2,
    validationOk,
    {
      valid: true,
      errors: [],
      warnings: ['Strategy contains 2 actions with no tactic IDs. Tactic IDs were withheld where no exact KB match was supported.']
    },
    undefined,
    {
      attempts: 3,
      total_claims: 10,
      supported_count: 3,
      unsupported_claims: Array.from({ length: 7 }, () => domainClaim),
      failed: false
    }
  );
  assert.equal(gate.decision, 'WARN');
  assert.equal(gate.blocking_reasons.length, 0);
  assert.ok(gate.warnings.some(w => w.startsWith('Strategy hygiene: 7')));
}

{
  const gate = runQualityGate(
    phase1,
    phase2,
    validationOk,
    validationOk,
    undefined,
    {
      attempts: 3,
      total_claims: 6,
      supported_count: 2,
      unsupported_claims: [misclassifiedRealClaim, planningTacticHygieneClaim, domainClaim, domainClaim],
      failed: false
    }
  );
  assert.equal(gate.decision, 'WARN');
  assert.equal(gate.blocking_reasons.length, 0);
  assert.ok(gate.warnings.some(w => w.startsWith('Strategy hygiene: 4')));
}

{
  const gate = runQualityGate(
    phase1,
    phase2,
    validationOk,
    validationOk,
    undefined,
    {
      attempts: 1,
      total_claims: 1,
      supported_count: 0,
      unsupported_claims: [{
        claim: 'Savings will be EUR 2 million.',
        classification: 'unsupported',
        source_location: 'roadmap',
        failure_type: 'fabricated_number',
        rationale: 'The number is not in the source.'
      }],
      failed: false
    }
  );
  assert.equal(gate.decision, 'BLOCK');
}

{
  const gate = runQualityGate(
    phase1,
    phase2,
    validationOk,
    validationOk,
    undefined,
    {
      attempts: 1,
      total_claims: 1,
      supported_count: 0,
      unsupported_claims: [{
        claim: 'Replace all production workloads with spot instances immediately.',
        classification: 'unsupported',
        source_location: 'roadmap',
        failure_type: 'other',
        severity: 'BLOCKING_UNSAFE_ROADMAP',
        rationale: 'The action is unsafe and does not follow from locked findings.'
      }],
      failed: false
    }
  );
  assert.equal(gate.decision, 'BLOCK');
}

console.log('quality gate severity unit tests passed');
