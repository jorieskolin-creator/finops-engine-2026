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

const dir = await mkdtemp(join(tmpdir(), 'finops-maturity-shadow-'));
const registry = JSON.parse(await readFile(new URL('../src/knowledge_base/finops_maturity_pair_registry.json', import.meta.url), 'utf8'));
const semanticsSource = await readFile(new URL('../src/services/antiPatternSemantics.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'antiPatternSemantics.mjs'), transpile(semanticsSource), 'utf8');
const serviceSource = (await readFile(new URL('../src/services/maturityShadowService.ts', import.meta.url), 'utf8'))
  .replace(
    "import { FINOPS_MATURITY_PAIR_REGISTRY } from '../knowledge_base';",
    `const FINOPS_MATURITY_PAIR_REGISTRY = ${JSON.stringify(registry)};`
  )
  .replace('./antiPatternSemantics', './antiPatternSemantics.mjs');
await writeFile(join(dir, 'maturityShadowService.mjs'), transpile(serviceSource), 'utf8');
const { calculateResolutionBasedMaturityShadow } = await import(`file://${join(dir, 'maturityShadowService.mjs')}`);
const analysisSource = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');

const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domain => [1, 2, 3, 4, 5].map(index => `${domain}${index}`));
const directQuote = { quote: 'Provenance-bound criterion evidence.', evidence_source: 'text', source_id: 'SRC-1', chunk_id: 'CHK-1' };
const derivedQuote = { quote: 'Approved deterministic summary line.', evidence_source: 'derived', source_id: 'SRC-1', derived_evidence_id: 'EVID-DER-1' };
const capability = (count, quote = directQuote) => ({
  count,
  status: count === 3 ? 'OK' : count === 0 ? 'NOK' : 'Partial',
  evidence: 'Resolved capability.',
  evidence_quotes: quote ? [quote] : [],
  assessment_status: quote ? 'assessed' : 'not_assessed',
  evidence_check_status: quote ? 'supported' : 'missing',
});
const antipattern = (count, status, quote = count > 0 ? directQuote : null) => ({
  count,
  status: count === 3 ? 'NOK' : count === 0 ? 'OK' : 'Partial',
  evidence: 'Resolved anti-pattern.',
  evidence_quotes: quote ? [quote] : [],
  assessment_status: status === 'unknown_absent' ? 'not_assessed' : 'assessed',
  evidence_check_status: status === 'unknown_absent' ? 'missing' : 'supported',
  antipattern_absence_status: status,
  coverage_reason: status === 'tested_absent' ? 'Relevant criterion coverage was reviewed and the anti-pattern was not found.' : undefined,
});
const logs = (capabilityFactory, antipatternFactory) => ({
  maturity: Object.fromEntries(ids.map((id, index) => [id, capabilityFactory(id, index)])),
  antipattern: Object.fromEntries(ids.map((id, index) => [id, antipatternFactory(id, index)])),
});

{
  const result = calculateResolutionBasedMaturityShadow(logs(
    () => capability(0, null),
    () => antipattern(0, 'unknown_absent', null),
  ));
  assert.equal(result.overall.corroborated_maturity, null);
  assert.equal(result.overall.observed_maturity, null);
  assert.equal(result.overall.adjusted_maturity, null);
  assert.equal(result.overall.resolution, 0);
  assert.equal(result.overall.unresolved_pair_count, 30);
  assert.ok(result.criterion_resolutions.every(record => record.normalized_value === null), 'unknown evidence must remain NA');
}

{
  const result = calculateResolutionBasedMaturityShadow(logs(
    () => capability(3),
    (_id, index) => index < 15 ? antipattern(0, 'tested_absent', null) : antipattern(3, 'confirmed_present'),
  ));
  assert.equal(result.overall.resolution, 100);
  const antipatternHealth = result.criterion_resolutions
    .filter(record => record.stream === 'antipattern')
    .reduce((sum, record) => sum + record.normalized_value, 0) / 30;
  assert.equal(antipatternHealth, 0.5, '15 tested absences and 15 confirmed findings must produce 50% anti-pattern health');
  assert.equal(result.overall.corroborated_maturity, 51.7, 'reviewed non-inverse relationships retain their registered arithmetic component');
  assert.equal(result.overall.observed_maturity, 51.7);
  assert.equal(result.overall.adjusted_maturity, 51.7);
  assert.equal(result.overall.fully_resolved_pair_count, 30);
  assert.equal(result.overall.contradiction_count, 15);
}

{
  const fixture = logs(
    () => capability(0, null),
    (_id, index) => index === 0
      ? antipattern(0, 'tested_absent', null)
      : index === 1
        ? antipattern(1, 'partially_present')
        : index === 2
          ? antipattern(2, 'partially_present')
          : index === 3
            ? antipattern(3, 'confirmed_present')
            : antipattern(0, 'unknown_absent', null),
  );
  const result = calculateResolutionBasedMaturityShadow(fixture);
  const health = result.criterion_resolutions
    .filter(record => record.stream === 'antipattern')
    .slice(0, 4)
    .map(record => record.normalized_value);
  assert.deepEqual(health, [1, 2 / 3, 1 / 3, 0], 'the complete anti-pattern 0/3 through 3/3 scale must be retained');
}

{
  const result = calculateResolutionBasedMaturityShadow(logs(
    () => capability(3),
    () => antipattern(0, 'unknown_absent', null),
  ));
  assert.equal(result.overall.corroborated_maturity, null);
  assert.equal(result.overall.observed_maturity, 100);
  assert.equal(result.overall.resolution, 50);
  assert.equal(result.overall.adjusted_maturity, 70.7);
  assert.equal(result.overall.partially_resolved_pair_count, 30);
}

{
  const fixture = logs(
    (id) => id === 'A1' ? capability(2, derivedQuote) : capability(0, null),
    () => antipattern(0, 'unknown_absent', null),
  );
  const result = calculateResolutionBasedMaturityShadow(fixture);
  const derived = result.criterion_resolutions.find(record => record.stream === 'maturity' && record.criterion_id === 'A1');
  assert.equal(derived.state, 'RESOLVED');
  assert.equal(derived.evidence_basis, 'DERIVED');
  assert.equal(derived.normalized_value, 2 / 3);
}

{
  const unboundQuote = { quote: 'Unbound assertion without provenance.' };
  const fixture = logs(
    (id) => id === 'A1' ? capability(3, unboundQuote) : capability(0, null),
    () => antipattern(0, 'unknown_absent', null),
  );
  const result = calculateResolutionBasedMaturityShadow(fixture);
  const unbound = result.criterion_resolutions.find(record => record.stream === 'maturity' && record.criterion_id === 'A1');
  assert.equal(unbound.state, 'UNKNOWN', 'an unbound quote must not resolve maturity even if the candidate count is 3/3');
  assert.equal(unbound.normalized_value, null);
}

{
  const fixture = logs(
    (id) => id === 'A1' ? { ...capability(3), verification_unresolved: true, verified_count: null } : capability(0, null),
    () => antipattern(0, 'unknown_absent', null),
  );
  const before = structuredClone(fixture);
  const result = calculateResolutionBasedMaturityShadow(fixture);
  const unresolved = result.criterion_resolutions.find(record => record.stream === 'maturity' && record.criterion_id === 'A1');
  assert.equal(unresolved.state, 'VERIFICATION_UNRESOLVED');
  assert.equal(unresolved.normalized_value, null);
  assert.deepEqual(fixture, before, 'the shadow calculator must not mutate authoritative logs');
}

{
  const reconciliationIndex = analysisSource.indexOf('reconcileEvidenceProvenance(');
  const sanitationIndex = analysisSource.indexOf('const auditLogs = validateAndSanitizeLogs(');
  const shadowIndex = analysisSource.indexOf('calculateResolutionBasedMaturityShadow(auditLogs)');
  assert.ok(reconciliationIndex >= 0 && reconciliationIndex < sanitationIndex && sanitationIndex < shadowIndex,
    'runtime shadow calculation must remain downstream of provenance reconciliation and final sanitation');
}

console.log('resolution-based maturity shadow tests passed');
