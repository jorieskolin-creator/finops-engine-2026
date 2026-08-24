import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-gap-analysis-'));
await writeFile(join(dir, 'knowledgeBase.mjs'), `export const MASTER_BINGO_FINOPS = {
  maturity: [{ id: 'D1', title: 'Architecture efficiency', desc: 'Workload rightsizing and autoscaling controls' }], antipattern: []
};`);
await writeFile(join(dir, 'modelRouter.mjs'), `
export const runStage = async (stage, prompt) => {
  globalThis.__gapStage = stage; globalThis.__gapPrompt = prompt;
  if (globalThis.__gapFailure) throw new Error('model unavailable');
  const text = JSON.stringify(globalThis.__gapResponse); prompt.validateOutput(text);
  return { text, modelUsed: { id: 'test-workhorse' } };
};`);
await writeFile(join(dir, 'outputContracts.mjs'), await readFile(new URL('../lib/outputContracts.js', import.meta.url), 'utf8'));
const serviceSource = (await readFile(new URL('../src/services/evidenceGapAnalysisService.ts', import.meta.url), 'utf8'))
  .replace("'../knowledge_base'", "'./knowledgeBase.mjs'")
  .replace("'./modelRouter'", "'./modelRouter.mjs'")
  .replace("'../../lib/outputContracts.js'", "'./outputContracts.mjs'");
await writeFile(join(dir, 'evidenceGapAnalysisService.mjs'), compile(serviceSource));
const { analyzeEvidenceGaps } = await import(`file://${join(dir, 'evidenceGapAnalysisService.mjs')}`);

globalThis.__gapResponse = {
  schema_version: 'finops_evidence_gap_query_v1', domain_id: 'D',
  queries: [{ criterion_id: 'maturity.D1', themes: ['automatic scaling'], terms: ['utilization threshold'] }],
};
const weak = { stream: 'maturity', id: 'D1', status: 'weak', rescan_recommended: true, rationale: 'LOW_EVIDENCE_SUMMARY', coverage_reason: 'Threshold details are unclear.' };
const generated = await analyzeEvidenceGaps({ domainId: 'D', items: [weak], pass: 1, seenTerms: new Set(), ctx: { runId: 'run-1' } });
assert.equal(globalThis.__gapStage, 'evidence_gap_analysis');
assert.deepEqual(generated.terms, ['automatic scaling', 'utilization threshold']);
assert.equal(generated.model_used, 'test-workhorse');
assert.equal(generated.failed, false);
assert.match(globalThis.__gapPrompt.userText, /LOW_EVIDENCE_SUMMARY/);
assert.doesNotMatch(globalThis.__gapPrompt.userText + globalThis.__gapPrompt.systemInstruction, /REMOTE_KB_CANARY|source chunk|customer quote/i);

globalThis.__gapStage = 'not-called';
const notTriggered = await analyzeEvidenceGaps({ domainId: 'D', items: [{ ...weak, status: 'supported' }], pass: 1, seenTerms: new Set(), ctx: { runId: 'run-1' } });
assert.equal(globalThis.__gapStage, 'not-called', 'non-weak evidence must not invoke the query-planning model');
assert.equal(notTriggered.failed, false);
assert.equal(notTriggered.terms, undefined);

const omittedCriterion = await analyzeEvidenceGaps({
  domainId: 'D',
  items: [weak, { ...weak, stream: 'antipattern', id: 'D1' }],
  pass: 1,
  seenTerms: new Set(),
  ctx: { runId: 'run-1' },
});
assert.equal(omittedCriterion.failed, true, 'the model must return one bounded query for every supplied weak criterion');

globalThis.__gapResponse = { ...globalThis.__gapResponse, score: 100 };
const invalid = await analyzeEvidenceGaps({ domainId: 'D', items: [weak], pass: 1, seenTerms: new Set(), ctx: { runId: 'run-1' } });
assert.equal(invalid.failed, true, 'invalid or scoring output must fall back deterministically');
assert.equal(invalid.terms, undefined);
globalThis.__gapFailure = true;
const failed = await analyzeEvidenceGaps({ domainId: 'D', items: [weak], pass: 1, seenTerms: new Set(), ctx: { runId: 'run-1' } });
assert.equal(failed.failed, true, 'model failure must not fail the evidence lane');

console.log('evidence gap analysis tests passed');
