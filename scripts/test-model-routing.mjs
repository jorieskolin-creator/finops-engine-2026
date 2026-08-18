import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizeConfiguredDestination, authorizeDestination } from '../lib/governance.js';
import {
  AI_ROLES,
  MODEL_ROUTING_POLICY_VERSION,
  MODEL_STAGES,
  STAGE_ROLES,
  ModelRoutingConfigurationError,
  resolveModelRouting,
  settingsForProfile,
} from '../lib/modelRoutingPolicy.js';

const env = {
  OPENAI_API_KEY: 'test-openai-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  XAI_API_KEY: 'test-xai-key',
  REASONER_PROVIDER: 'OPENAI',
  REASONER_MODEL: 'gpt-5.6-sol',
  REASONER_FALLBACK_PROVIDER: 'XAI',
  REASONER_FALLBACK_MODEL: 'grok-4.6',
  WORKHORSE_PROVIDER: 'ANTHROPIC',
  WORKHORSE_MODEL: 'claude-sonnet-5',
  WORKHORSE_FALLBACK_PROVIDER: 'XAI',
  WORKHORSE_FALLBACK_MODEL: 'grok-4.6',
  QUALITY_CHECKER_PROVIDER: 'XAI',
  QUALITY_CHECKER_MODEL: 'grok-4.6',
  QUALITY_CHECKER_FALLBACK_PROVIDER: 'ANTHROPIC',
  QUALITY_CHECKER_FALLBACK_MODEL: 'claude-sonnet-5',
};

const config = resolveModelRouting(env);
assert.equal(config.policy_version, MODEL_ROUTING_POLICY_VERSION);
assert.equal(config.schema_version, 'model_routing_config_v2');
assert.equal(config.mode, 'role_policy');
assert.equal(config.label, 'ai_role_policy');
assert.deepEqual(config.stage_roles, STAGE_ROLES);
assert.deepEqual(Object.keys(config.roles).sort(), [...AI_ROLES].sort());

for (const stage of MODEL_STAGES) {
  const role = STAGE_ROLES[stage];
  const chain = config.routes[stage];
  assert.ok(role, `${stage} must have exactly one role`);
  assert.equal(chain.length, 2, `${stage} must have primary and fallback`);
  assert.deepEqual(
    chain.map(candidate => `${candidate.provider}:${candidate.id}`),
    config.roles[role].profiles.map(candidate => `${candidate.provider}:${candidate.id}`),
    `${stage} must preserve its role provider/model route`,
  );
  assert.notDeepEqual(chain[0], chain[1], `${stage} primary and fallback must differ`);
  for (const candidate of chain) {
    authorizeDestination(stage, candidate.provider, candidate.id, settingsForProfile(candidate));
    assert.doesNotThrow(() => authorizeConfiguredDestination(
      stage, candidate.provider, candidate.id, settingsForProfile(candidate), env,
    ));
  }
}

assert.equal(STAGE_ROLES.evidence_adjudication, 'REASONER');
assert.equal(STAGE_ROLES.synthesis_escalation, 'REASONER');
assert.equal(STAGE_ROLES.roadmap_synthesis, 'REASONER');
assert.equal(STAGE_ROLES.forensic_audit, 'WORKHORSE');
assert.equal(STAGE_ROLES.targeted_rescan, 'WORKHORSE');
assert.equal(STAGE_ROLES.evidence_check, 'QUALITY_CHECKER');
assert.equal(STAGE_ROLES.fact_check, 'QUALITY_CHECKER');
assert.equal(STAGE_ROLES.fact_check_high, 'QUALITY_CHECKER');
assert.equal(STAGE_ROLES.quality_gate, 'WORKHORSE', 'the model only explains the deterministic gate');
assert.deepEqual(config.routes.synthesis.map(value => `${value.provider}:${value.id}`), [
  'anthropic:claude-sonnet-5',
  'xai:grok-4.6',
]);
assert.deepEqual(config.routes.evidence_adjudication.map(value => `${value.provider}:${value.id}`), [
  'openai:gpt-5.6-sol',
  'xai:grok-4.6',
]);
assert.deepEqual(config.routes.fact_check.map(value => `${value.provider}:${value.id}`), [
  'xai:grok-4.6',
  'anthropic:claude-sonnet-5',
]);
assert.deepEqual(config.routes.evidence_adjudication[0].reasoningEffort, 'high');
assert.deepEqual(config.routes.fact_check[0].reasoningEffort, 'medium');
assert.equal(config.routes.synthesis[0].maxTokens, 24576, 'Anthropic synthesis alone receives the larger completion budget');
assert.equal(config.routes.synthesis[1].maxTokens, 16384, 'the Grok synthesis fallback retains its role default');
assert.equal(config.routes.forensic_audit[0].maxTokens, 16384, 'other Anthropic Workhorse stages retain their role default');
assert.equal(config.routes.quality_gate[0].maxTokens, 16384, 'Quality Gate explanation retains its bounded Workhorse budget');
assert.equal(config.roles.WORKHORSE.profiles[0].maxTokens, 16384, 'the role default remains bounded outside the stage override');
assert.throws(() => authorizeConfiguredDestination(
  'synthesis', 'anthropic', 'claude-sonnet-5', { max_tokens: 16384 }, env,
), /DESTINATION_NOT_CONFIGURED/, 'the old synthesis budget must fail closed after the policy change');

for (const invalid of [
  {},
  { ...env, REASONER_MODEL: '' },
  { ...env, REASONER_PROVIDER: 'OTHER' },
  { ...env, REASONER_MODEL: 'unapproved-model' },
  { ...env, REASONER_FALLBACK_PROVIDER: 'OPENAI', REASONER_FALLBACK_MODEL: 'gpt-5.6-sol' },
  { ...env, PRIMARY_MODEL_PROVIDER: 'OPENAI' },
  { ...env, XAI_API_KEY: '' },
]) {
  assert.throws(() => resolveModelRouting(invalid), ModelRoutingConfigurationError);
}

assert.throws(() => authorizeConfiguredDestination(
  'forensic_audit', 'openai', 'gpt-5.6-sol', { max_tokens: 16384, reasoning_effort: 'medium' }, env,
), /DESTINATION_NOT_CONFIGURED/);

const modelContracts = await readFile(new URL('../src/models.ts', import.meta.url), 'utf8');
const router = await readFile(new URL('../src/services/modelRouter.ts', import.meta.url), 'utf8');
const analysis = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
assert.doesNotMatch(modelContracts, /cheap_test|VITE_FINOPS_MODEL_MODE|URLSearchParams/);
assert.match(router, /fetch\('\/api\/model-routing'/);
assert.match(router, /ROLE_INSTRUCTIONS/);
assert.match(router, /await getModelRoutingConfig\(\)/);
assert.doesNotMatch(analysis, /runStage\(['"]preflight['"]/);
assert.match(analysis, /sanitizeEvidenceSources\(sources\)/);
assert.ok(analysis.indexOf('sanitizeEvidenceSources(sources)') < analysis.indexOf('runPhase1Audit('));
assert.ok(analysis.indexOf('buildEvidenceLaneStagePackets({') < analysis.indexOf('runPhase1Audit('));
assert.match(orchestrator, /<KNOWLEDGE_CONTEXT source_role="GOVERNED_KNOWLEDGE">/);
assert.match(orchestrator, /<EVIDENCE_CONTEXT source_role="CUSTOMER_EVIDENCE">/);
assert.match(orchestrator, /assertEvidenceLaneStagePacket\(packet\)/);
assert.doesNotMatch(modelContracts, /\| 'preflight'/);
assert.match(analysis, /model_mode: modelRoutingMode/);
assert.match(analysis, /evidence_density < EVIDENCE_DENSITY_BLOCK[\s\S]*?reason_code: 'EVIDENCE_DENSITY_BELOW_FLOOR'/);
assert.match(server, /resolveModelRouting\(process\.env\)/);

console.log('AI role routing policy tests passed');
