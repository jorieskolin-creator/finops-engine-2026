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
  scannerEvidenceCheckDisagreementTitle,
  splitQualityGateDiagnostics,
} = await import(`file://${modulePath}`);

const disagreement = 'Phase 1: maturity.A1: Score 0 but evidence does not indicate silence';
const normalWarning = 'Anti-pattern coverage 24% < 60% — low burden mostly means not assessable, not proven absence.';

assert.equal(isScannerEvidenceCheckDisagreement(disagreement), true);
assert.equal(isScannerEvidenceCheckDisagreement(normalWarning), false);
assert.equal(
  displayQualityGateDiagnostic(disagreement),
  `${scannerEvidenceCheckDisagreementTitle}: maturity.A1: Score 0 but evidence does not indicate silence`
);

const split = splitQualityGateDiagnostics({
  decision: 'BLOCK',
  blocking_reasons: ['Evidence density 24% < 30% floor.'],
  warnings: [normalWarning, disagreement],
  notes: [],
  thresholds: {},
});

assert.deepEqual(split.primaryWarnings, [normalWarning]);
assert.deepEqual(split.appendixDiagnostics, [disagreement]);

console.log('report diagnostics unit tests passed');
