import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const sourcePath = new URL('../src/services/evidenceSupport.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const evidenceCheckServiceSource = await readFile(new URL('../src/services/evidenceCheckService.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  evidenceCheckServiceSource,
  /text\.substring\(0,\s*50000\)/,
  'the verifier and anti-pattern adjudicator must receive the complete governed domain packet'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-check-'));
const modulePath = join(dir, 'evidenceSupport.mjs');
await writeFile(modulePath, compiled, 'utf8');

const { isEvidenceQuoteBoundToDerivedEvidence, isValidEvidenceVerifierItem, verifyTextEvidenceSupport } = await import(`file://${modulePath}`);

const item = (quote) => ({
  count: 2,
  evidence_quotes: quote ? [{ quote, evidence_source: 'text' }] : [],
});

const sourceText = [
  'Teams run monthly cloud cost review meetings with engineering and finance.',
  'Tagged cost allocation is used in showback reports.',
].join('\n');

assert.equal(
  verifyTextEvidenceSupport(item('Teams run monthly cloud cost review meetings'), sourceText),
  'supported',
  'exact source quote should be supported'
);

assert.equal(
  verifyTextEvidenceSupport(item(undefined), sourceText),
  'missing',
  'scored finding without a quote should be missing'
);

assert.equal(
  verifyTextEvidenceSupport(item('Monthly cost review with finance and engineering teams'), sourceText),
  'weak',
  'mostly overlapping but non-exact quote should be weak'
);

assert.equal(
  verifyTextEvidenceSupport(item('Kubernetes chargeback is enforced by admission controllers'), sourceText),
  'unsupported',
  'unrelated quote should be unsupported'
);

const diagnosticLine = 'TAGGING crucial-item coverage: 1/3 found; critical=PARTIAL.';
assert.equal(isEvidenceQuoteBoundToDerivedEvidence(
  { evidence_source: 'derived', derived_evidence_id: 'EVID-DER-DIAGNOSTIC', source_id: 'src-001', quote: diagnosticLine },
  {
    evidence_id: 'EVID-DER-DIAGNOSTIC', source_id: 'src-001', mode: 'authoritative', report_eligible: true,
    eligibility: { state: 'ELIGIBLE', reasons: [] },
    derivation: { analyzer_id: 'crucial_item_coverage_v1' },
    targets: [{ stream: 'maturity', criterion_id: 'A1' }], summary_lines: [diagnosticLine]
  },
  'maturity',
  'A1'
), false, 'acquisition coverage diagnostics must never become score-supporting derived evidence');

const verifierItem = {
  stream: 'antipattern',
  id: 'A1',
  status: 'supported',
  assessment_status: 'assessed',
  original_count: 0,
  verified_count: 0,
  rationale: 'Relevant coverage was reviewed.',
  quote_supported: false,
  rescan_recommended: false,
  antipattern_absence_status: 'tested_absent',
  coverage_reason: 'The relevant source area was covered and the anti-pattern was not found.'
};
assert.equal(isValidEvidenceVerifierItem({ raw: verifierItem, stream: 'antipattern', scannerCount: 0, duplicate: false }), true);
assert.equal(isValidEvidenceVerifierItem({ raw: { ...verifierItem, verified_count: 0.5 }, stream: 'antipattern', scannerCount: 0, duplicate: false }), false, 'fractional verifier scores must fail');
assert.equal(isValidEvidenceVerifierItem({ raw: { ...verifierItem, original_count: 1 }, stream: 'antipattern', scannerCount: 1, duplicate: false }), false, 'tested absence must contradict no prior scanner signal');
assert.equal(isValidEvidenceVerifierItem({ raw: { ...verifierItem, coverage_reason: '' }, stream: 'antipattern', scannerCount: 0, duplicate: false }), false, 'absence verdicts require explicit coverage rationale');
assert.equal(isValidEvidenceVerifierItem({
  raw: { ...verifierItem, antipattern_absence_status: 'partially_present', assessment_status: 'not_assessed' },
  stream: 'antipattern', scannerCount: 0, duplicate: false
}), true, 'a structurally valid zero-score verdict is normalized by deterministic anti-pattern semantics rather than failing the whole batch');
assert.equal(isValidEvidenceVerifierItem({
  raw: { ...verifierItem, original_count: 1, antipattern_absence_status: 'partially_present', assessment_status: 'assessed', quote_supported: true },
  stream: 'antipattern', scannerCount: 1, duplicate: false
}), true, 'a scanner signal with assessed quote-backed coverage may remain a partial finding');

assert.equal(
  verifyTextEvidenceSupport({
    count: 0,
    assessment_status: 'assessed',
    evidence_quotes: [{ quote: 'Tagged cost allocation is used in showback reports.', evidence_source: 'text' }]
  }, sourceText),
  'supported',
  'an assessed 0/3 must retain and validate criterion-relevant evidence'
);
assert.equal(
  verifyTextEvidenceSupport({ count: 0, assessment_status: 'not_assessed', evidence_quotes: [] }, sourceText),
  'weak',
  'an unknown item should remain eligible for semantic rescan'
);

console.log('evidence-check unit tests passed');
