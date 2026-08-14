import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

const dir = await mkdtemp(join(tmpdir(), 'finops-xlsx-acquisition-'));
const outfile = join(dir, 'xlsxCore.mjs');
await build({
  entryPoints: [new URL('../src/services/xlsxCore.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { inspectXlsxArchive, parseNativeChartXml, parseXlsxBytes } = await import(`file://${outfile}`);

const nativeChartXml = `
  <c:chartSpace xmlns:c="chart" xmlns:a="drawing">
    <c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Monthly Spend</a:t></a:r></a:p></c:rich></c:tx></c:title>
      <c:plotArea><c:barChart><c:ser>
        <c:tx><c:strRef><c:f>'Cloud Costs'!$C$1</c:f><c:strCache><c:pt idx="0"><c:v>Spend</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:f>'Cloud Costs'!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:f>'Cloud Costs'!$C$2:$C$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>150</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser></c:barChart><c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>USD</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea>
    </c:chart>
  </c:chartSpace>`;
const nativeChart = parseNativeChartXml('xl/charts/chart1.xml', nativeChartXml);
assert.equal(nativeChart.chart_type, 'barChart');
assert.equal(nativeChart.title, 'Monthly Spend');
assert.equal(nativeChart.sheet_name, 'Cloud Costs');
assert.deepEqual(nativeChart.axis_titles, ['USD']);
assert.deepEqual(nativeChart.series[0].categories, ['Jan', 'Feb']);
assert.deepEqual(nativeChart.series[0].values, [100, 150]);
assert.equal(nativeChart.extraction_status, 'COMPLETE');
assert.throws(() => parseNativeChartXml('xl/charts/chart2.xml', '<c:lineChart><c:ser><c:val><c:numRef><c:f>[external.xlsx]Sheet1!A1</c:f></c:numRef></c:val></c:ser></c:lineChart>'), /XLSX_EXTERNAL_LINK_REJECTED/);

const chartZipWriter = new ZipWriter(new Uint8ArrayWriter());
await chartZipWriter.add('[Content_Types].xml', new TextReader('<Types/>'));
await chartZipWriter.add('xl/workbook.xml', new TextReader('<workbook/>'));
await chartZipWriter.add('xl/charts/chart1.xml', new TextReader(nativeChartXml));
const chartArchive = await inspectXlsxArchive(await chartZipWriter.close());
assert.equal(chartArchive.nativeCharts.length, 1);
assert.equal(chartArchive.nativeCharts[0].title, 'Monthly Spend');
assert.ok(!chartArchive.unsupportedObjects.includes('NATIVE_CHART_REQUIRES_EXTRACTION'));

const workbook = XLSX.utils.book_new();
const costs = XLSX.utils.aoa_to_sheet([
  ['Owner', 'Cost Center', 'Spend', 'Total'],
  ['Alice', 'CC-1', 100, null],
  ['', 'unallocated', 50, null],
]);
costs.D2 = { t: 'n', f: 'C2', v: 100 };
costs.D3 = { t: 'n', f: 'C3', v: 50 };
costs['!ref'] = 'A1:D3';
XLSX.utils.book_append_sheet(workbook, costs, 'Cloud Costs');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Hidden Empty');
workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
const bytes = new Uint8Array(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
const parsed = await parseXlsxBytes(bytes);
const primaryTable = parsed.tables[0];
assert.equal(parsed.parser_version, '0.20.3');
assert.equal(primaryTable.sheet_name, 'Cloud Costs');
assert.equal(primaryTable.source_range, 'A1:D3');
assert.deepEqual(primaryTable.sampled_row_numbers, [2, 3]);
assert.equal(primaryTable.formula_cell_count, 2);
assert.equal(primaryTable.formula_cached_value_missing_count, 0);
assert.equal(primaryTable.analysis_complete, true);
assert.equal(primaryTable.deterministic_inspection.population_scope, 'FULL_TABLE');
assert.equal(primaryTable.deterministic_inspection.row_count, 2);
assert.equal(primaryTable.deterministic_inspection.column_count, 4);
assert.equal(primaryTable.sample_strategy_version, 'deterministic_table_sample_v1');
assert.deepEqual(primaryTable.sampled_row_reasons, [['FULL_POPULATION'], ['FULL_POPULATION']]);
assert.equal(parsed.sheets[1].reason, 'EMPTY');

const largeWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(largeWorkbook, XLSX.utils.aoa_to_sheet([
  ['Owner', 'Spend'],
  ...Array.from({ length: 200 }, (_, index) => [`owner-${index}`, index === 180 ? 999999 : index]),
]), 'Large Costs');
const largeBytes = new Uint8Array(XLSX.write(largeWorkbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
const largeParsed = await parseXlsxBytes(largeBytes, 'd'.repeat(64));
assert.equal(largeParsed.tables[0].rows.length, 150);
assert.equal(largeParsed.tables[0].sample_seed_hash, `${'d'.repeat(64)}:0`);
assert.ok(largeParsed.tables[0].sampled_row_numbers.includes(182), 'XLSX numeric extreme must retain its physical worksheet row');
assert.ok(largeParsed.tables[0].sampled_row_numbers.includes(201), 'XLSX last-row boundary must be represented');
assert.match(largeParsed.warnings.join(' '), /deterministic bounded sample of 150 rows/);

const multisheetWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(multisheetWorkbook, XLSX.utils.aoa_to_sheet([['Owner'], ['Alice']]), 'First');
XLSX.utils.book_append_sheet(multisheetWorkbook, XLSX.utils.aoa_to_sheet([['Owner'], ['Bob']]), 'Second');
XLSX.utils.book_append_sheet(multisheetWorkbook, XLSX.utils.aoa_to_sheet([['Secret'], ['hidden-value']]), 'Hidden Evidence');
multisheetWorkbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }] };
const multisheetBytes = new Uint8Array(XLSX.write(multisheetWorkbook, { type: 'buffer', bookType: 'xlsx' }));
const multisheet = await parseXlsxBytes(multisheetBytes, 'e'.repeat(64));
assert.equal(multisheet.tables.length, 3, 'every non-empty sheet must be extracted for complete-source privacy inspection');
assert.deepEqual(multisheet.tables.map(table => table.model_eligible), [true, true, false]);
assert.match(multisheet.text, /Sheet: First/);
assert.match(multisheet.text, /Sheet: Second/);
assert.doesNotMatch(multisheet.text, /Hidden Evidence|hidden-value/, 'hidden sheet content must not enter model context');
assert.match(multisheet.warnings.join(' '), /Workbook sheet 3.*fully inspected locally but withheld/);
assert.doesNotMatch(multisheet.warnings.join(' '), /Hidden Evidence/, 'parser warnings must not expose raw worksheet names');

const linkedWorkbook = XLSX.utils.book_new();
const linked = XLSX.utils.aoa_to_sheet([['Owner'], ['Alice']]);
linked.A2.l = { Target: 'https://example.com/private' };
XLSX.utils.book_append_sheet(linkedWorkbook, linked, 'Links');
const linkedBytes = new Uint8Array(XLSX.write(linkedWorkbook, { type: 'buffer', bookType: 'xlsx' }));
await assert.rejects(() => parseXlsxBytes(linkedBytes), /XLSX_EXTERNAL_LINK_REJECTED/);

const zipWriter = new ZipWriter(new Uint8ArrayWriter());
await zipWriter.add('[Content_Types].xml', new TextReader('<Types/>'));
await zipWriter.add('xl/workbook.xml', new TextReader('<workbook/>'));
await zipWriter.add('xl/vbaProject.bin', new TextReader('active content'));
const activeBytes = await zipWriter.close();
await assert.rejects(() => inspectXlsxArchive(activeBytes), /XLSX_ACTIVE_CONTENT_REJECTED/);

console.log('XLSX acquisition tests passed');
