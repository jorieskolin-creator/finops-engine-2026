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
  const source = (await readFile(new URL(`../src/services/${name}.ts`, import.meta.url), 'utf8'))
    .replace("'./tableService'", "'./tableService.mjs'");
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

// Locale CSV (semicolon) must pass type validation so auto-delimiter parsing can run.
const semicolonCsv = await inspectEvidenceBytes({
  bytes: encoder.encode('Question;Answer;Notes\nQ1;Cost ownership;Manual\nQ2;Tagging;Partial'),
  fileName: 'responses.csv',
  declaredMediaType: 'text/csv',
});
assert.equal(semicolonCsv.validation_status, 'PASS');
assert.equal(semicolonCsv.format, 'csv');
assert.equal(semicolonCsv.detected_media_type, 'text/csv');
assert.equal(semicolonCsv.validation_codes.length, 0);

const commaCsv = await inspectEvidenceBytes({
  bytes: encoder.encode('owner,cost\nalice,12'),
  fileName: 'costs.csv',
});
assert.equal(commaCsv.validation_status, 'PASS');
assert.equal(commaCsv.format, 'csv');

const undelimitedCsv = await inspectEvidenceBytes({
  bytes: encoder.encode('plain text without any field separators at all'),
  fileName: 'not-really.csv',
});
assert.equal(undelimitedCsv.validation_status, 'BLOCK');
assert.ok(undelimitedCsv.validation_codes.includes('CONTENT_TYPE_UNDETECTED'));

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
  schema_version: 'source_record_v1', source_id: 'src-pdf', source_name: 'Jane Doe - Confidential Strategy.pdf', kind: 'pdf',
  pages: [{ schema_version: 'source_page_v1', page_id: 'p1', page_number: 1, text: 'Owner alice@example.com uses host 10.0.0.1.' }],
}]);
assert.equal(contactPrivacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.equal(contactPrivacy.sources[0].source_name, 'Document 001', 'the privacy boundary must replace externally supplied filenames with generated labels');
assert.doesNotMatch(JSON.stringify(contactPrivacy), /Jane Doe - Confidential Strategy\.pdf/);
assert.equal(contactPrivacy.decision.redaction_count, 2);
assert.equal(contactPrivacy.sources[0].pages[0].text, 'Owner [EMAIL_REDACTED] uses host [IP_REDACTED].');
assert.throws(() => assertDeterministicEgressText(['owner alice@example.com']), /DETERMINISTIC_EGRESS_SCAN_FAILED/);
assert.doesNotThrow(() => assertDeterministicEgressText([contactPrivacy.sources[0].pages[0].text]));

const contextualNamePrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-contextual-name', source_name: 'owner.txt', kind: 'txt',
  text: 'Owner Toni\nPrepared by Toni\nContact Toni',
}]);
assert.equal(contextualNamePrivacy.decision.decision, 'PASS_WITH_REDACTIONS', 'a contextual person name must not make its own replacement fail the post-redaction scan');
assert.equal(contextualNamePrivacy.sources[0].text, 'Owner Respondent\nPrepared by Respondent\nContact Respondent');
assert.doesNotMatch(JSON.stringify(contextualNamePrivacy.sources), /Toni/, 'the original person name must not cross the privacy boundary');
assert.doesNotThrow(() => assertDeterministicEgressText([contextualNamePrivacy.sources[0].text]));
const repeatedContextualPrivacy = sanitizeEvidenceSources(contextualNamePrivacy.sources);
assert.equal(repeatedContextualPrivacy.decision.decision, 'PASS', 'sanitizing an already-redacted contextual name must be idempotent');
assert.equal(repeatedContextualPrivacy.sources[0].text, contextualNamePrivacy.sources[0].text);

const respondentPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-respondents', source_name: 'answers.csv', kind: 'csv',
  text: 'Question,Toni,Jaakko,Esa Hakanen / Controller,Tietoallas (Niilo & Markku)\nTagging?,Manual,Partial,Unknown,Documented',
  structured_table: {
    schema_version: 'structured_table_v1',
    headers: ['Question', 'Toni', 'Jaakko', 'Esa Hakanen / Controller', 'Tietoallas (Niilo & Markku)'],
    rows: [['Tagging?', 'Manual', 'Partial', 'Unknown', 'Documented']],
    analysis_rows: [['Tagging?', 'Manual', 'Partial', 'Unknown', 'Documented']],
    total_row_count: 1, analysis_complete: true, truncated: false,
  },
}]);
const respondentJson = JSON.stringify(respondentPrivacy.sources[0]);
assert.equal(respondentPrivacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.ok(respondentPrivacy.decision.findings.some(finding => finding.kind === 'person_name'));
assert.doesNotMatch(respondentJson, /Toni|Jaakko|Esa Hakanen|Niilo|Markku/, 'respondent names must be removed before packetization');
assert.match(respondentJson, /Respondent 1/);
assert.deepEqual(
  respondentPrivacy.sources[0].structured_table.headers,
  ['Question', 'Respondent 1', 'Respondent 2', 'Respondent 3 / Controller', 'Tietoallas (Respondent 4 & Respondent 5)'],
  'respondent labels should remain stable in source-column order'
);
assert.match(respondentJson, /Controller/, 'non-person role context should remain available for analysis');
assert.match(respondentJson, /Tietoallas/, 'team context should remain available for analysis');

const expansionSource = renderDelimitedTableForAnalysis(`Question;Toni;Esa Hakanen / Controller\nDetails;${'Toni '.repeat(80)};Reviewed`, {
  fileName: 'bounded-respondents.csv', delimiter: ';'
});
assert.equal(expansionSource.structuredTable.rows[0][1].length, 243, 'parser preview must begin at its maximum valid width');
const expansionPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-bounded-respondents', source_name: 'bounded-respondents.csv', kind: 'csv',
  text: expansionSource.text, structured_table: expansionSource.structuredTable,
}]);
const expansionTable = expansionPrivacy.sources[0].structured_table;
assert.equal(expansionTable.rows[0][1].length, 243, 'privacy-label expansion must preserve the bounded preview contract');
assert.ok(expansionTable.analysis_rows[0][1].length > 243, 'complete redacted analytical evidence must not be truncated');
assert.match(expansionTable.analysis_rows[0][1], /Respondent 1/);
assert.doesNotMatch(JSON.stringify(expansionPrivacy.sources[0]), /Toni/, 'the bounded preview and complete analytical value must both remain redacted');

const ordinaryHeadersPrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-costs', source_name: 'costs.csv', kind: 'csv',
  text: 'Region,Service,Cost\nWest,Compute,12',
  structured_table: {
    schema_version: 'structured_table_v1', headers: ['Region', 'Service', 'Cost'],
    rows: [['West', 'Compute', '12']], analysis_rows: [['West', 'Compute', '12']],
    total_row_count: 1, analysis_complete: true, truncated: false,
  },
}]);
assert.deepEqual(ordinaryHeadersPrivacy.sources[0].structured_table.headers, ['Region', 'Service', 'Cost'], 'ordinary business headers must not be treated as people');

const rolePrivacy = sanitizeEvidenceSources([{
  schema_version: 'source_record_v1', source_id: 'src-roles', source_name: 'roles.csv', kind: 'csv',
  text: 'Service Owner / Controller,Platform Team\nAssigned,Active',
  structured_table: {
    schema_version: 'structured_table_v1', headers: ['Service Owner / Controller', 'Platform Team'],
    rows: [['Assigned', 'Active']], analysis_rows: [['Assigned', 'Active']],
    total_row_count: 1, analysis_complete: true, truncated: false,
  },
}]);
assert.deepEqual(rolePrivacy.sources[0].structured_table.headers, ['Service Owner / Controller', 'Platform Team'], 'role and team headers must remain intact');

const contactTable = renderDelimitedTableForAnalysis('owner\nalice@example.com\nbob@example.com', { fileName: 'contacts.csv', delimiter: ',' });
const contactTablePrivacy = sanitizeEvidenceSources([{ schema_version: 'source_record_v1', source_id: 'src-contacts', source_name: 'contacts.csv', kind: 'csv', text: contactTable.text, structured_table: contactTable.structuredTable }]);
assert.equal(contactTable.structuredTable.deterministic_inspection.columns[0].distinct_value_count, 2);
assert.equal(contactTablePrivacy.sources[0].structured_table.deterministic_inspection.columns[0].distinct_value_count, 1, 'inspection metrics must be recomputed from sanitized full-table values');

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
