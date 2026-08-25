import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const transpile = source => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-maturity-calibration-'));
const registry = JSON.parse(await readFile(new URL('../src/knowledge_base/finops_maturity_pair_registry.json', import.meta.url), 'utf8'));
await writeFile(
  join(dir, 'antiPatternSemantics.mjs'),
  transpile(await readFile(new URL('../src/services/antiPatternSemantics.ts', import.meta.url), 'utf8')),
  'utf8'
);
const serviceSource = (await readFile(new URL('../src/services/maturityShadowService.ts', import.meta.url), 'utf8'))
  .replace(
    "import { FINOPS_MATURITY_PAIR_REGISTRY } from '../knowledge_base';",
    `const FINOPS_MATURITY_PAIR_REGISTRY = ${JSON.stringify(registry)};`
  )
  .replace('./antiPatternSemantics', './antiPatternSemantics.mjs');
await writeFile(join(dir, 'maturityShadowService.mjs'), transpile(serviceSource), 'utf8');
const { calculateResolutionBasedMaturityShadow } = await import(`file://${join(dir, 'maturityShadowService.mjs')}`);

const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domain => [1, 2, 3, 4, 5].map(index => `${domain}${index}`));
const quote = { quote: 'Governed calibration evidence.', evidence_source: 'text', source_id: 'SRC-CAL', chunk_id: 'CHK-CAL' };
const capability = (count, resolved = true) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence: resolved ? 'Governed calibration evidence.' : 'Not assessed.',
  evidence_quotes: resolved ? [quote] : [],
  assessment_status: resolved ? 'assessed' : 'not_assessed',
  evidence_check_status: resolved ? 'supported' : 'missing',
});
const antipattern = (count, resolved = true) => ({
  count,
  status: count === 3 ? 'NOK' : count === 0 ? 'OK' : 'Partial',
  evidence: resolved ? 'Governed calibration evidence.' : 'Not assessed.',
  evidence_quotes: resolved && count > 0 ? [quote] : [],
  assessment_status: resolved ? 'assessed' : 'not_assessed',
  evidence_check_status: resolved ? 'supported' : 'missing',
  antipattern_absence_status: resolved ? count === 0 ? 'tested_absent' : count === 3 ? 'confirmed_present' : 'partially_present' : 'unknown_absent',
  coverage_reason: resolved && count === 0 ? 'Relevant criterion coverage was reviewed and the anti-pattern was not found.' : undefined,
});
const scenario = (capabilityFactory, antipatternFactory) => calculateResolutionBasedMaturityShadow({
  maturity: Object.fromEntries(ids.map((id, index) => [id, capabilityFactory(id, index)])),
  antipattern: Object.fromEntries(ids.map((id, index) => [id, antipatternFactory(id, index)])),
});

const baselines = [
  {
    id: 'NO_EVIDENCE',
    result: scenario(() => capability(0, false), () => antipattern(0, false)),
    expected: { corroborated_maturity: null, observed_maturity: null, resolution: 0, adjusted_maturity: null },
  },
  {
    id: 'FULLY_HEALTHY',
    result: scenario(() => capability(3), () => antipattern(0)),
    expected: { corroborated_maturity: 100, observed_maturity: 100, resolution: 100, adjusted_maturity: 100 },
  },
  {
    id: 'FULLY_ADVERSE',
    result: scenario(() => capability(0), () => antipattern(3)),
    expected: { corroborated_maturity: 0, observed_maturity: 0, resolution: 100, adjusted_maturity: 0 },
  },
  {
    id: 'BALANCED_TWO_OF_THREE',
    result: scenario(() => capability(2), () => antipattern(1)),
    expected: { corroborated_maturity: 66.7, observed_maturity: 66.7, resolution: 100, adjusted_maturity: 66.7 },
  },
  {
    id: 'CAPABILITY_ONLY_HIGH',
    result: scenario(() => capability(3), () => antipattern(0, false)),
    expected: { corroborated_maturity: null, observed_maturity: 100, resolution: 50, adjusted_maturity: 70.7 },
  },
  {
    id: 'SPARSE_SIX_PERFECT_PAIRS',
    result: scenario(
      (_id, index) => capability(index < 6 ? 3 : 0, index < 6),
      (_id, index) => antipattern(0, index < 6),
    ),
    expected: { corroborated_maturity: 100, observed_maturity: 100, resolution: 20, adjusted_maturity: 44.7 },
  },
  {
    id: 'ONE_DOMAIN_UNRESOLVED',
    result: scenario(
      (id) => capability(3, id.charAt(0) !== 'F'),
      (id) => antipattern(0, id.charAt(0) !== 'F'),
    ),
    expected: { corroborated_maturity: 100, observed_maturity: 100, resolution: 83.3, adjusted_maturity: 91.3 },
  },
  {
    id: 'HALF_ABSENT_HALF_PRESENT',
    result: scenario(
      () => capability(3),
      (_id, index) => antipattern(index < 15 ? 0 : 3),
    ),
    expected: { corroborated_maturity: 51.7, observed_maturity: 51.7, resolution: 100, adjusted_maturity: 51.7 },
  },
];

for (const baseline of baselines) {
  assert.deepEqual(
    Object.fromEntries(Object.keys(baseline.expected).map(key => [key, baseline.result.overall[key]])),
    baseline.expected,
    `${baseline.id} changed from the reviewed calibration baseline`
  );
}

const capabilityProgression = [0, 1, 2, 3].map(count =>
  scenario(() => capability(count), () => antipattern(0)).overall.adjusted_maturity
);
assert.deepEqual([...capabilityProgression].sort((a, b) => a - b), capabilityProgression,
  'stronger resolved capability evidence must not reduce adjusted maturity when all else is fixed');

const antipatternBurdenProgression = [0, 1, 2, 3].map(count =>
  scenario(() => capability(3), () => antipattern(count)).overall.adjusted_maturity
);
assert.deepEqual([...antipatternBurdenProgression].sort((a, b) => b - a), antipatternBurdenProgression,
  'increasing resolved anti-pattern burden must not increase adjusted maturity when all else is fixed');

const sparse = baselines.find(item => item.id === 'SPARSE_SIX_PERFECT_PAIRS').result;
assert.ok(sparse.overall.adjusted_maturity > 33 && sparse.overall.resolution < 65,
  'a high sparse signal demonstrates why classification requires a separate sufficiency gate');
const domainBlind = baselines.find(item => item.id === 'ONE_DOMAIN_UNRESOLVED').result;
assert.equal(domainBlind.domains.find(domain => domain.domain_id === 'F').resolution, 0);
assert.ok(domainBlind.overall.resolution >= 65,
  'overall resolution alone must not hide a completely unresolved required domain');

console.log(`maturity calibration baseline passed (${baselines.length} scenarios plus monotonicity invariants)`);
