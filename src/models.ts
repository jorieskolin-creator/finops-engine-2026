// Central model registry. EDIT THIS FILE to retune the pipeline — no other
// code changes required. Each stage of the assessment maps to a named model
// profile and an ordered fallback chain. The router (src/services/modelRouter.ts)
// resolves a stage to its profile chain and dispatches to the correct provider.
//
// Provider-specific notes
// -----------------------
// Gemini 3 (flash/pro):   thinkingConfig.thinkingLevel: 'low' | 'medium' | 'high'
// Gemini 2.5 (flash/pro): thinkingConfig.thinkingBudget: number
//                         (-1 dynamic, 0 disables on Flash only, positive = budget)
// Anthropic (Sonnet/Opus/Haiku): maxTokens, optional extended thinking budget
// OpenAI (GPT-5.x): reasoning.effort, maxTokens
//
// Model IDs may need adjustment as providers rename previews → GA. The router
// reads `id` verbatim and forwards it to the provider, so a typo here is the
// only thing that breaks a swap.

export type Provider = 'gemini' | 'anthropic' | 'openai';

export type GeminiThinkingConfig =
  | { thinkingLevel: 'low' | 'medium' | 'high' }
  | { thinkingBudget: number };

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
  thinkingConfig?: GeminiThinkingConfig;
  anthropicThinking?: AnthropicThinkingConfig;
  openaiReasoning?: OpenAIReasoningConfig;
  maxTokens?: number;
}

// Stage IDs — every LLM call in the pipeline belongs to exactly one stage.
export type StageId =
  | 'preflight'           // Phase 0: DLP / safety scan
  | 'forensic_audit'      // Phase 1: 5 parallel batch audits
  | 'evidence_check'      // Phase 1.5: verify batch evidence before scoring
  | 'synthesis'           // Phase 3: strategy + roadmap (default)
  | 'roadmap_synthesis'   // Phase 3: deeper planning/roadmap substage
  | 'synthesis_escalation'// Phase 3: high-stakes / complex orgs
  | 'fact_check'          // Phase 3.5: claim verification
  | 'quality_gate';       // Phase 2.5: reserved for future LLM-driven QG

// ============================================================================
// Profiles — named, reusable model configurations
// ============================================================================

export const PROFILES = {
  // Gemini family
  GEMINI_3_FLASH: {
    id: 'gemini-3-flash-preview',
    provider: 'gemini',
    thinkingConfig: { thinkingLevel: 'low' },
  } satisfies ModelProfile,

  GEMINI_3_FLASH_MEDIUM: {
    id: 'gemini-3-flash-preview',
    provider: 'gemini',
    thinkingConfig: { thinkingLevel: 'medium' },
  } satisfies ModelProfile,

  GEMINI_31_PRO: {
    id: 'gemini-3.1-pro-preview',
    provider: 'gemini',
    thinkingConfig: { thinkingLevel: 'high' },
  } satisfies ModelProfile,

  GEMINI_25_FLASH: {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    thinkingConfig: { thinkingBudget: -1 },
  } satisfies ModelProfile,

  GEMINI_25_PRO: {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    thinkingConfig: { thinkingBudget: -1 },
  } satisfies ModelProfile,

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
  GPT_55_FACT_CHECK: {
    id: 'gpt-5.5',
    provider: 'openai',
    openaiReasoning: { effort: 'medium' },
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
} as const;

// ============================================================================
// Stage assignments — change a stage's primary by editing the value here
// ============================================================================

export const STAGE_MODELS: Record<StageId, ModelProfile> = {
  preflight:            PROFILES.GEMINI_3_FLASH,
  forensic_audit:       PROFILES.SONNET_46,
  evidence_check:       PROFILES.GEMINI_31_PRO,
  synthesis:            PROFILES.SONNET_46,
  roadmap_synthesis:    PROFILES.OPUS_47,
  synthesis_escalation: PROFILES.OPUS_47,
  fact_check:           PROFILES.GPT_55_FACT_CHECK,
  quality_gate:         PROFILES.GPT_55_QUALITY_GATE,
};

// ============================================================================
// Fallback chains — tried in order if primary fails
//
// Tiering rule: in-family next-tier-down first, cross-provider last.
// For quality_gate / fact_check, keep the fallback non-Gemini during the
// GPT-5.5 trial so Gemini streaming instability cannot dominate Phase 3
// validation outcomes.
// ============================================================================

export const FALLBACK_CHAIN: Record<StageId, ModelProfile[]> = {
  preflight:            [PROFILES.GEMINI_25_FLASH, PROFILES.HAIKU_45],
  forensic_audit:       [PROFILES.HAIKU_45, PROFILES.GEMINI_25_PRO],
  evidence_check:       [PROFILES.GEMINI_25_PRO, PROFILES.SONNET_46],
  synthesis:            [PROFILES.HAIKU_45, PROFILES.GEMINI_25_PRO],
  roadmap_synthesis:    [PROFILES.GPT_55_ROADMAP, PROFILES.GEMINI_31_PRO],
  synthesis_escalation: [PROFILES.SONNET_46, PROFILES.GEMINI_25_PRO],
  fact_check:           [PROFILES.SONNET_46],
  quality_gate:         [PROFILES.SONNET_46],
};

export function modelsFor(stage: StageId): ModelProfile[] {
  return [STAGE_MODELS[stage], ...FALLBACK_CHAIN[stage]];
}

// ============================================================================
// Backward-compat aliases — existing callers reference these directly.
// New code should call `modelsFor(stage)` via the router instead.
// ============================================================================

export const MODEL_PHASE1: ModelProfile = STAGE_MODELS.forensic_audit;
export const MODEL_PHASE3: ModelProfile = STAGE_MODELS.synthesis;
