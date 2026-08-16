import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-provenance-'));
const transpile = source => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const supportSource = await readFile(new URL('../src/services/evidenceSupport.ts', import.meta.url), 'utf8');
await writeFile(join(dir, 'evidenceSupport.mjs'), transpile(supportSource), 'utf8');

let checkSource = await readFile(new URL('../src/services/evidenceCheckService.ts', import.meta.url), 'utf8');
checkSource = checkSource
  .replace("import { BATCH_DEFINITIONS, BATCH_IDS, knowledgeBaseService } from '../knowledge_base';", "const BATCH_IDS = ['A', 'B', 'C', 'D', 'E', 'F']; const BATCH_DEFINITIONS = {}; const knowledgeBaseService = {};")
  .replace(/import \{[\s\S]*?\} from '\.\.\/types';\n/, '')
  .replace("import { runStage, RunContext, serverLog } from './modelRouter';", 'const runStage = () => {}; const serverLog = () => {};')
  .replace("from './evidenceSupport';", "from './evidenceSupport.mjs';")
  .replace(`import {
  antiPatternStatusDescription,
  normalizeAntiPatternAbsenceStatus,
  resolveAntiPatternAbsenceStatus
} from './antiPatternSemantics';`, "const antiPatternStatusDescription = () => ''; const normalizeAntiPatternAbsenceStatus = value => value; const resolveAntiPatternAbsenceStatus = input => input.explicitStatus || 'unknown_absent';");
await writeFile(join(dir, 'evidenceCheckService.mjs'), transpile(checkSource), 'utf8');

const { buildUnavailableEvidenceCheck, reconcileEvidenceProvenance } = await import(`file://${join(dir, 'evidenceCheckService.mjs')}`);
const ids = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domain => [1, 2, 3, 4, 5].map(index => `${domain}${index}`));
const emptyLogs = () => Object.fromEntries(ids.map(id => [id, { count: 0, evidence_quotes: [] }]));
const evidenceItems = ids.flatMap(id => ['maturity', 'antipattern'].map(stream => ({
  stream, id, status: 'supported', original_count: 0, verified_count: 0, rationale: 'No finding.',
})));
const chunk = { chunk_id: 'src-001-c001', source_id: 'src-001', text: 'Teams run monthly cloud cost reviews.', type: 'text', routing: [] };
const manifest = { chunk_id: chunk.chunk_id, source_id: chunk.source_id, type: 'text', relevance: 'high', routed_domains: ['C'] };
const packets = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map(domain => [domain, {
  domain_id: domain, title: domain, text: '', images: [], manifest: domain === 'C' ? [manifest] : [],
  included_chunk_count: domain === 'C' ? 1 : 0, total_candidate_chunks: domain === 'C' ? 1 : 0,
  weak_coverage: domain !== 'C', coverage_notes: [], char_count: 0,
}]));
const validQuote = { quote: 'monthly cloud cost reviews', chunk_id: chunk.chunk_id, source_id: chunk.source_id };
const forgedQuote = { quote: 'Fabricated allocation policy', chunk_id: chunk.chunk_id, source_id: chunk.source_id };
const derivedLine = 'owner row coverage: 50%; valid=1/2; invalid placeholders=0; state=FIELD_PRESENT_PARTIAL.';
const derivedEvidence = {
  schema_version: 'derived_analytical_evidence_v1', mode: 'authoritative', evidence_id: 'EVID-DER-12345678', source_id: 'table-1',
  targets: [{ stream: 'maturity', criterion_id: 'C4' }], report_eligible: true,
  eligibility: { state: 'ELIGIBLE', reasons: [] }, summary_lines: [derivedLine],
};
const derivedQuote = { evidence_source: 'derived', quote: derivedLine, derived_evidence_id: derivedEvidence.evidence_id, source_id: derivedEvidence.source_id };
const maturity = emptyLogs();
maturity.C1 = { count: 2, status: 'Partial', evidence_quotes: [forgedQuote] };
maturity.C2 = { count: 1, status: 'Partial', evidence_quotes: [validQuote, forgedQuote] };
maturity.C3 = { count: 1, status: 'Partial', evidence_quotes: [] };
maturity.C4 = { count: 1, status: 'Partial', evidence_quotes: [derivedQuote] };
maturity.C5 = { count: 1, status: 'Partial', evidence_quotes: [derivedQuote] };
for (const item of evidenceItems) {
  if (item.stream === 'maturity' && ['C1', 'C2', 'C3', 'C4', 'C5'].includes(item.id)) {
    item.original_count = item.id === 'C1' ? 2 : 1;
    item.verified_count = item.original_count;
  }
}
const phase1 = {
  phase_1_audit_logs: { maturity, antipattern: emptyLogs() },
  evidence_check: {
    total_items: 60, supported_count: 60, weak_count: 0, unsupported_count: 0, missing_count: 0,
    downgraded_count: 0, rescan_count: 0, items: evidenceItems, adjustments: [],
  },
  failed_batches: [], models_used: [], targeted_rescan_models_used: [], evidence_check_models_used: [], evidence_adjudication_models_used: [],
};

const unavailable = buildUnavailableEvidenceCheck('C', {
  maturity: { C1: { count: 3 } },
  antipattern: { C2: { count: 2 } },
}, 'verifier unavailable');
assert.equal(unavailable.failed, true);
assert.equal(unavailable.items.length, 10, 'fallback must preserve the complete evidence decision contract');
assert.ok(unavailable.items.every(item => item.verified_count === 0 && item.status === 'missing' && item.verification_unresolved));
assert.equal(unavailable.items.find(item => item.stream === 'maturity' && item.id === 'C1').original_count, 3);
assert.equal(unavailable.items.find(item => item.stream === 'antipattern' && item.id === 'C2').antipattern_absence_status, 'unknown_absent');

const reconciled = reconcileEvidenceProvenance(phase1, { chunks: [chunk] }, packets, [derivedEvidence]);
assert.deepEqual(reconciled.adjustedCriteria, ['C1', 'C2', 'C3', 'C5']);
assert.equal(reconciled.removedQuoteCount, 3);
assert.equal(reconciled.result.phase_1_audit_logs.maturity.C1.count, 0, 'unsupported positive score must be downgraded');
assert.deepEqual(reconciled.result.phase_1_audit_logs.maturity.C1.evidence_quotes, []);
assert.equal(reconciled.result.evidence_check.items.find(item => item.stream === 'maturity' && item.id === 'C1').status, 'unsupported');
assert.equal(reconciled.result.evidence_check.adjustments.find(item => item.stream === 'maturity' && item.id === 'C1').verified_count, 0);
assert.equal(reconciled.result.phase_1_audit_logs.maturity.C2.count, 1, 'a finding with remaining valid evidence must survive');
assert.deepEqual(reconciled.result.phase_1_audit_logs.maturity.C2.evidence_quotes, [validQuote]);
assert.equal(reconciled.result.phase_1_audit_logs.maturity.C3.count, 0, 'a positive finding without any quote must be downgraded');
assert.equal(reconciled.result.phase_1_audit_logs.maturity.C4.count, 1, 'an exact derived citation for its declared target must survive');
assert.equal(reconciled.result.phase_1_audit_logs.maturity.C5.count, 0, 'a derived citation used for an undeclared target must be rejected');
assert.equal(phase1.phase_1_audit_logs.maturity.C1.count, 2, 'reconciliation must not mutate the original result');

console.log('evidence provenance reconciliation tests passed');
