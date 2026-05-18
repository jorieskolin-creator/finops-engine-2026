import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-model-routing-'));
const source = await readFile(new URL('../src/models.ts', import.meta.url), 'utf8');
const modulePath = join(dir, 'models.mjs');
await writeFile(modulePath, compile(source), 'utf8');

const { STAGE_MODELS, modelsFor } = await import(`file://${modulePath}`);

assert.equal(STAGE_MODELS.fact_check.provider, 'openai');
assert.equal(STAGE_MODELS.fact_check.id, 'gpt-5.5');
assert.deepEqual(STAGE_MODELS.fact_check.openaiReasoning, { effort: 'medium' });
assert.equal(STAGE_MODELS.fact_check.maxTokens, 12000);
assert.equal(STAGE_MODELS.quality_gate.provider, 'openai');
assert.equal(STAGE_MODELS.quality_gate.id, 'gpt-5.5');
assert.equal(STAGE_MODELS.quality_gate.maxTokens, 8192);
assert.equal(STAGE_MODELS.roadmap_synthesis.provider, 'anthropic');
assert.equal(STAGE_MODELS.roadmap_synthesis.id, 'claude-opus-4-7');

const factCheckChain = modelsFor('fact_check');
assert.equal(factCheckChain[0].provider, 'openai');
assert.equal(factCheckChain[0].id, 'gpt-5.5');
assert.equal(factCheckChain[1].provider, 'anthropic');
assert.equal(factCheckChain[1].id, 'claude-sonnet-4-6');
assert.equal(factCheckChain.some((profile) => profile.provider === 'gemini'), false);

const qualityGateChain = modelsFor('quality_gate');
assert.equal(qualityGateChain[0].provider, 'openai');
assert.equal(qualityGateChain[1].id, 'claude-sonnet-4-6');

const roadmapChain = modelsFor('roadmap_synthesis');
assert.equal(roadmapChain[0].provider, 'anthropic');
assert.equal(roadmapChain[0].id, 'claude-opus-4-7');
assert.equal(roadmapChain[1].provider, 'openai');
assert.equal(roadmapChain[1].id, 'gpt-5.5');
assert.equal(roadmapChain[2].provider, 'gemini');
assert.equal(roadmapChain[2].id, 'gemini-3.1-pro-preview');

const geminiServiceSource = await readFile(new URL('../src/services/geminiService.ts', import.meta.url), 'utf8');
assert.match(
  geminiServiceSource,
  /substage: 'evidence_summary'[\s\S]*?actuals\.synthesis = resp\.modelUsed\.id|actuals\.synthesis = resp\.modelUsed\.id[\s\S]*?substage: 'evidence_summary'/,
  'evidence summary model should be recorded as synthesis metadata'
);
assert.match(
  geminiServiceSource,
  /runStage\('roadmap_synthesis'[\s\S]*?actuals\.roadmap_synthesis = resp\.modelUsed\.id/,
  'roadmap model should be recorded as roadmap_synthesis metadata'
);

console.log('model routing unit tests passed');
