export const MODEL_ROUTING_SCHEMA_VERSION = 'model_routing_config_v2';
export const MODEL_ROUTING_POLICY_VERSION = 'ai_role_routing_v2';

export const AI_ROLES = Object.freeze([
  'REASONER',
  'WORKHORSE',
  'QUALITY_CHECKER',
]);

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

export const STAGE_ROLES = Object.freeze({
  forensic_audit: 'WORKHORSE',
  targeted_rescan: 'WORKHORSE',
  evidence_check: 'QUALITY_CHECKER',
  evidence_adjudication: 'REASONER',
  synthesis: 'WORKHORSE',
  roadmap_synthesis: 'REASONER',
  synthesis_escalation: 'REASONER',
  fact_check: 'QUALITY_CHECKER',
  fact_check_high: 'QUALITY_CHECKER',
  // This call explains an authoritative deterministic gate decision. It does
  // not verify or alter that decision, so it remains ordinary bounded work.
  quality_gate: 'WORKHORSE',
});

const PROVIDERS = new Set(['ANTHROPIC', 'OPENAI', 'XAI']);
const profile = (id, provider, options = {}) => Object.freeze({ id, provider, ...options });

const ROLE_PROVIDER_PROFILES = Object.freeze({
  REASONER: Object.freeze({
    OPENAI: profile('gpt-5.6-sol', 'openai', { reasoningEffort: 'high', maxTokens: 32768 }),
    ANTHROPIC: profile('claude-sonnet-5', 'anthropic', { maxTokens: 32768 }),
    XAI: profile('grok-4.6', 'xai', { reasoningEffort: 'high', maxTokens: 32768 }),
  }),
  WORKHORSE: Object.freeze({
    OPENAI: profile('gpt-5.6-sol', 'openai', { reasoningEffort: 'medium', maxTokens: 16384 }),
    ANTHROPIC: profile('claude-sonnet-5', 'anthropic', { maxTokens: 16384 }),
    XAI: profile('grok-4.6', 'xai', { reasoningEffort: 'medium', maxTokens: 16384 }),
  }),
  QUALITY_CHECKER: Object.freeze({
    OPENAI: profile('gpt-5.6-sol', 'openai', { reasoningEffort: 'medium', maxTokens: 16384 }),
    ANTHROPIC: profile('claude-sonnet-5', 'anthropic', { maxTokens: 16384 }),
    XAI: profile('grok-4.6', 'xai', { reasoningEffort: 'medium', maxTokens: 16384 }),
  }),
});

const STAGE_PROFILE_OVERRIDES = Object.freeze({
  synthesis: Object.freeze({
    anthropic: Object.freeze({ maxTokens: 24576 }),
  }),
});

const profileForStage = (stage, candidate) => {
  const override = STAGE_PROFILE_OVERRIDES[stage]?.[candidate.provider];
  return override ? Object.freeze({ ...candidate, ...override }) : candidate;
};

const ROLE_ENV_FIELDS = Object.freeze(AI_ROLES.flatMap(role => [
  `${role}_PROVIDER`,
  `${role}_MODEL`,
  `${role}_FALLBACK_PROVIDER`,
  `${role}_FALLBACK_MODEL`,
]));

const providerCredentialConfigured = (provider, env) => {
  if (provider === 'OPENAI') return Boolean(env.GPT_API_KEY || env.OPENAI_API_KEY);
  if (provider === 'ANTHROPIC') return Boolean(env.ANTHROPIC_API_KEY);
  if (provider === 'XAI') return Boolean(env.XAI_API_KEY);
  return false;
};

export class ModelRoutingConfigurationError extends Error {
  constructor() {
    super('MODEL_ROUTING_CONFIGURATION_INVALID');
    this.code = 'MODEL_ROUTING_CONFIGURATION_INVALID';
  }
}

const requiredValue = value => {
  if (typeof value !== 'string' || !value.trim()) throw new ModelRoutingConfigurationError();
  return value.trim();
};

const configuredProvider = value => {
  const normalized = requiredValue(value).toUpperCase();
  if (!PROVIDERS.has(normalized)) throw new ModelRoutingConfigurationError();
  return normalized;
};

const configuredRole = (role, env) => {
  const primaryProvider = configuredProvider(env[`${role}_PROVIDER`]);
  const fallbackProvider = configuredProvider(env[`${role}_FALLBACK_PROVIDER`]);
  const primaryModel = requiredValue(env[`${role}_MODEL`]);
  const fallbackModel = requiredValue(env[`${role}_FALLBACK_MODEL`]);
  const primary = ROLE_PROVIDER_PROFILES[role][primaryProvider];
  const fallback = ROLE_PROVIDER_PROFILES[role][fallbackProvider];
  if (!primary || !fallback || primary.id !== primaryModel || fallback.id !== fallbackModel) {
    throw new ModelRoutingConfigurationError();
  }
  if (primary.provider === fallback.provider && primary.id === fallback.id) {
    throw new ModelRoutingConfigurationError();
  }
  return Object.freeze({ role, primary_provider: primaryProvider, fallback_provider: fallbackProvider, profiles: [primary, fallback] });
};

export const settingsForProfile = candidate => ({
  ...(candidate.maxTokens !== undefined ? { max_tokens: candidate.maxTokens } : {}),
  ...(candidate.reasoningEffort ? { reasoning_effort: candidate.reasoningEffort } : {}),
});

export function resolveModelRouting(env = process.env) {
  // A complete role policy is mandatory. Partial or legacy provider-level
  // configuration fails closed rather than silently selecting another model.
  if (ROLE_ENV_FIELDS.some(field => env[field] === undefined)) throw new ModelRoutingConfigurationError();
  if (env.PRIMARY_MODEL_PROVIDER !== undefined || env.FALLBACK_MODEL_PROVIDER !== undefined) {
    throw new ModelRoutingConfigurationError();
  }

  const roles = Object.fromEntries(AI_ROLES.map(role => [role, configuredRole(role, env)]));
  const configuredProviders = new Set(Object.values(roles)
    .flatMap(role => role.profiles)
    .map(candidate => candidate.provider.toUpperCase()));
  if ([...configuredProviders].some(provider => !providerCredentialConfigured(provider, env))) {
    throw new ModelRoutingConfigurationError();
  }
  const routes = Object.fromEntries(MODEL_STAGES.map(stage => [
    stage,
    Object.freeze(roles[STAGE_ROLES[stage]].profiles.map(candidate => profileForStage(stage, candidate))),
  ]));
  return {
    schema_version: MODEL_ROUTING_SCHEMA_VERSION,
    policy_version: MODEL_ROUTING_POLICY_VERSION,
    mode: 'role_policy',
    label: 'ai_role_policy',
    stage_roles: STAGE_ROLES,
    roles,
    routes,
  };
}

export function authorizedProfiles(stage, provider, model) {
  const role = STAGE_ROLES[stage];
  if (!role) return [];
  return Object.values(ROLE_PROVIDER_PROFILES[role])
    .filter(candidate => candidate.provider === provider && candidate.id === model)
    .map(candidate => profileForStage(stage, candidate));
}

export function configuredProfile(stage, provider, model, env = process.env) {
  return resolveModelRouting(env).routes[stage]?.find(candidate => candidate.provider === provider && candidate.id === model);
}
