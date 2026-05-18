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
const parseQualitySource = await readFile(new URL('../src/services/parseQualityService.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'parseQualityService.mjs'), compile(parseQualitySource), 'utf8');
const { assessPdfParseQuality } = await import(`file://${join(dir, 'parseQualityService.mjs')}`);

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
assert.match(pdfSource, /assessPdfParseQuality/, 'PDF extraction should calculate deterministic parse quality');
assert.match(pdfSource, /sparsePages/, 'PDF visual page selection should prioritize sparse pages');

const goodParse = assessPdfParseQuality({
  pages: Array.from({ length: 10 }, (_, idx) => ({ pageNumber: idx + 1, charCount: 1500, wordCount: 220, textItemCount: 80 })),
  visualPagesIncluded: 5,
  visualPagesSkipped: 0
});
assert.equal(goodParse.quality, 'good');
assert.equal(goodParse.textCoverageRatio, 1);

const poorParse = assessPdfParseQuality({
  pages: Array.from({ length: 10 }, (_, idx) => ({ pageNumber: idx + 1, charCount: idx < 8 ? 0 : 400, wordCount: idx < 8 ? 0 : 60, textItemCount: idx < 8 ? 0 : 20 })),
  visualPagesIncluded: 5,
  visualPagesSkipped: 3
});
assert.equal(poorParse.quality, 'poor');
assert.equal(poorParse.likelyScannedPdf, true);
assert.match(poorParse.warnings.join(' '), /scanned or image-heavy/);

const mixedParse = assessPdfParseQuality({
  pages: [
    { pageNumber: 1, charCount: 1200, wordCount: 180, textItemCount: 80 },
    { pageNumber: 2, charCount: 150, wordCount: 20, textItemCount: 6 },
    { pageNumber: 3, charCount: 1400, wordCount: 200, textItemCount: 90 },
    { pageNumber: 4, charCount: 1600, wordCount: 210, textItemCount: 95 },
    { pageNumber: 5, charCount: 1550, wordCount: 205, textItemCount: 88 }
  ],
  visualPagesIncluded: 2,
  visualPagesSkipped: 0
});
assert.equal(mixedParse.quality, 'mixed');
assert.equal(mixedParse.sparseTextPages, 1);

const budgetParse = assessPdfParseQuality({
  pages: Array.from({ length: 6 }, (_, idx) => ({ pageNumber: idx + 1, charCount: idx < 3 ? 100 : 900, wordCount: idx < 3 ? 15 : 130, textItemCount: idx < 3 ? 4 : 50 })),
  visualPagesIncluded: 2,
  visualPagesSkipped: 4,
  imageBudgetReached: true
});
assert.match(budgetParse.warnings.join(' '), /image budget/);

const appParseSource = appSource;
assert.match(appParseSource, /SOURCE_PARSE_QUALITY/, 'mixed or poor PDF parse quality should be passed into source context');
assert.match(appParseSource, /Good text extraction/, 'upload card should label good PDF extraction');
assert.match(appParseSource, /Mixed extraction: some visual\/scanned pages included/, 'upload card should warn about mixed PDF extraction');
assert.match(appParseSource, /Poor extraction: likely scanned\/image-heavy PDF/, 'upload card should warn about poor PDF extraction');

console.log('input parsing regression tests passed');
