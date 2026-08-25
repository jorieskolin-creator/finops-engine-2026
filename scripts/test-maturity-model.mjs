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

const dir = await mkdtemp(join(tmpdir(), 'finops-maturity-model-'));
const registry = JSON.parse(await readFile(new URL('../src/knowledge_base/finops_maturity_pair_registry.json', import.meta.url), 'utf8'));
const semanticsSource = await readFile(new URL('../src/services/antiPatternSemantics.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'antiPatternSemantics.mjs'), transpile(semanticsSource), 'utf8');
const serviceSource = (await readFile(new URL('../src/services/maturityModelService.ts', import.meta.url), 'utf8'))
  .replace(
    "import { FINOPS_MATURITY_PAIR_REGISTRY } from '../knowledge_base';",
    `const FINOPS_MATURITY_PAIR_REGISTRY = ${JSON.stringify(registry)};`
  )
  .replace('./antiPatternSemantics', './antiPatternSemantics.mjs');
await writeFile(join(dir, 'maturityModelService.mjs'), transpile(serviceSource), 'utf8');
const { calculateResolutionBasedMaturity, evaluateAssessmentSufficiency } = await import(`file://${join(dir, 'maturityModelService.mjs')}`);
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
  const result = calculateResolutionBasedMaturity(logs(
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
  const result = calculateResolutionBasedMaturity(logs(
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
  const result = calculateResolutionBasedMaturity(fixture);
  const health = result.criterion_resolutions
    .filter(record => record.stream === 'antipattern')
    .slice(0, 4)
    .map(record => record.normalized_value);
  assert.deepEqual(health, [1, 2 / 3, 1 / 3, 0], 'the complete anti-pattern 0/3 through 3/3 scale must be retained');
}

{
  const result = calculateResolutionBasedMaturity(logs(
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
  const result = calculateResolutionBasedMaturity(fixture);
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
  const result = calculateResolutionBasedMaturity(fixture);
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
  const result = calculateResolutionBasedMaturity(fixture);
  const unresolved = result.criterion_resolutions.find(record => record.stream === 'maturity' && record.criterion_id === 'A1');
  assert.equal(unresolved.state, 'VERIFICATION_UNRESOLVED');
  assert.equal(unresolved.normalized_value, null);
  assert.deepEqual(fixture, before, 'the maturity calculator must not mutate authoritative logs');
}

const emptyModel = calculateResolutionBasedMaturity(logs(
  () => capability(0, null),
  () => antipattern(0, 'unknown_absent', null),
));
const sufficiencyFixture = (resolvedCount, overallResolution, options = {}) => {
  const criterion_resolutions = emptyModel.criterion_resolutions.map((record, index) => index < resolvedCount
    ? { ...record, state: 'RESOLVED', evidence_basis: 'DIRECT', normalized_value: 0 }
    : { ...record });
  return evaluateAssessmentSufficiency({
    ...emptyModel,
    criterion_resolutions,
    overall: { ...emptyModel.overall, resolution: overallResolution },
  }, options);
};

{
  const belowFloor = sufficiencyFixture(17, 29.9);
  assert.equal(belowFloor.decision, 'BLOCK', 'evidence and resolution below 30% must block classification');
  assert.equal(belowFloor.policy_version, 'assessment_sufficiency_policy_v2');

  const boundary = sufficiencyFixture(18, 30);
  assert.equal(boundary.decision, 'PASS', 'the 30% hard-floor boundary must publish a classification');
  assert.ok(boundary.warning_reasons.some(reason => /confidence target/.test(reason)), '30% must retain calibration warnings below 60%');

  const reviewedRun = sufficiencyFixture(19, 31.7);
  assert.equal(reviewedRun.decision, 'PASS', 'the reviewed 31.7% run must pass Assessment Sufficiency');
  assert.ok(reviewedRun.warning_reasons.length >= 2);

  const warningBoundary = sufficiencyFixture(36, 60);
  assert.equal(warningBoundary.decision, 'PASS');
  assert.equal(warningBoundary.warning_reasons.some(reason => /confidence target/.test(reason)), false, '60% must clear threshold warnings');
}

{
  const recordsOutsideA = emptyModel.criterion_resolutions.map(record => record.domain_id !== 'A'
    ? { ...record, state: 'RESOLVED', evidence_basis: 'DIRECT', normalized_value: 0 }
    : { ...record });
  const silentA = evaluateAssessmentSufficiency({
    ...emptyModel,
    criterion_resolutions: recordsOutsideA,
    overall: { ...emptyModel.overall, resolution: 83.3 },
  });
  assert.equal(silentA.decision, 'PASS', 'a silent domain must not globally block classification');
  assert.deepEqual(silentA.silent_domain_ids, ['A']);
  assert.equal(silentA.domain_criterion_evidence_density.A, 0);

  const oneResolvedA = recordsOutsideA.map((record, index) => index === 0
    ? { ...record, state: 'RESOLVED', evidence_basis: 'DIRECT', normalized_value: 0 }
    : record);
  const tenPercentA = evaluateAssessmentSufficiency({
    ...emptyModel,
    criterion_resolutions: oneResolvedA,
    overall: { ...emptyModel.overall, resolution: 85 },
  });
  assert.equal(tenPercentA.domain_criterion_evidence_density.A, 10);
  assert.equal(tenPercentA.silent_domain_ids.includes('A'), false, 'exactly 10% is not silent under the strict <10% rule');
}

{
  const provenanceRecords = emptyModel.criterion_resolutions.map((record, index) => index < 36
    ? { ...record, state: 'RESOLVED', evidence_basis: index === 0 ? 'NONE' : 'DIRECT', normalized_value: 0 }
    : record);
  const provenanceFailure = evaluateAssessmentSufficiency({
    ...emptyModel,
    criterion_resolutions: provenanceRecords,
    overall: { ...emptyModel.overall, resolution: 60 },
  });
  assert.equal(provenanceFailure.decision, 'BLOCK', 'provenance integrity remains a hard blocker');
  const unresolved = emptyModel.criterion_resolutions.map((record, index) => index === 0
    ? { ...record, state: 'VERIFICATION_UNRESOLVED' }
    : record);
  const verificationFailure = evaluateAssessmentSufficiency({
    ...emptyModel,
    criterion_resolutions: unresolved,
    overall: { ...emptyModel.overall, resolution: 60 },
  });
  assert.equal(verificationFailure.decision, 'BLOCK', 'unresolved verification remains a hard blocker');
  assert.equal(sufficiencyFixture(36, 60, { evidencePacketReady: false }).decision, 'BLOCK', 'packet readiness remains a hard blocker');
}

{
  const reconciliationIndex = analysisSource.indexOf('reconcileEvidenceProvenance(');
  const sanitationIndex = analysisSource.indexOf('const auditLogs = validateAndSanitizeLogs(');
  const calculationIndex = analysisSource.indexOf('calculateMetrics(auditLogs');
  assert.ok(reconciliationIndex >= 0 && reconciliationIndex < sanitationIndex && sanitationIndex < calculationIndex,
    'runtime maturity calculation must remain downstream of provenance reconciliation and final sanitation');
}

console.log('active resolution-based maturity model tests passed');
