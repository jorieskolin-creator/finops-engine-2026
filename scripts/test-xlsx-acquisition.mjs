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
const { inspectXlsxArchive, parseXlsxBytes } = await import(`file://${outfile}`);

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
assert.equal(parsed.parser_version, '0.20.3');
assert.equal(parsed.table.sheet_name, 'Cloud Costs');
assert.equal(parsed.table.source_range, 'A1:D3');
assert.deepEqual(parsed.table.sampled_row_numbers, [2, 3]);
assert.equal(parsed.table.formula_cell_count, 2);
assert.equal(parsed.table.formula_cached_value_missing_count, 0);
assert.equal(parsed.table.analysis_complete, true);
assert.equal(parsed.sheets[1].reason, 'HIDDEN');
assert.match(parsed.warnings.join(' '), /Hidden Empty.*not analyzed/);

const multisheetWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(multisheetWorkbook, XLSX.utils.aoa_to_sheet([['Owner'], ['Alice']]), 'First');
XLSX.utils.book_append_sheet(multisheetWorkbook, XLSX.utils.aoa_to_sheet([['Secret'], ['must be inspected']]), 'Second');
const multisheetBytes = new Uint8Array(XLSX.write(multisheetWorkbook, { type: 'buffer', bookType: 'xlsx' }));
await assert.rejects(() => parseXlsxBytes(multisheetBytes), /XLSX_MULTISHEET_ANALYSIS_NOT_IMPLEMENTED/);

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
