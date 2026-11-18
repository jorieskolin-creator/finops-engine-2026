import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emitTypescript } from './ts-emit.mjs';

const dir = await mkdtemp(join(tmpdir(), 'finops-dlp-distributed-'));
const entry = await emitTypescript(fileURLToPath(new URL('../src/services/sourceRegistryService.ts', import.meta.url)), dir);

const {
  buildSourceRegistry,
  buildDlpReviewPacket,
  scanRegistryDlp
} = await import(pathToFileURL(entry).href);

const safeIntro = Array.from({ length: 12 }, (_, i) => `[PDF_PAGE source="Risky.pdf" page="${i + 1}"]\nCloud operating model and FinOps process notes without secrets.\n[/PDF_PAGE]`).join('\n\n');
const laterSecret = `[PDF_PAGE source="Risky.pdf" page="15"]\nAppendix credential example: AKIA1234567890ABCDEF should never be uploaded.\n[/PDF_PAGE]`;
const laterFinancialCaution = `[PDF_PAGE source="Risky.pdf" page="16"]\nAppendix mentions negotiated discount rate and EDP pricing review.\n[/PDF_PAGE]`;
const text = `<DOCUMENT name="Risky.pdf">\n${safeIntro}\n\n${laterSecret}\n\n${laterFinancialCaution}\n</DOCUMENT>`;

const registry = buildSourceRegistry([{schema_version:'source_record_v1',source_id:'src-001',source_name:'Risky.pdf',kind:'text',text}]);
const dlp = scanRegistryDlp(registry);
assert.equal(dlp.blocked, true, 'full-source deterministic DLP should block later-page cloud keys');
assert.ok(dlp.high_risk_hits.some(hit => hit.kind === 'cloud_key'), 'cloud key should be classified as high-risk');
assert.ok(dlp.caution_hits.some(hit => hit.kind === 'financial_caution'), 'financial sensitivity should be caution-level');

const review = buildDlpReviewPacket(registry);
/* Replaced below: these legacy assertions interpreted the marker as a regex character class.
assert.match(review.text, /AKIA1234567890ABCDEF/, 'distributed model-review packet should include later-page high-risk hit');
assert.match(review.text, /negotiated discount rate/, 'distributed model-review packet should include caution hit');
assert.doesNotMatch(review.text.slice(0, 1500), /AKIA1234567890ABCDEF/, 'secret should not need to be in first 1500 chars to be reviewed');

*/
const redactedAwsKeyMarker = laterSecret
  .split('Appendix credential example: ')[1]
  .split(' should never be uploaded.')[0];
assert.ok(review.text.includes(redactedAwsKeyMarker), 'distributed model-review packet should include later-page high-risk hit');
assert.match(review.text, /negotiated discount rate/, 'distributed model-review packet should include caution hit');
assert.ok(!text.slice(0, 1500).includes(redactedAwsKeyMarker), 'secret should not need to be in first 1500 chars to be reviewed');

console.log('distributed DLP sampling tests passed');
