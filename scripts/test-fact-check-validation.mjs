import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';
import { OUTPUT_CONTRACT_IDS, validateOutputContractText } from '../lib/outputContracts.js';

const source = await readFile(new URL('../src/services/factCheckService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-fact-check-validation-'));
const modulePath = join(dir, 'factCheckService.mjs');
await writeFile(modulePath, compiled, 'utf8');

const {
  buildRegenerateAppendix,
  claimsForRepairScope,
  determineFactCheckRepairScope,
  mergeRequiredFactChecks,
  parseFactCheckResponse,
  ROADMAP_FACT_CHECK_CONTRACT,
  SUMMARY_FACT_CHECK_CONTRACT
} = await import(`file://${modulePath}`);

assert.equal(parseFactCheckResponse('{"claims":[]}', 1).failed, true, 'empty verdict arrays must fail');
assert.equal(parseFactCheckResponse('{"status":"ok"}', 1).failed, true, 'missing verdict arrays must fail');
assert.equal(parseFactCheckResponse(JSON.stringify({ claims: [{
  claim: 'Savings will increase.',
  classification: 'unsupported',
  rationale: 'No supporting material.',
  source_location: 'roadmap'
}] }), 1).failed, true, 'unsupported verdicts missing required classification fields must fail');

const valid = parseFactCheckResponse(JSON.stringify({ claims: [{
  claim: 'Evidence density is 92%.',
  classification: 'supported_by_audit',
  rationale: 'The value is present in Phase 2 metrics.',
  source_location: 'diagnosis'
}] }), 1);
assert.equal(valid.failed, false);
assert.equal(valid.total_claims, 1);

const wrongSummaryLocation = parseFactCheckResponse(JSON.stringify({ claims: [{
  claim: 'Implement a tactic.',
  classification: 'supported_by_tactics_db',
  rationale: 'The tactic exists.',
  source_location: 'roadmap'
}] }), 1, SUMMARY_FACT_CHECK_CONTRACT);
assert.equal(wrongSummaryLocation.failed, true, 'summary verdicts must not claim roadmap or tactics-DB coverage');

const wrongRoadmapLocation = parseFactCheckResponse(JSON.stringify({ claims: [{
  claim: 'Ownership is centralized.',
  classification: 'supported_by_source',
  rationale: 'The source says so.',
  source_location: 'cfo'
}] }), 1, ROADMAP_FACT_CHECK_CONTRACT);
assert.equal(wrongRoadmapLocation.failed, true, 'roadmap verdicts must not claim persona or diagnosis coverage');

const tacticHygieneClaim = {
  claim: 'Apply [TAC-GOV-002] despite the conflicting prerequisite [C3].',
  classification: 'unsupported',
  rationale: 'The supplied locked finding does not support this tactic use.',
  source_location: 'roadmap',
  failure_type: 'other',
  severity: 'WARN_TACTIC_HYGIENE',
  missing_material: 'A locked finding establishing the tactic prerequisite.',
};
assert.equal(parseFactCheckResponse(JSON.stringify({ claims: [tacticHygieneClaim] }), 1, ROADMAP_FACT_CHECK_CONTRACT).failed, true,
  'tactic hygiene verdicts must state an explicit disposition');
const contraindicated = parseFactCheckResponse(JSON.stringify({ claims: [{
  ...tacticHygieneClaim,
  tactic_disposition: 'contraindicated',
}] }), 1, ROADMAP_FACT_CHECK_CONTRACT);
assert.equal(contraindicated.failed, false);
assert.equal(contraindicated.unsupported_claims[0].tactic_disposition, 'contraindicated');
const citationRejected = parseFactCheckResponse(JSON.stringify({ claims: [{
  ...tacticHygieneClaim,
  tactic_disposition: 'citation_rejected',
}] }), 1, ROADMAP_FACT_CHECK_CONTRACT);
assert.equal(citationRejected.failed, false);
assert.equal(citationRejected.unsupported_claims[0].tactic_disposition, 'citation_rejected');
const contractCompatibleRoadmapResponse = { claims: [{
  claim: 'Apply [TAC-GOV-002] after validating the governed account prerequisite [C3].',
  classification: 'supported_by_tactics_db',
  rationale: 'The tactic and use condition exist in the supplied Playbook.',
  source_location: 'roadmap',
  failure_type: 'not_applicable',
  severity: 'SUPPORTED',
  tactic_disposition: 'not_applicable',
  missing_material: '',
}] };
const contractCompatibleText = JSON.stringify(contractCompatibleRoadmapResponse);
assert.deepEqual(
  validateOutputContractText(OUTPUT_CONTRACT_IDS.roadmapFactCheck, contractCompatibleText),
  contractCompatibleRoadmapResponse,
);
assert.equal(
  parseFactCheckResponse(contractCompatibleText, 1, ROADMAP_FACT_CHECK_CONTRACT).failed,
  false,
  'every response accepted by the strict roadmap schema must satisfy the application parser',
);
assert.equal(parseFactCheckResponse(JSON.stringify({ claims: [{
  ...contractCompatibleRoadmapResponse.claims[0],
  tactic_disposition: 'contraindicated',
}] }), 1, ROADMAP_FACT_CHECK_CONTRACT).failed, false,
  'every strict-schema disposition value must remain parseable; irrelevant dispositions are discarded');
const unresolvedDisposition = parseFactCheckResponse(JSON.stringify({ claims: [{
  ...tacticHygieneClaim,
  tactic_disposition: 'not_applicable',
}] }), 1, ROADMAP_FACT_CHECK_CONTRACT);
assert.equal(unresolvedDisposition.failed, false, 'a schema-valid unresolved disposition must not make the entire fact-check unavailable');
assert.equal(unresolvedDisposition.unsupported_claims[0].tactic_disposition, undefined,
  'not_applicable must never become a valid required-tactic exception');

const failedSubcheck = {
  attempts: 1,
  total_claims: 0,
  supported_count: 0,
  unsupported_claims: [],
  failed: true,
  failure_reason: 'Malformed output.'
};
const merged = mergeRequiredFactChecks(valid, failedSubcheck, 1);
assert.equal(merged.failed, true, 'either required fact-check substage failing must fail the merged check');
assert.equal(merged.total_claims, 0, 'partial verdicts must not be represented as complete coverage');

const summaryDefect = { claim: 'Unsupported summary.', classification: 'unsupported', rationale: 'Missing.', source_location: 'cfo' };
const roadmapDefect = { claim: 'Unsupported roadmap.', classification: 'unsupported', rationale: 'Missing.', source_location: 'roadmap' };
assert.equal(determineFactCheckRepairScope([summaryDefect]), 'summary');
assert.equal(determineFactCheckRepairScope([roadmapDefect]), 'roadmap');
assert.equal(determineFactCheckRepairScope([summaryDefect, roadmapDefect]), 'both');
assert.equal(determineFactCheckRepairScope([{ ...summaryDefect, source_location: undefined }]), 'both', 'unclassified defects must use the safe cross-contract repair');
assert.deepEqual(claimsForRepairScope([summaryDefect, roadmapDefect], 'summary'), [summaryDefect]);
assert.deepEqual(claimsForRepairScope([summaryDefect, roadmapDefect], 'roadmap'), [roadmapDefect]);
assert.match(buildRegenerateAppendix([summaryDefect], 'summary'), /Regenerate ONLY executive_summaries/);
assert.match(buildRegenerateAppendix([roadmapDefect], 'roadmap'), /Regenerate ONLY planning_decision/);
assert.match(buildRegenerateAppendix([summaryDefect, roadmapDefect], 'both'), /Regenerate both/);

const analysisSource = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
assert.match(analysisSource, /determineFactCheckRepairScope\(lastUnsupported\)/);
assert.match(analysisSource, /callPhase3Validated\([\s\S]*requestedScope, strategyData\)/, 'repair must retain the accepted strategy and invoke only the requested contract scope');
assert.match(analysisSource, /requestedScope,\s*acceptedFactChecks/, 'fact-check must reuse the verdict for the unchanged contract scope');
assert.match(analysisSource, /FACT_CHECK_NOT_IMPROVED/, 'a regenerated candidate that does not improve the scoped defect profile must be rejected');
assert.match(analysisSource, /findRoadmapActionsMissingCriterionReferences/, 'roadmap output validation must require explicit action-to-finding references');
assert.match(analysisSource, /repairedChecks\.merged\.sanitized_claims = \[/, 'bounded tactic repair must preserve prior sanitation lineage');
assert.match(analysisSource, /repairedChecks\.merged\.trajectory = \[/, 'bounded tactic repair must preserve fact-check trajectory');
assert.match(analysisSource, /highFactCheck\.sanitized_claims = \[/, 'fact-check escalation must preserve prior sanitation lineage');
assert.match(analysisSource, /'fact_check',\s*'roadmap',\s*acceptedFactChecks/, 'post-sanitation repair must re-check only the roadmap');
assert.match(analysisSource, /const summaryStrategy = summary\?\.phase_3_strategy \|\| summary \|\| \{\}/, 'roadmap repair merge must preserve locked summaries when given the full strategy wrapper');

console.log('fact-check validation tests passed');
