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

const dir = await mkdtemp(join(tmpdir(), 'finops-tactic-grounding-'));
const tactics = [
  { id: 'TAC-GOV-001', canonical_name: 'Cloud Financial Policy Framework' },
  { id: 'TAC-GOV-002', canonical_name: 'Account Vending Machine' },
  { id: 'TAC-GOV-003', canonical_name: 'Automated Budget Enforcement' },
  { id: 'TAC-GOV-004', canonical_name: 'FinOps Outcome Tracking' },
  { id: 'TAC-OPT-005', canonical_name: 'Storage Lifecycle Policies' },
  { id: 'TAC-AI-001', canonical_name: 'AI Cost Attribution' },
];
const entry = ({ tactic_id, category, maturity_bindings, antipattern_bindings }) => ({
  tactic_id,
  category,
  maturity_bindings,
  antipattern_bindings,
  activity_goal: `Deliver ${tactic_id}`,
  when_to_use: [`Verified finding matches ${tactic_id}`],
  when_not_to_use: ['No verified finding'],
  prerequisite_evidence: ['Verified finding'],
  implementation_activities: ['Define', 'Pilot', 'Validate'],
  owner_roles: ['FinOps lead'],
  expected_artifacts: [`${tactic_id} register`, `${tactic_id} policy`],
  semantic_hints: [tactic_id.toLowerCase(), 'governed action'],
  acceptance_criteria: ['Owner approves', 'Control is tested'],
  risks_and_controls: ['Risk: unsafe rollout. Control: pilot and validate.'],
});
const playbook = [
  entry({
    tactic_id: 'TAC-GOV-001', category: 'C',
    maturity_bindings: [{ criterion_id: 'C5', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-C5', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
  entry({
    tactic_id: 'TAC-GOV-002', category: 'C',
    maturity_bindings: [{ criterion_id: 'C3', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-C1', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
  entry({
    tactic_id: 'TAC-GOV-003', category: 'C',
    maturity_bindings: [{ criterion_id: 'C2', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-C2', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
  entry({
    tactic_id: 'TAC-GOV-004', category: 'C',
    maturity_bindings: [{ criterion_id: 'C3', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-C4', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
  entry({
    tactic_id: 'TAC-OPT-005', category: 'B',
    maturity_bindings: [{ criterion_id: 'B5', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-B5', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
  entry({
    tactic_id: 'TAC-AI-001', category: 'F',
    maturity_bindings: [{ criterion_id: 'F1', relationship: 'PRIMARY' }],
    antipattern_bindings: [{ criterion_id: 'AP-F1', relationship: 'PRIMARY', mandatory_when_activated: true }],
  }),
];

await writeFile(
  join(dir, 'knowledge_base.mjs'),
  `export const FINOPS_TACTICS_LOCAL = ${JSON.stringify(tactics)}; export const FINOPS_TACTIC_ACTIVITY_PLAYBOOK = ${JSON.stringify(playbook)};\n`,
  'utf8'
);
await writeFile(
  join(dir, 'tacticTestHelpers.mjs'),
  `export const hasVerifiedSourceCoverage = item => !item.verification_unresolved && item.assessment_status !== 'not_assessed' && item.evidence_quotes?.some(quote => quote.quote?.trim());
export const inferAntiPatternAbsenceStatus = item => item.antipattern_absence_status || (item.count > 0 ? 'partially_present' : 'unknown_absent');\n`,
  'utf8'
);

const source = await readFile(new URL('../src/services/tacticGroundingService.ts', import.meta.url), 'utf8');
const modulePath = join(dir, 'tacticGroundingService.mjs');
await writeFile(
  modulePath,
  compile(source)
    .replace("from '../knowledge_base'", "from './knowledge_base.mjs'")
    .replace("from './antiPatternSemantics'", "from './tacticTestHelpers.mjs'")
    .replace("from './metricsService'", "from './tacticTestHelpers.mjs'"),
  'utf8'
);

const {
  buildTacticSelectionContext,
  buildTacticSelectionPlan,
  classifyFinalRequiredTactics,
  findMissingRequiredTacticIds,
  findRoadmapActionsMissingCriterionReferences,
  sanitizeRoadmapTacticGrounding,
} = await import(`file://${modulePath}`);

const phase2 = {
  metrics: {},
  maturity_gaps: ['[B5] Confirmed gap: storage lifecycle policy is absent.'],
  antipattern_findings: ['[C1] Finding: unmanaged cloud accounts were verified...'],
  silent_areas: ['Capability not demonstrated by supplied material: F1'],
  category_scores: { A: 15, B: 12, C: 14, D: 15, E: 15, F: 0 },
};

const quote = criterionId => [{ quote: `${criterionId} verified source text`, evidence_source: 'text' }];
const item = (criterionId, count, overrides = {}) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence: `${criterionId} evidence`,
  reasoning: `${criterionId} reasoning`,
  evidence_quotes: quote(criterionId),
  assessment_status: 'assessed',
  evidence_check_status: 'supported',
  verification_unresolved: false,
  ...overrides,
});
const auditLogs = {
  maturity: {
    B5: item('B5', 0),
    C2: item('C2', 2),
    C3: item('C3', 1),
    F1: item('F1', 0),
  },
  antipattern: {
    C1: item('AP-C1', 3, { antipattern_absence_status: 'confirmed_present' }),
    C2: item('AP-C2', 1, { antipattern_absence_status: 'partially_present' }),
  },
};

const plan = buildTacticSelectionPlan(auditLogs, ['F']);
assert.deepEqual(plan.required.map(candidate => candidate.tactic_id).sort(), ['TAC-GOV-002', 'TAC-GOV-003', 'TAC-GOV-004', 'TAC-OPT-005']);
assert.ok(plan.optional.some(item => item.tactic_id === 'TAC-GOV-001'), 'same-category tactic should be evaluated optionally');
assert.ok(!plan.required.some(item => item.tactic_id === 'TAC-AI-001'), 'weak/not-demonstrated domain must not activate remediation');
assert.deepEqual(plan.required.find(candidate => candidate.tactic_id === 'TAC-GOV-002').activated_by.sort(), ['AP-C1', 'C3']);
assert.ok(plan.required.some(candidate => candidate.tactic_id === 'TAC-GOV-004'), 'all PRIMARY tactics for one criterion must be required');

for (const count of [0, 1, 2]) {
  const maturityPlan = buildTacticSelectionPlan({ maturity: { C3: item('C3', count) }, antipattern: {} });
  assert.ok(maturityPlan.required.some(candidate => candidate.tactic_id === 'TAC-GOV-002'), `verified maturity ${count}/3 must activate PRIMARY`);
}
assert.equal(buildTacticSelectionPlan({ maturity: { C3: item('C3', 3) }, antipattern: {} }).required.length, 0, 'maturity 3/3 must not activate remediation');
assert.equal(buildTacticSelectionPlan({ maturity: { C3: item('C3', 0, { assessment_status: 'not_assessed' }) }, antipattern: {} }).required.length, 0, 'not-assessed maturity must not activate remediation');
assert.equal(buildTacticSelectionPlan({ maturity: { C3: item('C3', 0, { verification_unresolved: true }) }, antipattern: {} }).required.length, 0, 'unresolved maturity must not activate remediation');
assert.equal(buildTacticSelectionPlan({ maturity: { C3: item('C3', 0, { evidence_quotes: [] }) }, antipattern: {} }).required.length, 0, 'evidence-silent maturity must not activate remediation');
assert.equal(buildTacticSelectionPlan({ maturity: { C3: item('C3', 0) }, antipattern: {} }, ['C']).required.length, 0, 'silent-domain maturity must not activate remediation');
assert.ok(buildTacticSelectionPlan({ maturity: {}, antipattern: { C1: item('AP-C1', 1, { antipattern_absence_status: 'partially_present' }) } }).required.some(candidate => candidate.tactic_id === 'TAC-GOV-002'), 'partial anti-pattern presence must activate PRIMARY');
assert.equal(buildTacticSelectionPlan({ maturity: {}, antipattern: { C1: item('AP-C1', 0, { antipattern_absence_status: 'tested_absent', coverage_reason: 'Relevant controls tested' }) } }).required.length, 0, 'tested-absent anti-pattern must not activate remediation');
assert.equal(buildTacticSelectionPlan({ maturity: { A1: item('A1', 0, { reasoning: 'Create a TAC-GOV-003 register and policy' }) }, antipattern: {} }).optional.length, 0, 'artifact wording alone must not create a cross-category candidate');
const context = buildTacticSelectionContext(plan);
assert.match(context, /REQUIRED \[TAC-GOV-002\]/);
assert.match(context, /Expected artifacts \(hints, not activation proof\)/);
assert.match(context, /Risk-control guidance \(adapt; do not copy mechanically\)/);

const strategyData = {
  phase_3_strategy: {
    remediation_roadmap: [{
      phase: '1. Crawl',
      actions: [
        'Migrate verified unmanaged accounts through a staged owner-approved path [TAC-GOV-002] [AP-C1]',
        'Introduce owner-approved budget controls with staged enforcement [TAC-GOV-003] [C2]',
        'Track the verified governance outcomes against accepted measures [TAC-GOV-004] [C3]',
        'Pilot owner-approved retention controls with restore validation [TAC-OPT-005] [B5]',
        'Define an additional customer-specific handoff artifact with an owner and acceptance check [B5]',
      ],
    }],
  },
};

assert.deepEqual(findMissingRequiredTacticIds(strategyData, plan), []);
assert.deepEqual(findRoadmapActionsMissingCriterionReferences(strategyData), []);
assert.deepEqual(findRoadmapActionsMissingCriterionReferences({ phase_3_strategy: { remediation_roadmap: [{
  actions: ['Grounded action without an explicit criterion reference'],
}] } }), ['Grounded action without an explicit criterion reference']);
const missingStrategy = structuredClone(strategyData);
missingStrategy.phase_3_strategy.remediation_roadmap[0].actions = missingStrategy.phase_3_strategy.remediation_roadmap[0].actions.filter(action => !action.includes('TAC-GOV-002'));
assert.deepEqual(findMissingRequiredTacticIds(missingStrategy, plan), ['TAC-GOV-002']);
const missingContract = classifyFinalRequiredTactics(missingStrategy, plan);
assert.deepEqual(missingContract.contraindicated, []);
assert.deepEqual(missingContract.citation_rejected, []);
assert.deepEqual(missingContract.missing, ['TAC-GOV-002']);
assert.equal(missingContract.dispositions.find(item => item.tactic_id === 'TAC-GOV-002').disposition, 'missing');
const contraindicatedContract = classifyFinalRequiredTactics(missingStrategy, plan, [{
  action: 'quarantined',
  claim: '[TAC-GOV-002] Create a new account-vending control.',
  rationale: 'The Playbook do-not-use condition is established by the locked findings.',
  source_location: 'roadmap',
  failure_type: 'other',
  severity: 'WARN_TACTIC_HYGIENE',
  tactic_disposition: 'contraindicated',
}]);
assert.deepEqual(contraindicatedContract.contraindicated, ['TAC-GOV-002']);
assert.deepEqual(contraindicatedContract.citation_rejected, []);
assert.deepEqual(contraindicatedContract.missing, []);
assert.equal(contraindicatedContract.dispositions.find(item => item.tactic_id === 'TAC-GOV-002').disposition, 'contraindicated');
const rejectedContract = classifyFinalRequiredTactics(missingStrategy, plan, [{
  action: 'rewritten',
  claim: '[TAC-GOV-002] Create a new account-vending control.',
  rationale: 'The citation does not support this action.',
  source_location: 'roadmap',
  failure_type: 'other',
  severity: 'WARN_TACTIC_HYGIENE',
  tactic_disposition: 'citation_rejected',
}]);
assert.deepEqual(rejectedContract.citation_rejected, ['TAC-GOV-002']);
assert.deepEqual(rejectedContract.missing, []);

const result = sanitizeRoadmapTacticGrounding(strategyData, phase2, ['F']);
assert.equal(result.adjustments.length, 0);
assert.ok(result.strategyData.phase_3_strategy.remediation_roadmap[0].actions.some(action => action.includes('[TAC-OPT-005]')), 'authoritative binding must not be removed by an unrelated keyword table');

const silentDomainResult = sanitizeRoadmapTacticGrounding({ phase_3_strategy: { remediation_roadmap: [{
  phase: '1. Crawl',
  actions: ['Implement AI cost attribution [TAC-AI-001]', 'Collect domain F billing exports and ownership records [F1]'],
}], planning_decision: { safe_to_act_on: ['Implement AI cost attribution [TAC-AI-001]'] } } }, phase2, ['F']);
assert.deepEqual(silentDomainResult.strategyData.phase_3_strategy.remediation_roadmap[0].actions, ['Collect domain F billing exports and ownership records [F1]'], 'silent-domain evidence collection must survive while remediation is withheld');
assert.deepEqual(silentDomainResult.strategyData.phase_3_strategy.planning_decision.safe_to_act_on, []);
assert.ok(silentDomainResult.warnings.some(warning => /less than 10% verified criterion evidence/.test(warning)));

console.log('tactic grounding and selection unit tests passed');
