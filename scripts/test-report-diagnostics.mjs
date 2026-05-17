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

console.log('report diagnostics unit tests passed');
