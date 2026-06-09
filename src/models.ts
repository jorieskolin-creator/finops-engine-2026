// Central model registry. EDIT THIS FILE to retune the pipeline — no other
// code changes required. Each stage of the assessment maps to a named model
// profile and an ordered fallback chain. The router (src/services/modelRouter.ts)
// resolves a stage to its profile chain and dispatches to the correct provider.
//
// Provider-specific notes
// -----------------------
// Anthropic (Sonnet/Opus/Haiku): maxTokens, optional extended thinking budget
// OpenAI (GPT-5.x): reasoning.effort, maxTokens
//
// Model IDs may need adjustment as providers rename previews → GA. The router
// reads `id` verbatim and forwards it to the provider, so a typo here is the
// only thing that breaks a swap.

export type Provider = 'anthropic' | 'openai';

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

export type ModelRoutingMode = 'normal' | 'cheap_test';

// Stage IDs — every LLM call in the pipeline belongs to exactly one stage.
export type StageId =
  | 'preflight'           // Phase 0: DLP / safety scan
  | 'forensic_audit'      // Phase 1: 5 parallel batch audits
  | 'targeted_rescan'     // Phase 1 repair: high-value second-opinion rescans
  | 'evidence_check'      // Phase 1.5: verify batch evidence before scoring
  | 'evidence_adjudication'// Phase 1.6: resolve disputed anti-pattern semantics
  | 'synthesis'           // Phase 3: strategy + roadmap (default)
  | 'roadmap_synthesis'   // Phase 3: deeper planning/roadmap substage
  | 'synthesis_escalation'// Phase 3: high-stakes / complex orgs
  | 'fact_check'          // Phase 3.5: claim verification
  | 'fact_check_high'     // Phase 3.5: high-reasoning retry for fact-check BLOCKs
  | 'quality_gate';       // Phase 2.5: reserved for future LLM-driven QG

// ============================================================================
// Profiles — named, reusable model configurations
// ============================================================================

export const PROFILES = {
  // Anthropic family
  SONNET_46: {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    maxTokens: 8192,
  } satisfies ModelProfile,

  OPUS_47: {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    maxTokens: 8192,
  } satisfies ModelProfile,

  HAIKU_45: {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    maxTokens: 4096,
  } satisfies ModelProfile,

  // OpenAI family
  GPT_55_PREFLIGHT: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'low' },
    maxTokens: 4096,
  } satisfies ModelProfile,

  GPT_55_AUDIT: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_55_EVIDENCE_CHECK: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_55_SYNTHESIS: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_55_FACT_CHECK: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_55_FACT_CHECK_HIGH: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'high' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_55_QUALITY_GATE: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 8192,
  } satisfies ModelProfile,

  GPT_55_ROADMAP: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_PREFLIGHT: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'low' },
    maxTokens: 4096,
  } satisfies ModelProfile,

  GPT_54_MINI_AUDIT: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_EVIDENCE_CHECK: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_SYNTHESIS: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_ROADMAP: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_FACT_CHECK: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_FACT_CHECK_HIGH: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'high' },
    maxTokens: 12000,
  } satisfies ModelProfile,

  GPT_54_MINI_QUALITY_GATE: {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
    maxTokens: 8192,
  } satisfies ModelProfile,
} as const;

// ============================================================================
// Stage assignments — change a stage's primary by editing the value here
// ============================================================================

export const NORMAL_STAGE_MODELS: Record<StageId, ModelProfile> = {
  preflight:            PROFILES.GPT_55_PREFLIGHT,
  forensic_audit:       PROFILES.SONNET_46,
  targeted_rescan:      PROFILES.OPUS_47,
  evidence_check:       PROFILES.GPT_55_EVIDENCE_CHECK,
  evidence_adjudication: PROFILES.GPT_55_FACT_CHECK,
  synthesis:            PROFILES.SONNET_46,
  roadmap_synthesis:    PROFILES.OPUS_47,
  synthesis_escalation: PROFILES.OPUS_47,
  fact_check:           PROFILES.GPT_55_FACT_CHECK,
  fact_check_high:      PROFILES.GPT_55_FACT_CHECK_HIGH,
  quality_gate:         PROFILES.GPT_55_QUALITY_GATE,
};

export const CHEAP_TEST_STAGE_MODELS: Record<StageId, ModelProfile> = {
  preflight:            PROFILES.GPT_54_MINI_PREFLIGHT,
  forensic_audit:       PROFILES.HAIKU_45,
  targeted_rescan:      PROFILES.GPT_54_MINI_AUDIT,
  evidence_check:       PROFILES.GPT_54_MINI_EVIDENCE_CHECK,
  evidence_adjudication: PROFILES.GPT_54_MINI_FACT_CHECK,
  synthesis:            PROFILES.HAIKU_45,
  roadmap_synthesis:    PROFILES.GPT_54_MINI_ROADMAP,
  synthesis_escalation: PROFILES.GPT_54_MINI_SYNTHESIS,
  fact_check:           PROFILES.GPT_54_MINI_FACT_CHECK,
  fact_check_high:      PROFILES.GPT_54_MINI_FACT_CHECK_HIGH,
  quality_gate:         PROFILES.GPT_54_MINI_QUALITY_GATE,
};

// ============================================================================
// Fallback chains — tried in order if primary fails
//
// Tiering rule: order fallbacks by task fit, not only provider family.
// This deployment intentionally excludes Gemini providers. Fast safety checks,
// independent verification, synthesis, and validation route through GPT-5.5
// and Claude profiles only.
// ============================================================================

export const NORMAL_FALLBACK_CHAIN: Record<StageId, ModelProfile[]> = {
  preflight:            [PROFILES.SONNET_46],
  forensic_audit:       [PROFILES.GPT_55_AUDIT, PROFILES.OPUS_47],
  targeted_rescan:      [PROFILES.GPT_55_ROADMAP, PROFILES.SONNET_46],
  evidence_check:       [PROFILES.SONNET_46, PROFILES.OPUS_47],
  evidence_adjudication: [PROFILES.OPUS_47],
  synthesis:            [PROFILES.GPT_55_SYNTHESIS, PROFILES.OPUS_47],
  roadmap_synthesis:    [PROFILES.GPT_55_ROADMAP, PROFILES.SONNET_46],
  synthesis_escalation: [PROFILES.GPT_55_SYNTHESIS, PROFILES.SONNET_46],
  fact_check:           [PROFILES.SONNET_46],
  fact_check_high:      [PROFILES.SONNET_46],
  quality_gate:         [PROFILES.SONNET_46],
};

export const CHEAP_TEST_FALLBACK_CHAIN: Record<StageId, ModelProfile[]> = {
  preflight:            [PROFILES.SONNET_46],
  forensic_audit:       [PROFILES.SONNET_46],
  targeted_rescan:      [PROFILES.SONNET_46],
  evidence_check:       [PROFILES.SONNET_46],
  evidence_adjudication: [PROFILES.SONNET_46],
  synthesis:            [PROFILES.SONNET_46],
  roadmap_synthesis:    [PROFILES.SONNET_46],
  synthesis_escalation: [PROFILES.SONNET_46],
  fact_check:           [PROFILES.SONNET_46],
  fact_check_high:      [PROFILES.SONNET_46],
  quality_gate:         [PROFILES.SONNET_46],
};

const configuredRoutingMode = (): ModelRoutingMode => {
  const override = (globalThis as any).__FINOPS_MODEL_MODE__;
  const meta = import.meta as any;
  const mode = override || meta?.env?.VITE_FINOPS_MODEL_MODE;cheap_test
  return mode === 'cheap_test' ? 'cheap_test' : 'normal';
};

export const MODEL_ROUTING_MODE: ModelRoutingMode = configuredRoutingMode();

export const STAGE_MODELS: Record<StageId, ModelProfile> =
  MODEL_ROUTING_MODE === 'cheap_test' ? CHEAP_TEST_STAGE_MODELS : NORMAL_STAGE_MODELS;

export const FALLBACK_CHAIN: Record<StageId, ModelProfile[]> =
  MODEL_ROUTING_MODE === 'cheap_test' ? CHEAP_TEST_FALLBACK_CHAIN : NORMAL_FALLBACK_CHAIN;

export function modelsFor(stage: StageId): ModelProfile[] {
  return [STAGE_MODELS[stage], ...FALLBACK_CHAIN[stage]];
}

// ============================================================================
// Backward-compat aliases — existing callers reference these directly.
// New code should call `modelsFor(stage)` via the router instead.
// ============================================================================

export const MODEL_PHASE1: ModelProfile = STAGE_MODELS.forensic_audit;
export const MODEL_PHASE3: ModelProfile = STAGE_MODELS.synthesis;
