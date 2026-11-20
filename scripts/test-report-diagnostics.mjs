import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const sourcePath = new URL('../src/services/reportDiagnosticsService.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-report-diagnostics-'));
const modulePath = join(dir, 'reportDiagnosticsService.mjs');
await writeFile(modulePath, compiled, 'utf8');

const {
  displayQualityGateDiagnostic,
  isScannerEvidenceCheckDisagreement,
  isReportableSourceCoverageGap,
  isStrategyHygieneDiagnostic,
  scannerEvidenceCheckDisagreementTitle,
  strategyHygieneNotesTitle,
  splitQualityGateDiagnostics,
} = await import(`file://${modulePath}`);

const disagreement = 'Phase 1: maturity.A1: Score 0 but evidence does not indicate silence';
const normalWarning = 'Anti-pattern coverage 24% < 60% — low burden mostly means not assessable, not proven absence.';
const hygieneWarning = 'Strategy hygiene: 7 non-material wording or taxonomy issue(s) remain after fact-check. These do not invalidate the assessment score.';

assert.equal(isScannerEvidenceCheckDisagreement(disagreement), true);
assert.equal(isScannerEvidenceCheckDisagreement(normalWarning), false);
assert.equal(isStrategyHygieneDiagnostic(hygieneWarning), true);
assert.equal(
  displayQualityGateDiagnostic(disagreement),
  `${scannerEvidenceCheckDisagreementTitle}: maturity.A1: Score 0 but evidence does not indicate silence`
);
assert.equal(
  displayQualityGateDiagnostic(hygieneWarning),
  `${strategyHygieneNotesTitle}: 7 non-material wording or taxonomy issue(s) remain after fact-check. These do not invalidate the assessment score.`
);

const split = splitQualityGateDiagnostics({
  decision: 'BLOCK',
  blocking_reasons: ['Evidence density 24% < 30% floor.'],
  warnings: [normalWarning, disagreement, hygieneWarning],
  notes: [],
  thresholds: {},
});

assert.deepEqual(split.primaryWarnings, [normalWarning]);
assert.deepEqual(split.appendixDiagnostics, [disagreement, hygieneWarning]);

assert.equal(isReportableSourceCoverageGap({
  claim: 'Cloud invoice data is missing.',
  classification: 'unsupported',
  source_location: 'cfo',
  failure_type: 'unsupported_org_claim',
  missing_material: 'Cloud invoices by provider and business unit.'
}), true);

assert.equal(isReportableSourceCoverageGap({
  claim: 'The roadmap action has no exact verified tactic match.',
  classification: 'unsupported',
  source_location: 'roadmap',
  failure_type: 'other',
  severity: 'WARN_TACTIC_HYGIENE',
  missing_material: 'Valid tactic ID from the tactics DB.'
}), false);

assert.equal(isReportableSourceCoverageGap({
  claim: 'The confirmed anti-pattern is mapped to the wrong domain.',
  classification: 'unsupported',
  source_location: 'diagnosis',
  failure_type: 'unsupported_org_claim',
  severity: 'WARN_MISCLASSIFIED_BUT_REAL',
  missing_material: 'Revised wording assigning it to Domain B.'
}), false);

assert.equal(isReportableSourceCoverageGap({
  claim: 'Cost allocation (A1) is the primary organizational constraint.',
  classification: 'unsupported',
  source_location: 'diagnosis',
  failure_type: 'unsupported_org_claim',
  severity: 'BLOCKING_UNSUPPORTED_FACT',
  missing_material: 'Organization-wide evidence proving that A1 is the primary constraint across all FinOps domains.'
}), false, 'rejected bottleneck claims must never ask the user for evidence proving the rejected bottleneck');

assert.equal(isReportableSourceCoverageGap({
  claim: 'A1 is the primary bottleneck.',
  classification: 'unsupported',
  source_location: 'finops_lead',
  failure_type: 'unsupported_org_claim',
  severity: 'BLOCKING_UNSUPPORTED_FACT',
  missing_material: 'Evidence establishing A1 as the primary bottleneck.'
}), false, 'primary bottleneck proof requests in any summary section must be excluded from coverage gaps');

console.log('report diagnostics unit tests passed');
