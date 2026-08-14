// Public model-routing contracts. Exact model IDs, stage assignments and
// provider policy are server-owned in lib/modelRoutingPolicy.js.

export type Provider = 'anthropic' | 'openai' | 'qwen';

export interface AnthropicThinkingConfig {
  type: 'enabled';
  budget_tokens: number;
}

export interface OpenAIReasoningConfig {
  effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface ModelProfile {
  id: string;
  provider: Provider;
  anthropicThinking?: AnthropicThinkingConfig;
  openaiReasoning?: OpenAIReasoningConfig;
  maxTokens?: number;
}

export type StageId =
  | 'preflight'
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
  schema_version: 'model_routing_config_v1';
  policy_version: string;
  mode: 'legacy' | 'provider_policy';
  label: string;
  primary_provider: 'ANTHROPIC' | 'OPENAI' | 'QWEN' | null;
  fallback_provider: 'ANTHROPIC' | 'OPENAI' | 'QWEN' | 'NONE' | null;
  routes: Record<StageId, ModelProfile[]>;
}
