import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeDestination } from '../lib/governance.js';

let ts;
try {
  const mod = await import('../node_modules/typescript/lib/typescript.js');
  ts = mod.default ?? mod;
} catch {
  ts = null;
}

const source = await readFile(new URL('../src/models.ts', import.meta.url), 'utf8');
const analysisServiceSource = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
const orchestratorSource = await readFile(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

if (!ts) {
  assert.match(source, /export const NORMAL_STAGE_MODELS[\s\S]*?preflight:\s+PROFILES\.GPT_55_PREFLIGHT/);
  assert.match(source, /export const CHEAP_TEST_STAGE_MODELS[\s\S]*?preflight:\s+PROFILES\.QWEN_38_MAX/);
  assert.match(source, /forensic_audit:\s+PROFILES\.QWEN_38_MAX/);
  assert.match(source, /roadmap_synthesis:\s+PROFILES\.QWEN_38_MAX/);
  assert.match(source, /export const CHEAP_TEST_FALLBACK_CHAIN[\s\S]*?quality_gate:\s+\[PROFILES\.GPT_54_MINI_QUALITY_GATE, PROFILES\.SONNET_46\]/);
  assert.match(source, /MODEL_ROUTING_MODE === 'cheap_test' \? CHEAP_TEST_STAGE_MODELS : NORMAL_STAGE_MODELS/);
  assert.match(source, /MODEL_ROUTING_MODE === 'cheap_test' \? CHEAP_TEST_FALLBACK_CHAIN : NORMAL_FALLBACK_CHAIN/);
  assert.match(analysisServiceSource, /model_mode: MODEL_ROUTING_MODE/);
  assert.doesNotMatch(source, /provider:\s*'gemini'/);
  console.log('model routing textual tests passed (TypeScript compiler unavailable)');
  process.exit(0);
}

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-model-routing-'));
const modulePath = join(dir, 'models.mjs');
await writeFile(modulePath, compile(source), 'utf8');

const normal = await import(`file://${modulePath}`);
const { MODEL_ROUTING_MODE, STAGE_MODELS, modelsFor } = normal;

assert.equal(MODEL_ROUTING_MODE, 'normal');
assert.equal(STAGE_MODELS.preflight.provider, 'openai');
assert.equal(STAGE_MODELS.preflight.id, 'gpt-5.5');
assert.deepEqual(STAGE_MODELS.preflight.openaiReasoning, { effort: 'low' });
assert.equal(STAGE_MODELS.evidence_check.provider, 'openai');
assert.equal(STAGE_MODELS.evidence_check.id, 'gpt-5.5');
assert.equal(STAGE_MODELS.fact_check.provider, 'openai');
assert.equal(STAGE_MODELS.fact_check.id, 'gpt-5.5');
assert.deepEqual(STAGE_MODELS.fact_check.openaiReasoning, { effort: 'medium' });
assert.equal(STAGE_MODELS.fact_check.maxTokens, 12000);
assert.equal(STAGE_MODELS.fact_check_high.provider, 'openai');
assert.equal(STAGE_MODELS.fact_check_high.id, 'gpt-5.5');
assert.deepEqual(STAGE_MODELS.fact_check_high.openaiReasoning, { effort: 'high' });
assert.equal(STAGE_MODELS.targeted_rescan.provider, 'anthropic');
assert.equal(STAGE_MODELS.targeted_rescan.id, 'claude-opus-4-7');
assert.equal(STAGE_MODELS.evidence_adjudication.provider, 'openai');
assert.equal(STAGE_MODELS.evidence_adjudication.id, 'gpt-5.5');
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

const highFactCheckChain = modelsFor('fact_check_high');
assert.equal(highFactCheckChain[0].provider, 'openai');
assert.deepEqual(highFactCheckChain[0].openaiReasoning, { effort: 'high' });
assert.equal(highFactCheckChain[1].id, 'claude-sonnet-4-6');
assert.equal(highFactCheckChain.some((profile) => profile.provider === 'gemini'), false);

const targetedRescanChain = modelsFor('targeted_rescan');
assert.equal(targetedRescanChain[0].id, 'claude-opus-4-7');
assert.equal(targetedRescanChain[1].id, 'gpt-5.5');
assert.equal(targetedRescanChain[2].id, 'claude-sonnet-4-6');

const preflightChain = modelsFor('preflight');
assert.equal(preflightChain[0].id, 'gpt-5.5');
assert.equal(preflightChain[1].id, 'claude-sonnet-4-6');

const auditChain = modelsFor('forensic_audit');
assert.equal(auditChain[0].id, 'claude-sonnet-4-6');
assert.equal(auditChain[1].id, 'gpt-5.5');
assert.equal(auditChain[2].id, 'claude-opus-4-7');

const evidenceCheckChain = modelsFor('evidence_check');
assert.equal(evidenceCheckChain[0].id, 'gpt-5.5');
assert.equal(evidenceCheckChain[1].id, 'claude-sonnet-4-6');
assert.equal(evidenceCheckChain[2].id, 'claude-opus-4-7');

const adjudicationChain = modelsFor('evidence_adjudication');
assert.equal(adjudicationChain[0].provider, 'openai');
assert.equal(adjudicationChain[1].id, 'claude-opus-4-7');

const synthesisChain = modelsFor('synthesis');
assert.equal(synthesisChain[0].id, 'claude-sonnet-4-6');
assert.equal(synthesisChain[1].id, 'gpt-5.5');
assert.equal(synthesisChain[2].id, 'claude-opus-4-7');

const escalationChain = modelsFor('synthesis_escalation');
assert.equal(escalationChain[0].id, 'claude-opus-4-7');
assert.equal(escalationChain[1].id, 'gpt-5.5');
assert.equal(escalationChain[2].id, 'claude-sonnet-4-6');

const qualityGateChain = modelsFor('quality_gate');
assert.equal(qualityGateChain[0].provider, 'openai');
assert.equal(qualityGateChain[1].id, 'claude-sonnet-4-6');

const roadmapChain = modelsFor('roadmap_synthesis');
assert.equal(roadmapChain[0].provider, 'anthropic');
assert.equal(roadmapChain[0].id, 'claude-opus-4-7');
assert.equal(roadmapChain[1].provider, 'openai');
assert.equal(roadmapChain[1].id, 'gpt-5.5');
assert.equal(roadmapChain[2].provider, 'anthropic');
assert.equal(roadmapChain[2].id, 'claude-sonnet-4-6');

for (const stage of Object.keys(STAGE_MODELS)) {
  for (const profile of modelsFor(stage)) authorizeDestination(stage, profile.provider, profile.id, {
    ...(profile.maxTokens ? { max_tokens: profile.maxTokens } : {}),
    ...(profile.openaiReasoning ? { reasoning_effort: profile.openaiReasoning.effort } : {}),
    ...(profile.anthropicThinking ? { thinking_budget_tokens: profile.anthropicThinking.budget_tokens } : {}),
  });
  assert.equal(
    modelsFor(stage).some((profile) => profile.provider === 'gemini' || profile.id.includes('gemini')),
    false,
    `${stage} should not include Gemini in the primary or fallback chain`,
  );
}

const cheapModulePath = join(dir, 'models-cheap.mjs');
await writeFile(cheapModulePath, compile(source), 'utf8');
globalThis.window = {
  location: { search: '?model_mode=cheap_test' },
  sessionStorage: {
    value: undefined,
    setItem(_key, value) { this.value = value; },
    getItem() { return this.value; },
    removeItem() { this.value = undefined; },
  },
};
const cheap = await import(`file://${cheapModulePath}`);
delete globalThis.window;

assert.equal(cheap.MODEL_ROUTING_MODE, 'cheap_test');
for (const profile of Object.values(cheap.STAGE_MODELS)) {
  assert.equal(profile.provider, 'qwen');
  assert.equal(profile.id, 'qwen3.8-max');
  assert.equal(profile.maxTokens, undefined);
}

for (const stage of Object.keys(cheap.STAGE_MODELS)) {
  const chain = cheap.modelsFor(stage);
  for (const profile of chain) authorizeDestination(stage, profile.provider, profile.id, {
    ...(profile.maxTokens ? { max_tokens: profile.maxTokens } : {}),
    ...(profile.openaiReasoning ? { reasoning_effort: profile.openaiReasoning.effort } : {}),
    ...(profile.anthropicThinking ? { thinking_budget_tokens: profile.anthropicThinking.budget_tokens } : {}),
  });
  assert.equal(chain.at(-1).id, 'claude-sonnet-4-6', `${stage} should use Sonnet as the one cheap-mode backup`);
  assert.equal(chain[1].id, 'gpt-5.4-mini', `${stage} should try GPT mini before the final Sonnet backup`);
  assert.equal(
    chain.some((profile) => profile.id === 'claude-opus-4-7'),
    false,
    `${stage} should not include Opus in cheap_test mode`,
  );
  assert.equal(
    chain.some((profile) => profile.provider === 'gemini' || profile.id.includes('gemini')),
    false,
    `${stage} should not include Gemini in cheap_test mode`,
  );
}

assert.match(
  analysisServiceSource,
  /substage: 'evidence_summary'[\s\S]*?actuals\.synthesis = resp\.modelUsed\.id|actuals\.synthesis = resp\.modelUsed\.id[\s\S]*?substage: 'evidence_summary'/,
  'evidence summary model should be recorded as synthesis metadata'
);
assert.match(
  analysisServiceSource,
  /runStage\('roadmap_synthesis'[\s\S]*?actuals\.roadmap_synthesis = resp\.modelUsed\.id/,
  'roadmap model should be recorded as roadmap_synthesis metadata'
);

assert.match(
  orchestratorSource,
  /runSingleBatch\(batchId, text, images, ctx, prompt, 'targeted_rescan'\)/,
  'targeted rescans should use the dedicated targeted_rescan stage'
);

assert.match(
  analysisServiceSource,
  /runFactCheck\(strategyData, factCheck\.attempts \+ 1, 'fact_check_high'\)/,
  'fact-check should have a high-reasoning escalation path'
);

assert.match(
  analysisServiceSource,
  /model_mode: MODEL_ROUTING_MODE/,
  'pipeline metadata should record active model routing mode'
);

assert.match(
  source,
  /new URLSearchParams\(window\.location\.search\)/,
  'cheap mode should be activatable from the browser URL'
);
assert.match(
  source,
  /sessionStorage\?\.setItem\(RUNTIME_MODEL_MODE_KEY, 'cheap_test'\)/,
  'cheap mode URL activation should persist for the browser session'
);

console.log('model routing unit tests passed');
