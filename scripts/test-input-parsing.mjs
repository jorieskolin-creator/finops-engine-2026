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

const dir = await mkdtemp(join(tmpdir(), 'finops-input-parsing-'));
const tableSource = await readFile(new URL('../src/services/tableService.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'tableService.mjs'), compile(tableSource), 'utf8');
const { renderDelimitedTableForAnalysis } = await import(`file://${join(dir, 'tableService.mjs')}`);

const csv = renderDelimitedTableForAnalysis('service,cost\ncompute,12\nstorage,7', {
  fileName: 'costs.csv',
  delimiter: ',',
});
assert.match(csv.text, /Format: CSV/);
assert.match(csv.text, /Rows: 2/);
assert.match(csv.text, /Headers: service \| cost/);
assert.match(csv.text, /compute \| 12/);

const tsv = renderDelimitedTableForAnalysis('team\towner\nplatform\tfinance', {
  fileName: 'teams.tsv',
  delimiter: '\t',
});
assert.match(tsv.text, /Format: TSV/);
assert.match(tsv.text, /Rows: 1/);
assert.match(tsv.text, /platform \| finance/);

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /const MAX_FILES = 20;/, 'artifact limit should be raised to 20');
assert.match(appSource, /const MAX_TOTAL_UPLOAD_MB = 25;/, 'upload limit should be applied to the total set');
assert.doesNotMatch(appSource, /MAX_FILE_SIZE_MB/, 'per-file 25MB cap should not be used');
assert.match(appSource, /\.tsv/, 'TSV files should be accepted');
assert.doesNotMatch(appSource, /Irrelevant File Detected/, 'low-relevance files should warn, not hard-block');

const pdfSource = await readFile(new URL('../src/services/pdfService.ts', import.meta.url), 'utf8');
assert.match(pdfSource, /DEFAULT_MAX_TEXT_PAGES = 100/, 'PDF text extraction should cover up to 100 pages');
assert.match(pdfSource, /PDF_PAGE source=/, 'PDF extraction should preserve page markers');
assert.match(pdfSource, /Visual page extraction stopped/, 'PDF visual extraction should include an image budget warning');

console.log('input parsing regression tests passed');
