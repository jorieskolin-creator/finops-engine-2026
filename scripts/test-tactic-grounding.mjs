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
  { id: 'TAC-OPT-001', canonical_name: 'Commitment Strategy' },
  { id: 'TAC-OPT-004', canonical_name: 'Spot / Preemptible Adoption' },
  { id: 'TAC-GOV-001', canonical_name: 'Cloud Financial Policy Framework' },
  { id: 'TAC-GOV-004', canonical_name: 'FinOps Outcome Tracking' },
  { id: 'TAC-ARCH-002', canonical_name: 'Cost Estimation in Architecture Review' },
  { id: 'TAC-CULT-004', canonical_name: 'Blameless Cost Reviews' },
  { id: 'TAC-AI-001', canonical_name: 'AI Cost Attribution' }
];
const playbook = tactics.map(tactic => ({
  tactic_id: tactic.id,
  maturity_criteria: tactic.id === 'TAC-AI-001' ? ['F1'] : ['A1'],
  antipattern_criteria: tactic.id === 'TAC-AI-001' ? ['AP-F1'] : [],
}));

await writeFile(
  join(dir, 'knowledge_base.mjs'),
  `export const FINOPS_TACTICS_LOCAL = ${JSON.stringify(tactics)}; export const FINOPS_TACTIC_ACTIVITY_PLAYBOOK = ${JSON.stringify(playbook)};\n`,
  'utf8'
);

const source = await readFile(new URL('../src/services/tacticGroundingService.ts', import.meta.url), 'utf8');
const modulePath = join(dir, 'tacticGroundingService.mjs');
await writeFile(
  modulePath,
  compile(source).replace("from '../knowledge_base'", "from './knowledge_base.mjs'"),
  'utf8'
);

const { sanitizeRoadmapTacticGrounding } = await import(`file://${modulePath}`);

const phase2 = {
  metrics: {},
  maturity_gaps: [
    '[B4] Missing: Fault-tolerant workloads are not documented for spot/preemptible eligibility.',
    '[D2] Missing: Architecture review does not include automated cost estimation.'
  ],
  antipattern_findings: [],
  silent_areas: ['Missing Capability: C5'],
};

const strategyData = {
  phase_3_strategy: {
    remediation_roadmap: [
      {
        phase: '1. Crawl',
        actions: [
          'Pilot spot fallback rules for batch workloads [TAC-OPT-001]',
          'Add Infracost checks to Terraform pull requests [TAC-GOV-001]',
          'Create outcome tracking KPIs for the FinOps team [TAC-GOV-004]',
          'Run blameless cost reviews [TAC-CULT-004]',
          'Move measurement from activity-based to outcome-based FinOps reporting',
          'Evaluate embedded finance partner coverage to sustain product team growth'
        ]
      }
    ]
  }
};

const result = sanitizeRoadmapTacticGrounding(strategyData, phase2);
const actions = result.strategyData.phase_3_strategy.remediation_roadmap[0].actions;

assert.equal(result.adjustments.length, 6);
assert.ok(actions[0].includes('[TAC-OPT-004]'), 'spot action should use the spot tactic');
assert.ok(actions[1].includes('[TAC-ARCH-002]'), 'Infracost action should use architecture cost-estimation tactic');
assert.ok(!actions[2].includes('[TAC-GOV-004]'), 'outcome tactic should be removed without theater/no-outcome finding');
assert.ok(!actions[3].includes('[TAC-CULT-004]'), 'culture tactic should be removed without blame-culture finding');
assert.ok(actions.every(action => !action.includes('activity-based')), 'activity-to-outcome action should be removed without a matching finding');
assert.ok(actions.every(action => !action.includes('product team growth')), 'product-growth action should be removed without a matching finding');

const weakDomainResult = sanitizeRoadmapTacticGrounding({ phase_3_strategy: { remediation_roadmap: [{
  phase: '1. Crawl',
  actions: ['Implement AI cost attribution [TAC-AI-001]'],
}], planning_decision: { safe_to_act_on: ['Implement AI cost attribution [TAC-AI-001]'] } } }, phase2, ['F']);
assert.deepEqual(weakDomainResult.strategyData.phase_3_strategy.remediation_roadmap, []);
assert.deepEqual(weakDomainResult.strategyData.phase_3_strategy.planning_decision.safe_to_act_on, []);
assert.ok(weakDomainResult.warnings.some(warning => /incomplete source coverage/.test(warning)));

console.log('tactic grounding unit tests passed');
