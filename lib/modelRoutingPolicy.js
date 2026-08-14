export const MODEL_ROUTING_SCHEMA_VERSION = 'model_routing_config_v1';
export const MODEL_ROUTING_POLICY_VERSION = 'provider_stage_routing_v2';

export const MODEL_STAGES = Object.freeze([
  'forensic_audit',
  'targeted_rescan',
  'evidence_check',
  'evidence_adjudication',
  'synthesis',
  'roadmap_synthesis',
  'synthesis_escalation',
  'fact_check',
  'fact_check_high',
  'quality_gate',
]);

const PROVIDERS = new Set(['ANTHROPIC', 'OPENAI', 'QWEN']);
const profile = (id, provider, options = {}) => Object.freeze({ id, provider, ...options });

const PROFILES = Object.freeze({
  sonnet: profile('claude-sonnet-4-6', 'anthropic', { maxTokens: 8192 }),
  opus: profile('claude-opus-4-7', 'anthropic', { maxTokens: 8192 }),
  gpt54MiniQuality: profile('gpt-5.4-mini', 'openai', { openaiReasoning: { effort: 'medium' }, maxTokens: 8192 }),
  gpt55Medium: profile('gpt-5.5', 'openai', { openaiReasoning: { effort: 'medium' }, maxTokens: 12000 }),
  gpt55High: profile('gpt-5.5', 'openai', { openaiReasoning: { effort: 'high' }, maxTokens: 12000 }),
  gpt55Quality: profile('gpt-5.5', 'openai', { openaiReasoning: { effort: 'medium' }, maxTokens: 8192 }),
  qwen38Max: profile('qwen3.8-max', 'qwen'),
});

const PROVIDER_STAGE_PROFILES = Object.freeze({
  ANTHROPIC: Object.freeze({
    forensic_audit: PROFILES.sonnet,
    targeted_rescan: PROFILES.opus,
    evidence_check: PROFILES.sonnet,
    evidence_adjudication: PROFILES.opus,
    synthesis: PROFILES.sonnet,
    roadmap_synthesis: PROFILES.opus,
    synthesis_escalation: PROFILES.opus,
    fact_check: PROFILES.sonnet,
    fact_check_high: PROFILES.opus,
    quality_gate: PROFILES.sonnet,
  }),
  OPENAI: Object.freeze({
    forensic_audit: PROFILES.gpt55Medium,
    targeted_rescan: PROFILES.gpt55High,
    evidence_check: PROFILES.gpt55Medium,
    evidence_adjudication: PROFILES.gpt55High,
    synthesis: PROFILES.gpt55Medium,
    roadmap_synthesis: PROFILES.gpt55High,
    synthesis_escalation: PROFILES.gpt55High,
    fact_check: PROFILES.gpt55Medium,
    fact_check_high: PROFILES.gpt55High,
    quality_gate: PROFILES.gpt54MiniQuality,
  }),
  QWEN: Object.freeze(Object.fromEntries(MODEL_STAGES.map(stage => [stage, PROFILES.qwen38Max]))),
});

const LEGACY_ROUTES = Object.freeze({
  forensic_audit: [PROFILES.sonnet, PROFILES.gpt55Medium, PROFILES.opus],
  targeted_rescan: [PROFILES.opus, PROFILES.gpt55Medium, PROFILES.sonnet],
  evidence_check: [PROFILES.gpt55Medium, PROFILES.sonnet, PROFILES.opus],
  evidence_adjudication: [PROFILES.gpt55Medium, PROFILES.opus],
  synthesis: [PROFILES.sonnet, PROFILES.gpt55Medium, PROFILES.opus],
  roadmap_synthesis: [PROFILES.opus, PROFILES.gpt55Medium, PROFILES.sonnet],
  synthesis_escalation: [PROFILES.opus, PROFILES.gpt55Medium, PROFILES.sonnet],
  fact_check: [PROFILES.gpt55Medium, PROFILES.sonnet],
  fact_check_high: [PROFILES.gpt55High, PROFILES.sonnet],
  quality_gate: [PROFILES.gpt55Quality, PROFILES.sonnet],
});

export class ModelRoutingConfigurationError extends Error {
  constructor() {
    super('MODEL_ROUTING_CONFIGURATION_INVALID');
    this.code = 'MODEL_ROUTING_CONFIGURATION_INVALID';
  }
}

const configuredProvider = (value, allowNone = false) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  if (PROVIDERS.has(normalized) || (allowNone && normalized === 'NONE')) return normalized;
  throw new ModelRoutingConfigurationError();
};

const deduplicate = profiles => profiles.filter((candidate, index) =>
  profiles.findIndex(other => other.provider === candidate.provider && other.id === candidate.id) === index
);

export const settingsForProfile = candidate => ({
  ...(candidate.maxTokens !== undefined ? { max_tokens: candidate.maxTokens } : {}),
  ...(candidate.openaiReasoning ? { reasoning_effort: candidate.openaiReasoning.effort } : {}),
  ...(candidate.anthropicThinking ? { thinking_budget_tokens: candidate.anthropicThinking.budget_tokens } : {}),
});

export function resolveModelRouting(env = process.env) {
  const primary = configuredProvider(env.PRIMARY_MODEL_PROVIDER);
  const fallback = configuredProvider(env.FALLBACK_MODEL_PROVIDER, true);
  if (!primary && fallback) throw new ModelRoutingConfigurationError();

  if (!primary) {
    return {
      schema_version: MODEL_ROUTING_SCHEMA_VERSION,
      policy_version: MODEL_ROUTING_POLICY_VERSION,
      mode: 'legacy',
      label: 'legacy',
      primary_provider: null,
      fallback_provider: null,
      routes: LEGACY_ROUTES,
    };
  }

  const effectiveFallback = fallback || 'NONE';
  const routes = Object.fromEntries(MODEL_STAGES.map(stage => [
    stage,
    deduplicate([
      PROVIDER_STAGE_PROFILES[primary][stage],
      ...(effectiveFallback === 'NONE' ? [] : [PROVIDER_STAGE_PROFILES[effectiveFallback][stage]]),
    ]),
  ]));
  return {
    schema_version: MODEL_ROUTING_SCHEMA_VERSION,
    policy_version: MODEL_ROUTING_POLICY_VERSION,
    mode: 'provider_policy',
    label: `${primary.toLowerCase()}_${effectiveFallback.toLowerCase()}`,
    primary_provider: primary,
    fallback_provider: effectiveFallback,
    routes,
  };
}

export function authorizedProfiles(stage, provider, model) {
  if (!MODEL_STAGES.includes(stage)) return [];
  return [...Object.values(PROVIDER_STAGE_PROFILES)
    .map(profiles => profiles[stage])
    .filter(candidate => candidate.provider === provider && candidate.id === model),
    ...LEGACY_ROUTES[stage].filter(candidate => candidate.provider === provider && candidate.id === model),
  ];
}

export function configuredProfile(stage, provider, model, env = process.env) {
  return resolveModelRouting(env).routes[stage]?.find(candidate => candidate.provider === provider && candidate.id === model);
}
