import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = source => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-run-trace-tactics-'));
await writeFile(join(dir, 'knowledgeBase.mjs'), `
export const FINOPS_TACTIC_PLAYBOOK_URL = 'https://example.test/';
export const FINOPS_TACTIC_PLAYBOOK_VERSION = '1.0.0';
export const FINOPS_TACTIC_ACTIVITY_PLAYBOOK = [{
  tactic_id: 'TAC-VIS-001',
  maturity_bindings: [{ criterion_id: 'A1', relationship: 'PRIMARY' }],
  antipattern_bindings: [{ criterion_id: 'AP-A1', relationship: 'PRIMARY' }],
}, {
  tactic_id: 'TAC-OPT-001',
  maturity_bindings: [{ criterion_id: 'B1', relationship: 'PRIMARY' }, { criterion_id: 'C4', relationship: 'SUPPORTING' }],
  antipattern_bindings: [],
}];
export const FINOPS_CRITERIA = [
  { id: 'A1', title: 'Cost allocation tagging', description: 'Enforced tags identify untagged resources and allocate spend.' },
  { id: 'B1', title: 'Commitment management', description: 'Commitment coverage and utilization govern reserved purchases.' },
  { id: 'B5', title: 'Storage lifecycle policies', description: 'Retention and lifecycle tiering govern storage.' },
  { id: 'C4', title: 'Commercial governance', description: 'Vendor terms and exit costs govern commercial commitments.' },
  { id: 'D5', title: 'Container optimization', description: 'Container and serverless cost practices.' },
  { id: 'F1', title: 'AI cost visibility', description: 'Token and model spend visibility.' },
  { id: 'F2', title: 'AI allocation', description: 'AI platform allocation and unit metrics.' },
  { id: 'F3', title: 'AI efficiency', description: 'Model routing and context efficiency.' },
  { id: 'F4', title: 'AI budget controls', description: 'Token quotas and model tier controls.' },
  { id: 'F5', title: 'AI value', description: 'AI value and use-case outcomes.' },
];
export const FINOPS_ANTIPATTERNS = [{ id: 'A1', title: 'Missing tags', description: 'Resources are untagged.' }];
export const FINOPS_TACTICS_LOCAL = [{ id: 'TAC-VIS-001' }, { id: 'TAC-OPT-001' }];
export const FINOPS_TAXONOMY_REGISTRY = { version: 'test' };
`, 'utf8');
await writeFile(join(dir, 'helpers.mjs'), `
export const inferAntiPatternAbsenceStatus = item => item?.antipattern_absence_status || (item?.count > 0 ? 'partially_present' : 'unknown_absent');
export const hasVerifiedSourceCoverage = item => !item.verification_unresolved && item.assessment_status !== 'not_assessed' && item.evidence_quotes?.some(quote => quote.quote);
export const scrubGeneratedText = value => ({ text: value });
`, 'utf8');

const source = await readFile(new URL('../src/services/runTraceService.ts', import.meta.url), 'utf8');
const modulePath = join(dir, 'runTraceService.mjs');
await writeFile(modulePath, compile(source)
  .replace("from '../knowledge_base'", "from './knowledgeBase.mjs'")
  .replace("from './antiPatternSemantics'", "from './helpers.mjs'")
  .replace("from './metricsService'", "from './helpers.mjs'")
  .replace("from './privacyService'", "from './helpers.mjs'"), 'utf8');

const { buildRunTrace } = await import(`file://${modulePath}`);
const auditItem = (count, evidence, reasoning) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence,
  reasoning,
  assessment_status: 'assessed',
  evidence_check_status: 'supported',
  evidence_quotes: [{ quote: evidence, source_id: 'src-1', chunk_id: 'chunk-1' }],
});
const gapItem = reasoning => ({
  count: 0,
  status: 'NOK',
  evidence: 'Document is silent.',
  reasoning,
  assessment_status: 'not_assessed',
  evidence_check_status: 'supported',
  evidence_quotes: [],
});
const trace = buildRunTrace({
  runId: 'run-1',
  engineVersion: 'test',
  sourceRegistry: { chunks: [], warnings: [], source_acquisition: [] },
  sourcePackets: {},
  dlpScan: { scanned_chunk_count: 0, high_risk_hits: [], caution_hits: [], blocked: false, warnings: [] },
  dlpReviewChunkCount: 0,
  referenceKbIndex: { documents: [] },
  stageTraces: [],
  auditLogs: {
    maturity: {
      A1: auditItem(1, 'Many resources remain untagged.', 'Tagging policy is not enforced for untagged resources.'),
      B1: auditItem(3, 'Commitment coverage is 68% against a 72% target.', 'Commitment coverage and utilization are reviewed monthly.'),
      B5: auditItem(0, 'Storage retention is manual.', 'Storage lifecycle and retention controls are absent.'),
      C4: auditItem(1, 'Exit costs cover tier-one systems.', 'Commercial exit-cost coverage is incomplete.'),
      D5: gapItem('Container and serverless optimization were not assessed.'),
      F1: gapItem('AI cost visibility was not assessed.'),
      F2: gapItem('AI allocation was not assessed.'),
      F3: gapItem('AI efficiency was not assessed.'),
      F4: gapItem('AI budget controls were not assessed.'),
      F5: gapItem('AI value was not assessed.'),
    },
    antipattern: {},
  },
  phase2: {},
  strategy: {
    remediation_roadmap: [{
      phase: 'Crawl',
      actions: [
        'Enforce tagging for untagged resources [TAC-VIS-001]',
        'Create a storage lifecycle retention register with restore acceptance checks',
        'Run an unrelated celebration event [TAC-VIS-001]',
        'Move commitment coverage from 68% toward 72% using monthly utilization review [TAC-OPT-001]',
        'Collect evidence for D5 and F1-F5 before designing container or AI controls',
      ],
    }],
  },
  qualityGate: { decision: 'GO', blocking_reasons: [], warnings: [], notes: [], thresholds: {} },
  tacticGroundingAdjustments: [],
});

const [tagging, customStorage, unrelated, commitment, assessmentGaps] = trace.tactic_paths;
assert.deepEqual(tagging.linked_findings.map(finding => finding.slice(0, 4)), ['[A1]']);
assert.equal(tagging.grounding_status, 'grounded');
assert.deepEqual(customStorage.linked_findings.map(finding => finding.slice(0, 4)), ['[B5]']);
assert.equal(customStorage.reference_kind, 'custom_action');
assert.equal(customStorage.grounding_status, 'evidence_grounded_no_tactic_match');
assert.deepEqual(unrelated.linked_findings, []);
assert.equal(unrelated.grounding_status, 'unknown');
assert.deepEqual(commitment.linked_findings.map(finding => finding.slice(0, 4)), ['[B1]']);
assert.equal(commitment.grounding_status, 'grounded');
assert.deepEqual(assessmentGaps.linked_findings.map(finding => finding.match(/^\[([^\]]+)/)?.[1]), ['D5', 'F1', 'F2', 'F3', 'F4', 'F5']);
assert.equal(assessmentGaps.grounding_status, 'assessment_gap_linked_no_tactic_match');
assert.match(assessmentGaps.notes[0], /not evidence of a customer control deficiency/);
assert.ok(trace.tactic_paths.every(path => path.linked_findings.length <= 6));

console.log('RunTrace action-specific tactic provenance tests passed');
