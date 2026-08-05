import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

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

console.log('fact-check validation tests passed');
