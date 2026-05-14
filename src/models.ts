// Centralized model + thinking configuration. Swap these to retune the engine
// without touching service code.
//
// Two different shapes are used because Gemini 3 and Gemini 2.5 expose
// different thinking controls:
//
//   - Gemini 3 (flash/pro):  thinkingConfig.thinkingLevel: 'low' | 'medium' | 'high'
//   - Gemini 2.5 (flash/pro): thinkingConfig.thinkingBudget: number
//                              (-1 dynamic, 0 off-Flash-only, positive = token budget)
//
// You cannot mix `thinkingLevel` and `thinkingBudget` in the same request —
// the API returns 400. We pick the right one per model below.
//
// During tech-testing we minimize cost: Phase 1 uses Gemini 3 Flash at
// thinkingLevel 'low' (5 parallel batches + DLP scan); Phase 3 uses Gemini
// 2.5 Pro with dynamic thinking budget (Pro can't be disabled).

export type GeminiThinkingConfig =
  | { thinkingLevel: 'low' | 'medium' | 'high' }
  | { thinkingBudget: number };

export interface ModelProfile {
  id: string;
  thinkingConfig: GeminiThinkingConfig;
}

// Phase 0 (DLP safety scan) + Phase 1 (5 parallel batch audits).
export const MODEL_PHASE1: ModelProfile = {
  id: 'gemini-3-flash-preview',
  thinkingConfig: { thinkingLevel: 'low' },
};

// Phase 3 (single strategy synthesis call).
export const MODEL_PHASE3: ModelProfile = {
  id: 'gemini-2.5-pro',
  thinkingConfig: { thinkingBudget: -1 },
};
