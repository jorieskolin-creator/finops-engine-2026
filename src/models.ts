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
//
// Model IDs may need adjustment as providers rename previews → GA. The router
// reads `id` verbatim and forwards it to the provider, so a typo here is the
// only thing that breaks a swap.

export type Provider = 'gemini' | 'anthropic';

export type GeminiThinkingConfig =
  | { thinkingLevel: 'low' | 'medium' | 'high' }
  | { thinkingBudget: number };

export interface AnthropicThinkingConfig {
  type: 'enabled';
  budget_tokens: number;
}

export interface ModelProfile {
  id: string;
  provider: Provider;
  thinkingConfig?: GeminiThinkingConfig;
  anthropicThinking?: AnthropicThinkingConfig;
  maxTokens?: number;
}

// Stage IDs — every LLM call in the pipeline belongs to exactly one stage.
export type StageId =
  | 'preflight'           // Phase 0: DLP / safety scan
  | 'forensic_audit'      // Phase 1: 5 parallel batch audits
  | 'synthesis'           // Phase 3: strategy + roadmap (default)
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
} as const;

// ============================================================================
// Stage assignments — change a stage's primary by editing the value here
// ============================================================================

export const STAGE_MODELS: Record<StageId, ModelProfile> = {
  preflight:            PROFILES.GEMINI_3_FLASH,
  forensic_audit:       PROFILES.SONNET_46,
  synthesis:            PROFILES.SONNET_46,
  synthesis_escalation: PROFILES.OPUS_47,
  fact_check:           PROFILES.GEMINI_31_PRO,
  quality_gate:         PROFILES.GEMINI_31_PRO,
};

// ============================================================================
// Fallback chains — tried in order if primary fails
//
// Tiering rule: in-family next-tier-down first, cross-provider last.
// For quality_gate / fact_check, the cross-provider fallback breaks
// independence — that's a known tradeoff (better degraded check than none).
// ============================================================================

export const FALLBACK_CHAIN: Record<StageId, ModelProfile[]> = {
  preflight:            [PROFILES.GEMINI_25_FLASH, PROFILES.HAIKU_45],
  forensic_audit:       [PROFILES.HAIKU_45, PROFILES.GEMINI_25_PRO],
  synthesis:            [PROFILES.HAIKU_45, PROFILES.GEMINI_25_PRO],
  synthesis_escalation: [PROFILES.SONNET_46, PROFILES.GEMINI_25_PRO],
  fact_check:           [PROFILES.GEMINI_25_PRO, PROFILES.SONNET_46],
  quality_gate:         [PROFILES.GEMINI_25_PRO, PROFILES.SONNET_46],
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
