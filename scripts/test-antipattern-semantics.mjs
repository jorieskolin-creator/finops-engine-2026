import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-antipattern-semantics-'));

const antiPatternSource = await readFile(new URL('../src/services/antiPatternSemantics.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'antiPatternSemantics.mjs'), transpile(antiPatternSource), 'utf8');

const metricsSource = (await readFile(new URL('../src/services/metricsService.ts', import.meta.url), 'utf8'))
  .replace(
    "import { BATCH_TITLES, FINOPS_ANTIPATTERNS, FINOPS_CRITERIA } from '../knowledge_base';",
    "const BATCH_TITLES = { A: '', B: '', C: '', D: '', E: '', F: '' }; const FINOPS_ANTIPATTERNS = Array(30); const FINOPS_CRITERIA = Array(30);"
  )
  .replace('./antiPatternSemantics', './antiPatternSemantics.mjs');
await writeFile(join(dir, 'metricsService.mjs'), transpile(metricsSource), 'utf8');

const {
  inferAntiPatternAbsenceStatus,
  resolveAntiPatternAbsenceStatus
} = await import(`file://${join(dir, 'antiPatternSemantics.mjs')}`);
const { calculateMetrics } = await import(`file://${join(dir, 'metricsService.mjs')}`);

assert.equal(
  resolveAntiPatternAbsenceStatus({
    verifiedCount: 0,
    originalCount: 1,
    explicitStatus: 'tested_absent',
    evidenceStatus: 'weak',
    rationale: 'The cited material supports partial presence of cost-blind architecture, but not a full score.',
  }),
  'partially_present',
  'weak anti-pattern evidence must not collapse into tested_absent'
);

assert.equal(
  inferAntiPatternAbsenceStatus({
    count: 0,
    antipattern_absence_status: 'tested_absent',
    reasoning: 'Final anti-pattern assessment: Tested absent. Verifier status: weak. The source supports partial presence of server-hugging behavior.',
  }),
  'partially_present',
  'partial harmful-pattern rationale overrides a stale tested_absent flag'
);

assert.equal(
  inferAntiPatternAbsenceStatus({
    count: 0,
    evidence_quotes: [{ quote: 'The source discusses the topic.' }],
    reasoning: 'The source does not establish whether the anti-pattern is absent.',
  }),
  'unknown_absent',
  'a source quote alone must never imply tested absence'
);

assert.equal(
  inferAntiPatternAbsenceStatus({
    count: 0,
    antipattern_absence_status: 'tested_absent',
    evidence_check_status: 'supported',
    coverage_reason: 'Final anti-pattern assessment: Not assessed. Absence cannot be confirmed from silence.',
    reasoning: 'The source is effectively silent on the criterion.',
  }),
  'unknown_absent',
  'not-assessed language must override a contradictory tested-absence flag'
);

assert.equal(
  inferAntiPatternAbsenceStatus({
    count: 0,
    antipattern_absence_status: 'tested_absent',
    reasoning: 'Coverage notes say there is partial tunnel vision in provider operations.',
  }),
  'partially_present',
  'domain-specific partial anti-pattern wording should not stay tested_absent'
);

assert.equal(
  resolveAntiPatternAbsenceStatus({
    verifiedCount: 0,
    originalCount: 1,
    explicitStatus: 'tested_absent',
    evidenceStatus: 'unsupported',
    rationale: 'The quote could not be located in the source.',
  }),
  'unknown_absent',
  'unsupported scanner signals become unknown absence, not positive absence'
);

assert.equal(
  resolveAntiPatternAbsenceStatus({
    verifiedCount: 0,
    originalCount: 0,
    explicitStatus: 'tested_absent',
    evidenceStatus: 'supported',
    coverageReason: 'Relevant coverage was reviewed and the anti-pattern was not found.',
  }),
  'tested_absent',
  'true verified absence remains tested_absent'
);

const metrics = calculateMetrics({
  maturity: {},
  antipattern: {
    D2: {
      id: 'D2',
      criterion: 'Cost-Blind Architecture',
      count: 0,
      status: 'OK',
      evidence: 'Evidence-check found a partial cost-blind architecture signal.',
      reasoning: 'Final anti-pattern assessment: Partial finding. Verifier status: weak.',
      antipattern_absence_status: 'partially_present',
      assessment_status: 'assessed',
      evidence_check_status: 'weak',
      evidence_quotes: [{ quote: 'Partial cost-blind architecture signal.', evidence_source: 'text' }],
    },
  },
});

assert.ok(
  metrics.metrics.antipattern_burden > 0,
  'partial anti-pattern findings must contribute to anti-pattern burden'
);
assert.equal(
  metrics.metrics.antipattern_clearance,
  0,
  'partial anti-pattern findings must not contribute to clearance'
);
assert.equal(
  metrics.metrics.antipattern_coverage,
  3,
  'partial anti-pattern findings should count as assessed coverage'
);
assert.match(
  metrics.antipattern_findings.join('\n'),
  /Partial finding/,
  'metrics should expose partial findings as findings'
);

console.log('anti-pattern semantics tests passed');
