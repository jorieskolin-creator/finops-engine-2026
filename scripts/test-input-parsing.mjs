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
assert.equal(csv.rowCount, 2);
assert.equal(csv.renderedRowCount, 2);
assert.equal(csv.structuredTable.schema_version, 'structured_table_v1');
assert.deepEqual(csv.structuredTable.headers, ['service', 'cost']);
assert.equal(csv.structuredTable.total_row_count, 2);
assert.equal(csv.structuredTable.truncated, false);

const largeCsv = renderDelimitedTableForAnalysis(`service,cost\n${Array.from({ length: 151 }, (_, index) => `svc-${index},${index}`).join('\n')}`, {
  fileName: 'large-costs.csv',
  delimiter: ',',
  sourceHash: 'a'.repeat(64),
});
assert.equal(largeCsv.rowCount, 151);
assert.equal(largeCsv.renderedRowCount, 150);
assert.equal(largeCsv.structuredTable.truncated, true);
assert.equal(largeCsv.structuredTable.analysis_rows.length, 151);
assert.equal(largeCsv.structuredTable.analysis_complete, true);
assert.equal(largeCsv.structuredTable.sample_strategy_version, 'deterministic_table_sample_v1');
assert.equal(largeCsv.structuredTable.sample_seed_hash, 'a'.repeat(64));
assert.ok(largeCsv.structuredTable.sampled_row_numbers.includes(152), 'last-row boundary must be represented');
assert.match(largeCsv.warnings.join(' '), /deterministic bounded sample of 150 rows/);

const samplingRaw = `owner,cost\n${Array.from({ length: 300 }, (_, index) => `${index % 17 === 0 ? '' : `owner-${index}`},${index === 240 ? 999999 : index}`).join('\n')}`;
const deterministicSampleA = renderDelimitedTableForAnalysis(samplingRaw, { fileName: 'sample.csv', delimiter: ',', sourceHash: 'b'.repeat(64) });
const deterministicSampleARepeat = renderDelimitedTableForAnalysis(samplingRaw, { fileName: 'sample.csv', delimiter: ',', sourceHash: 'b'.repeat(64) });
const deterministicSampleB = renderDelimitedTableForAnalysis(samplingRaw, { fileName: 'sample.csv', delimiter: ',', sourceHash: 'c'.repeat(64) });
assert.deepEqual(deterministicSampleA.structuredTable.sampled_row_numbers, deterministicSampleARepeat.structuredTable.sampled_row_numbers, 'same source hash must reproduce the same sample');
assert.notDeepEqual(deterministicSampleA.structuredTable.sampled_row_numbers, deterministicSampleB.structuredTable.sampled_row_numbers, 'source hash participates in bounded random selection');
assert.ok(deterministicSampleA.structuredTable.sampled_row_numbers.includes(242), 'numeric extreme row must be selected with its exact CSV row locator');
assert.ok(deterministicSampleA.structuredTable.sampled_row_reasons.some(reasons => reasons.includes('MISSING_RECOGNIZED_FIELD')));
assert.match(deterministicSampleA.text, /\[ROW 242 reasons=[^\]]*NUMERIC_EXTREME/);

const profiledCsv = renderDelimitedTableForAnalysis('owner,cost,date,active\nAlice,USD 10,2026-01,true\n,EUR 20,2026-02,false\n,EUR 20,2026-02,false', { fileName: 'profile.csv', delimiter: ',' });
const inspection = profiledCsv.structuredTable.deterministic_inspection;
assert.equal(inspection.schema_version, 'deterministic_table_inspection_v1');
assert.equal(inspection.population_scope, 'FULL_TABLE');
assert.equal(inspection.duplicate_row_count, 1);
assert.equal(inspection.duplicate_row_rate_percent, 33.33);
assert.equal(inspection.duplicate_definition, 'REPEATED_ROWS_AFTER_FIRST_OCCURRENCE');
assert.equal(inspection.type_consistency_definition, 'DOMINANT_NON_EMPTY_TYPE_SHARE');
assert.deepEqual(inspection.columns.map(column => column.inferred_type), ['STRING', 'INTEGER', 'DATE', 'BOOLEAN']);
assert.equal(inspection.columns[0].blank_rate_percent, 66.67);
assert.deepEqual(inspection.columns[1].detected_currencies, ['EUR', 'USD']);
assert.doesNotMatch(profiledCsv.text, /deterministic_table_inspection|duplicate_row_rate/, 'unapproved inspection metrics must remain local and outside model context');

const clippedCsv = renderDelimitedTableForAnalysis(`service,description\ncompute,${'x'.repeat(300)}`, {
  fileName: 'long-cell.csv',
  delimiter: ',',
});
assert.equal(clippedCsv.clippedCellCount, 1);
assert.ok(clippedCsv.cellCharacterCoverageRatio < 1);
assert.match(clippedCsv.warnings.join(' '), /cell\(s\).*truncated/);

assert.throws(()=>renderDelimitedTableForAnalysis(`${Array.from({length:201},(_,i)=>`column_${i}`).join(',')}\n${Array.from({length:201},()=>1).join(',')}`, { fileName:'wide.csv', delimiter:',' }),/DELIMITED_TABLE_COLUMN_LIMIT_EXCEEDED/);
const manyRowsCsv = renderDelimitedTableForAnalysis(`owner\n${Array.from({length:10000},(_,i)=>`owner-${i}`).join('\n')}`, { fileName:'many.csv', delimiter:',' });
assert.equal(manyRowsCsv.rowCount,10000);assert.equal(manyRowsCsv.structuredTable.rows.length,150);assert.equal(manyRowsCsv.structuredTable.analysis_rows.length,10000);assert.equal(manyRowsCsv.structuredTable.analysis_complete,true);assert.equal(manyRowsCsv.structuredTable.truncated,true);
const emptyCsv = renderDelimitedTableForAnalysis('', { fileName:'empty.csv', delimiter:',' });assert.deepEqual(emptyCsv.structuredTable.headers,[]);assert.deepEqual(emptyCsv.structuredTable.rows,[]);
assert.throws(()=>renderDelimitedTableForAnalysis('owner,cost\n"alice,100',{fileName:'broken.csv',delimiter:','}),/INVALID_DELIMITED_TABLE_UNCLOSED_QUOTE/);
assert.throws(()=>renderDelimitedTableForAnalysis('owner,cost\nal"ice,100',{fileName:'broken.csv',delimiter:','}),/INVALID_DELIMITED_TABLE_QUOTE_IN_UNQUOTED_CELL/);
assert.throws(()=>renderDelimitedTableForAnalysis('owner,cost\n"alice"suffix,100',{fileName:'broken.csv',delimiter:','}),/INVALID_DELIMITED_TABLE_TRAILING_QUOTED_CONTENT/);

const tsv = renderDelimitedTableForAnalysis('team\towner\nplatform\tfinance', {
  fileName: 'teams.tsv',
  delimiter: '\t',
});
assert.match(tsv.text, /Format: TSV/);
assert.match(tsv.text, /Rows: 1/);
assert.match(tsv.text, /platform \| finance/);

const semicolonCsv = renderDelimitedTableForAnalysis('\uFEFFquestion;answer;notes\n"What is tracked?";"Cost and\nownership";"Contains, commas"', {
  fileName: 'responses.csv',
  delimiter: 'auto',
});
assert.equal(semicolonCsv.structuredTable.delimiter, ';');
assert.equal(semicolonCsv.structuredTable.parser_version, 'delimited_parser_v3');
assert.deepEqual(semicolonCsv.structuredTable.headers, ['question', 'answer', 'notes']);
assert.deepEqual(semicolonCsv.structuredTable.analysis_rows, [['What is tracked?', 'Cost and ownership', 'Contains, commas']]);
const preambleCsv = renderDelimitedTableForAnalysis('Assessment export;;\nGenerated 2026-08-15;;\n;;\nMetadata;;\nQuestion;Answer;Notes\nQ1;"Line one\nline two";Owner assigned\nQ2;No;', {
  fileName: 'messy-responses.csv',
  delimiter: 'auto',
});
assert.equal(preambleCsv.structuredTable.header_row_number, 5, 'a sparse preamble must not be mistaken for the table header');
assert.deepEqual(preambleCsv.structuredTable.headers, ['Question', 'Answer', 'Notes']);
assert.deepEqual(preambleCsv.structuredTable.analysis_row_numbers, [6, 8], 'row locators must retain physical lines, including quoted multiline cells');
assert.deepEqual(preambleCsv.structuredTable.analysis_rows[0], ['Q1', 'Line one line two', 'Owner assigned']);
assert.match(preambleCsv.warnings.join(' '), /header.*preamble row\(s\)/i);
assert.throws(
  () => renderDelimitedTableForAnalysis('single column\nvalue', { fileName: 'ambiguous.csv', delimiter: 'auto' }),
  /DELIMITED_TABLE_DELIMITER_UNDETECTED/
);

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /const MAX_FILES = 20;/, 'artifact limit should be raised to 20');
assert.match(appSource, /const MAX_TOTAL_UPLOAD_MB = 25;/, 'upload limit should be applied to the total set');
assert.doesNotMatch(appSource, /MAX_FILE_SIZE_MB/, 'per-file 25MB cap should not be used');
assert.match(appSource, /\.tsv/, 'TSV files should be accepted');
assert.match(appSource, /delimiter: 'auto'/, 'CSV delimiter should be detected deterministically');
assert.match(appSource, /rejectedFiles\.push/, 'each selected file should fail independently');
assert.doesNotMatch(appSource, /Irrelevant File Detected/, 'low-relevance files should warn, not hard-block');

const pdfSource = await readFile(new URL('../src/services/pdfService.ts', import.meta.url), 'utf8');
assert.match(pdfSource, /DEFAULT_MAX_TEXT_PAGES = 100/, 'PDF text extraction should cover up to 100 pages');
assert.match(pdfSource, /schema_version:\s*'source_page_v1'/, 'PDF extraction should preserve structured page identity');
assert.doesNotMatch(pdfSource, /canvas\.toDataURL|PDF_PAGE source=/, 'PDF extraction must not rasterize or create sentinel pages');
assert.match(pdfSource, /assessPdfParseQuality/, 'PDF extraction should calculate deterministic parse quality');
assert.match(pdfSource, /createLocalOcrSession/, 'sparse PDF pages should use browser-local OCR');
assert.match(pdfSource, /PDF_REQUIRED_PAGE_OCR_FAILED_/, 'required OCR failure should stop technical-loss cases');
assert.doesNotMatch(pdfSource, /pageTexts\.join\(''\)\.trim\(\)\.length === 0/, 'page markers must not be used as the unreadable-PDF test');

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

const sparseTitleRecovered = assessPdfParseQuality({
  pages: [
    { pageNumber: 1, charCount: 50, wordCount: 6, textItemCount: 3 },
    { pageNumber: 2, charCount: 1600, wordCount: 210, textItemCount: 95 }
  ],
  visualPagesIncluded: 1,
  visualPagesSkipped: 0,
  pageStates: [{ pageNumber: 1, state: 'OCR_COMPLETE' }, { pageNumber: 2, state: 'TEXT_EXTRACTED' }]
});
assert.equal(sparseTitleRecovered.quality, 'good', 'a locally OCR-acquired title page must not condemn a useful short PDF');

const sparseTitleUnresolved = assessPdfParseQuality({
  pages: [
    { pageNumber: 1, charCount: 50, wordCount: 6, textItemCount: 3 },
    { pageNumber: 2, charCount: 1600, wordCount: 210, textItemCount: 95 }
  ],
  visualPagesIncluded: 0,
  visualPagesSkipped: 1,
  pageStates: [{ pageNumber: 1, state: 'SPARSE_TEXT_ONLY' }, { pageNumber: 2, state: 'TEXT_EXTRACTED' }]
});
assert.equal(sparseTitleUnresolved.quality, 'mixed', 'one sparse title page is a warning, not whole-document failure');

const unresolvedMixedDocument = assessPdfParseQuality({
  pages: Array.from({ length: 10 }, (_, index) => ({ pageNumber: index + 1, charCount: index < 3 ? 80 : 1200, wordCount: index < 3 ? 10 : 180, textItemCount: index < 3 ? 4 : 80 })),
  visualPagesIncluded: 0,
  visualPagesSkipped: 3,
  pageStates: Array.from({ length: 10 }, (_, index) => ({ pageNumber: index + 1, state: index < 3 ? 'SPARSE_TEXT_ONLY' : 'TEXT_EXTRACTED' }))
});
assert.equal(unresolvedMixedDocument.quality, 'poor', 'multiple unresolved sparse pages are technical loss and must block');

const unresolvedMaterialVisual = assessPdfParseQuality({
  pages: [{ pageNumber: 1, charCount: 1200, wordCount: 180, textItemCount: 80 }],
  visualPagesIncluded: 0,
  visualPagesSkipped: 1,
  pageStates: [{ pageNumber: 1, state: 'VISUAL_REGION_WITHHELD' }]
});
assert.equal(unresolvedMaterialVisual.quality, 'poor', 'failed inspection of a detected material raster region must block');

const budgetParse = assessPdfParseQuality({
  pages: Array.from({ length: 6 }, (_, idx) => ({ pageNumber: idx + 1, charCount: idx < 3 ? 100 : 900, wordCount: idx < 3 ? 15 : 130, textItemCount: idx < 3 ? 4 : 50 })),
  visualPagesIncluded: 2,
  visualPagesSkipped: 4,
  imageBudgetReached: true
});
assert.match(budgetParse.warnings.join(' '), /image budget/);

const appParseSource = appSource;
assert.match(appParseSource, /parse_warnings:file\.parseMetadata/, 'PDF parse quality should be carried structurally on source records');
assert.match(appParseSource, /Complete text\/OCR acquisition/, 'upload card should label complete PDF acquisition');
assert.match(appParseSource, /Acquired with declared sparse\/visual limitations/, 'upload card should declare sparse PDF limitations');
assert.match(appParseSource, /Blocked: required page acquisition incomplete/, 'upload card should identify blocking PDF acquisition');

console.log('input parsing regression tests passed');
