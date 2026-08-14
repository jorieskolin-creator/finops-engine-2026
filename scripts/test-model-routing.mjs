import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizeConfiguredDestination, authorizeDestination } from '../lib/governance.js';
import {
  MODEL_ROUTING_POLICY_VERSION,
  MODEL_STAGES,
  ModelRoutingConfigurationError,
  resolveModelRouting,
  settingsForProfile,
} from '../lib/modelRoutingPolicy.js';

const validateRoute = config => {
  assert.equal(config.policy_version, MODEL_ROUTING_POLICY_VERSION);
  for (const stage of MODEL_STAGES) {
    assert.ok(config.routes[stage].length > 0, `${stage} must have a route`);
    for (const candidate of config.routes[stage]) {
      authorizeDestination(stage, candidate.provider, candidate.id, settingsForProfile(candidate));
    }
  }
};

const legacy = resolveModelRouting({});
validateRoute(legacy);
assert.equal(legacy.mode, 'legacy');
assert.equal(legacy.label, 'legacy');
assert.deepEqual(legacy.routes.forensic_audit.map(profile => profile.id), ['claude-sonnet-5', 'gpt-5.6-sol', 'claude-opus-5']);
assert.deepEqual(legacy.routes.targeted_rescan.map(profile => profile.id), ['claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5']);
assert.deepEqual(legacy.routes.fact_check_high[0].openaiReasoning, { effort: 'high' });

const qwenOpenAI = resolveModelRouting({ PRIMARY_MODEL_PROVIDER: 'qwen', FALLBACK_MODEL_PROVIDER: 'openai' });
validateRoute(qwenOpenAI);
assert.equal(qwenOpenAI.mode, 'provider_policy');
assert.equal(qwenOpenAI.label, 'qwen_openai');
assert.equal(qwenOpenAI.primary_provider, 'QWEN');
assert.equal(qwenOpenAI.fallback_provider, 'OPENAI');
for (const stage of MODEL_STAGES) {
  const chain = qwenOpenAI.routes[stage];
  assert.equal(chain[0].provider, 'qwen');
  assert.equal(chain[0].id, 'qwen3.8-max');
  assert.equal(chain[0].maxTokens, undefined);
  assert.equal(chain[1].provider, 'openai');
}
assert.equal(qwenOpenAI.routes.quality_gate[1].id, 'gpt-5.4-mini');
assert.equal(qwenOpenAI.routes.forensic_audit[1].id, 'gpt-5.6-sol');
assert.deepEqual(qwenOpenAI.routes.targeted_rescan[1].openaiReasoning, { effort: 'high' });
assert.equal(qwenOpenAI.routes.targeted_rescan[1].maxTokens, 32768);

const openAIAnthropic = resolveModelRouting({ PRIMARY_MODEL_PROVIDER: 'OPENAI', FALLBACK_MODEL_PROVIDER: 'ANTHROPIC' });
validateRoute(openAIAnthropic);
assert.equal(openAIAnthropic.routes.forensic_audit[0].id, 'gpt-5.6-sol');
assert.equal(openAIAnthropic.routes.forensic_audit[1].id, 'claude-sonnet-5');
assert.equal(openAIAnthropic.routes.roadmap_synthesis[1].id, 'claude-opus-5');

const strictQwen = resolveModelRouting({ PRIMARY_MODEL_PROVIDER: 'QWEN', FALLBACK_MODEL_PROVIDER: 'NONE' });
validateRoute(strictQwen);
for (const stage of MODEL_STAGES) assert.equal(strictQwen.routes[stage].length, 1);

const duplicateProvider = resolveModelRouting({ PRIMARY_MODEL_PROVIDER: 'OPENAI', FALLBACK_MODEL_PROVIDER: 'OPENAI' });
for (const stage of MODEL_STAGES) assert.equal(duplicateProvider.routes[stage].length, 1);

for (const env of [
  { FALLBACK_MODEL_PROVIDER: 'QWEN' },
  { PRIMARY_MODEL_PROVIDER: 'GEMINI' },
  { PRIMARY_MODEL_PROVIDER: 'QWEN', FALLBACK_MODEL_PROVIDER: 'GEMINI' },
]) {
  assert.throws(() => resolveModelRouting(env), ModelRoutingConfigurationError);
}

const qwenAudit = qwenOpenAI.routes.forensic_audit[0];
assert.doesNotThrow(() => authorizeConfiguredDestination(
  'forensic_audit', qwenAudit.provider, qwenAudit.id, settingsForProfile(qwenAudit),
  { PRIMARY_MODEL_PROVIDER: 'QWEN', FALLBACK_MODEL_PROVIDER: 'OPENAI' },
));
assert.throws(() => authorizeConfiguredDestination(
  'forensic_audit', 'anthropic', 'claude-sonnet-5', { max_tokens: 8192 },
  { PRIMARY_MODEL_PROVIDER: 'QWEN', FALLBACK_MODEL_PROVIDER: 'OPENAI' },
), /DESTINATION_NOT_CONFIGURED/);

const modelContracts = await readFile(new URL('../src/models.ts', import.meta.url), 'utf8');
const router = await readFile(new URL('../src/services/modelRouter.ts', import.meta.url), 'utf8');
const analysis = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
assert.doesNotMatch(modelContracts, /cheap_test|VITE_FINOPS_MODEL_MODE|URLSearchParams/);
assert.match(router, /fetch\('\/api\/model-routing'/);
assert.match(router, /await getModelRoutingConfig\(\)/);
assert.doesNotMatch(analysis, /runStage\(['"]preflight['"]/);
assert.match(analysis, /sanitizeEvidenceSources\(sources\)/);
assert.ok(
  analysis.indexOf('sanitizeEvidenceSources(sources)') < analysis.indexOf('runPhase1Audit('),
  'deterministic acquisition must precede the first generative Phase 1 call',
);
assert.doesNotMatch(modelContracts, /\| 'preflight'/);
assert.match(analysis, /model_mode: modelRoutingMode/);
assert.match(server, /resolveModelRouting\(process\.env\)/);

console.log('model routing policy tests passed');
