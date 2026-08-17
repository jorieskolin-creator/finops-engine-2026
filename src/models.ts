// Public model-routing contracts. Exact model IDs, role assignments and
// provider policy are server-owned in lib/modelRoutingPolicy.js.

export type Provider = 'anthropic' | 'openai' | 'xai';
export type AiRole = 'REASONER' | 'WORKHORSE' | 'QUALITY_CHECKER';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelProfile {
  id: string;
  provider: Provider;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
}

export type StageId =
  | 'forensic_audit'
  | 'targeted_rescan'
  | 'evidence_check'
  | 'evidence_adjudication'
  | 'synthesis'
  | 'roadmap_synthesis'
  | 'synthesis_escalation'
  | 'fact_check'
  | 'fact_check_high'
  | 'quality_gate';

export interface ModelRoutingConfig {
  schema_version: 'model_routing_config_v2';
  policy_version: string;
  mode: 'role_policy';
  label: string;
  stage_roles: Record<StageId, AiRole>;
  roles: Record<AiRole, {
    role: AiRole;
    primary_provider: 'ANTHROPIC' | 'OPENAI' | 'XAI';
    fallback_provider: 'ANTHROPIC' | 'OPENAI' | 'XAI';
    profiles: ModelProfile[];
  }>;
  routes: Record<StageId, ModelProfile[]>;
}
