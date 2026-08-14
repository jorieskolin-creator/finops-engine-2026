import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = source => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-acquisition-'));
for (const name of ['evidenceFileService', 'deterministicPrivacyService', 'tableService']) {
  const source = await readFile(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8');
  await writeFile(join(dir, `${name}.mjs`), compile(source), 'utf8');
}

const { inspectEvidenceBytes } = await import(`file://${join(dir, 'evidenceFileService.mjs')}`);
const { sanitizeEvidenceSources, assertDeterministicEgressText } = await import(`file://${join(dir, 'deterministicPrivacyService.mjs')}`);
const { renderDelimitedTableForAnalysis } = await import(`file://${join(dir, 'tableService.mjs')}`);
const encoder = new TextEncoder();

const pdf = await inspectEvidenceBytes({
  bytes: encoder.encode('%PDF-1.7\nsynthetic'),
  fileName: 'evidence.pdf',
  declaredMediaType: 'application/pdf',
});
assert.equal(pdf.validation_status, 'PASS');
assert.equal(pdf.source_role, 'CUSTOMER_EVIDENCE');
assert.equal(pdf.detected_media_type, 'application/pdf');
assert.match(pdf.original_sha256, /^sha256_[a-f0-9]{64}$/);

const disguised = await inspectEvidenceBytes({
  bytes: encoder.encode('owner,cost\nalice,12'),
  fileName: 'disguised.pdf',
  declaredMediaType: 'application/pdf',
});
assert.equal(disguised.validation_status, 'BLOCK');
assert.ok(disguised.validation_codes.includes('CONTENT_TYPE_UNDETECTED'));

const validJson = await inspectEvidenceBytes({ bytes: encoder.encode('{"cost":12}'), fileName: 'cost.json' });
assert.equal(validJson.validation_status, 'PASS');
const invalidJson = await inspectEvidenceBytes({ bytes: encoder.encode('{not-json}'), fileName: 'cost.json' });
assert.equal(invalidJson.validation_status, 'BLOCK');

const xlsxAcceptedForDefensiveParser = await inspectEvidenceBytes({
  bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  fileName: 'cost.xlsx',
});
assert.equal(xlsxAcceptedForDefensiveParser.validation_status, 'PASS');

const rows = Array.from({ length: 151 }, (_, index) => `owner-${index},${index}`);
rows[150] = 'AKIAABCDEFGHIJKLMNOP,150';
rows[150] = `${'AKIA'}${'A'.repeat(16)},150`;
const rendered = renderDelimitedTableForAnalysis(`owner,cost\n${rows.join('\n')}`, {
  fileName: 'private-file-name.csv',
  delimiter: ',',
});
assert.equal(rendered.structuredTable.rows.length, 150, 'model context remains bounded');
assert.equal(rendered.structuredTable.analysis_rows.length, 151, 'deterministic analysis retains the full population');
assert.equal(rendered.structuredTable.analysis_complete, true);
assert.doesNotMatch(rendered.text, /private-file-name/, 'browser-local filename must not enter rendered table context');

const tablePrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-table', source_name: 'cost.csv', kind: 'csv',
  text: rendered.text, structured_table: rendered.structuredTable,
}]);
assert.equal(tablePrivacy.decision.decision, 'BLOCK', 'a secret beyond the model sample must block egress');
assert.ok(tablePrivacy.decision.findings.some(finding => finding.kind === 'cloud_key'));
assert.equal(tablePrivacy.decision.scanned_table_cell_count, 304, 'headers and every full-population cell must be scanned once');

const contactPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-pdf', source_name: 'evidence.pdf', kind: 'pdf',
  pages: [{ schema_version: 'source_page_v1', page_id: 'p1', page_number: 1, text: 'Owner alice@example.com uses host 10.0.0.1.' }],
}]);
assert.equal(contactPrivacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.equal(contactPrivacy.decision.redaction_count, 2);
assert.equal(contactPrivacy.sources[0].pages[0].text, 'Owner [EMAIL_REDACTED] uses host [IP_REDACTED].');
assert.throws(() => assertDeterministicEgressText(['owner alice@example.com']), /DETERMINISTIC_EGRESS_SCAN_FAILED/);
assert.doesNotThrow(() => assertDeterministicEgressText([contactPrivacy.sources[0].pages[0].text]));

const financialPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-contract', source_name: 'contract.pdf', kind: 'pdf',
  text: 'The negotiated discount rate: 37% applies to the term.',
}]);
assert.equal(financialPrivacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.equal(financialPrivacy.sources[0].text, 'The negotiated discount rate: [FINANCIAL_VALUE_REDACTED] applies to the term.');
assert.ok(financialPrivacy.decision.findings.some(finding => finding.kind === 'sensitive_financial_value'));

const identityPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-person', source_name: 'people.csv', kind: 'csv',
  text: 'SSN 123-45-6789; passport number: AB123456; home address: 12 Private Street',
}]);
assert.equal(identityPrivacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.doesNotMatch(identityPrivacy.sources[0].text, /123-45-6789|AB123456|12 Private Street/);

const chartPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-chart', source_name: 'costs.xlsx', kind: 'xlsx',
  text: 'Format: XLSX\nBounded model context contains no private chart category.',
  structured_table: {
    schema_version: 'structured_table_v1', headers: ['month', 'cost'], rows: [], analysis_rows: [],
    total_row_count: 0, analysis_complete: true, truncated: false,
    native_charts: [{
      schema_version: 'native_chart_evidence_unit_v1', chart_id: 'chart-xl-charts-chart1-xml',
      chart_part: 'xl/charts/chart1.xml', sheet_name: 'Costs', chart_type: 'barChart',
      title: 'Spend', axis_titles: [], extraction_status: 'COMPLETE', warnings: [],
      series: [{ name: 'Cost', categories: ['public', 'alice@example.com'], values: [10, 20] }]
    }]
  }
}]);
assert.equal(chartPrivacy.decision.decision, 'PASS_WITH_REDACTIONS', 'full native chart caches must be privacy scanned even beyond bounded text context');
assert.deepEqual(chartPrivacy.sources[0].structured_table.native_charts[0].series[0].categories, ['public', '[EMAIL_REDACTED]']);

const hiddenSheetPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-workbook', source_name: 'multisheet.xlsx', kind: 'xlsx',
  text: 'Format: XLSX\nOnly visible sheet context is model eligible.',
  structured_tables: [
    { schema_version: 'structured_table_v1', sheet_name: 'Visible', sheet_visibility: 'visible', model_eligible: true, headers: ['owner'], rows: [['Alice']], analysis_rows: [['Alice']], total_row_count: 1, analysis_complete: true, truncated: false },
    { schema_version: 'structured_table_v1', sheet_name: 'Hidden', sheet_visibility: 'hidden', model_eligible: false, headers: ['credential'], rows: [['password=hidden-secret-value']], analysis_rows: [['password=hidden-secret-value']], total_row_count: 1, analysis_complete: true, truncated: false }
  ]
}]);
assert.equal(hiddenSheetPrivacy.decision.decision, 'BLOCK', 'prohibited content in a hidden sheet must block before packetization');
assert.ok(hiddenSheetPrivacy.decision.findings.some(finding => finding.kind === 'credential_assignment'));
assert.equal(hiddenSheetPrivacy.decision.scanned_table_cell_count, 4, 'visible and hidden sheet headers and complete populations must all be scanned');

console.log('evidence acquisition tests passed');
