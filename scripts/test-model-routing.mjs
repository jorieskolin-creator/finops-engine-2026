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

const factCheckChain = modelsFor('fact_check');
assert.equal(factCheckChain[0].provider, 'openai');
assert.equal(factCheckChain[0].id, 'gpt-5.5');
assert.equal(factCheckChain[1].provider, 'anthropic');
assert.equal(factCheckChain[1].id, 'claude-sonnet-4-6');
assert.equal(factCheckChain.some((profile) => profile.provider === 'gemini'), false);

const qualityGateChain = modelsFor('quality_gate');
assert.equal(qualityGateChain[0].provider, 'openai');
assert.equal(qualityGateChain[1].id, 'claude-sonnet-4-6');

console.log('model routing unit tests passed');
