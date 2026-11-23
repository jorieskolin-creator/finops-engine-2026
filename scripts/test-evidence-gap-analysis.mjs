import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-evidence-gap-analysis-'));
await writeFile(join(dir, 'modelRouter.mjs'), `
export const runStage = async (stage, prompt) => {
  globalThis.__gapStage = stage; globalThis.__gapPrompt = prompt;
  if (globalThis.__gapFailure) throw new Error('model unavailable');
  const text = JSON.stringify(globalThis.__gapResponse); prompt.validateOutput(text);
  return { text, modelUsed: { id: 'test-workhorse' } };
};`);
await writeFile(join(dir, 'outputContracts.mjs'), await readFile(new URL('../lib/outputContracts.js', import.meta.url), 'utf8'));
const serviceSource = (await readFile(new URL('../src/services/evidenceGapAnalysisService.ts', import.meta.url), 'utf8'))
  .replace("'./modelRouter'", "'./modelRouter.mjs'")
  .replace("'../../lib/outputContracts.js'", "'./outputContracts.mjs'");
await writeFile(join(dir, 'evidenceGapAnalysisService.mjs'), compile(serviceSource));
const { analyzeEvidenceGaps } = await import(`file://${join(dir, 'evidenceGapAnalysisService.mjs')}`);

globalThis.__gapResponse = {
  schema_version: 'finops_evidence_gap_query_v1', domain_id: 'D',
  queries: [{ criterion_id: 'maturity.D1', themes: ['automatic scaling'], terms: ['utilization threshold'] }],
};
const request = { schema_version: 'finops_evidence_gap_input_v1', domain_id: 'D', round: 2,
  gaps: [{ criterion_id: 'maturity.D1', missing_concept_ids: ['cost_modeling'] }] };
const generated = await analyzeEvidenceGaps(request, { runId: 'run-1' });
assert.equal(globalThis.__gapStage, 'evidence_gap_analysis');
assert.deepEqual(generated.termsByCriterion['maturity.D1'], ['automatic scaling', 'utilization threshold']);
assert.equal(generated.model_used, 'test-workhorse');
assert.equal(generated.failed, false);
assert.deepEqual(JSON.parse(globalThis.__gapPrompt.userText), request);
assert.equal(globalThis.__gapPrompt.systemInstruction, undefined);

globalThis.__gapResponse = {
  schema_version: 'finops_evidence_gap_query_v1', domain_id: 'D',
  queries: [{ criterion_id: 'maturity.D1', themes: ['GenAI & AI scaling', 'p95.latency'], terms: ['cost_center', 'token/request %'] }],
};
const punctuated = await analyzeEvidenceGaps(request, { runId: 'run-1' });
assert.equal(punctuated.failed, false, 'standard FinOps/GenAI punctuation (&, ., _, %) must be accepted in gap queries');
assert.deepEqual(punctuated.termsByCriterion['maturity.D1'], ['GenAI & AI scaling', 'p95.latency', 'cost_center', 'token/request %']);

globalThis.__gapStage = 'not-called';
const notTriggered = await analyzeEvidenceGaps({ ...request, gaps: [] }, { runId: 'run-1' });
assert.equal(globalThis.__gapStage, 'not-called');
assert.deepEqual(notTriggered.termsByCriterion, {});

const omittedCriterion = await analyzeEvidenceGaps({
  ...request, gaps: [...request.gaps, { criterion_id: 'maturity.D2', missing_concept_ids: ['iac_declared'] }],
}, { runId: 'run-1' });
assert.equal(omittedCriterion.failed, true);

globalThis.__gapResponse = { ...globalThis.__gapResponse, score: 100 };
const invalid = await analyzeEvidenceGaps(request, { runId: 'run-1' });
assert.equal(invalid.failed, true);
assert.deepEqual(invalid.termsByCriterion, {});
globalThis.__gapFailure = true;
const failed = await analyzeEvidenceGaps(request, { runId: 'run-1' });
assert.equal(failed.failed, true);
console.log('evidence gap analysis tests passed');
