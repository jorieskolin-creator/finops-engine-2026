// Provider-agnostic model dispatcher with fallback chain.
//
// Call sites build a NormalizedPrompt and hand it to `runStage(stageId, prompt)`.
// The router resolves the stage to its primary + fallbacks (see src/models.ts),
// adapts the prompt to the active provider's request shape, and posts to the
// matching server endpoint (/api/generate for Gemini, /api/anthropic-generate
// for Anthropic). On failure it logs and falls forward to the next model in
// the chain.

import { ImageInput } from '../types';
import { ModelProfile, StageId, modelsFor } from '../models';

export interface NormalizedPrompt {
  // Single concatenated user prompt. Callers that previously built `parts[]`
  // can join their text blocks with '\n\n'.
  userText: string;
  // System instruction (Gemini: systemInstruction, Anthropic: system).
  systemInstruction?: string;
  // Optional multimodal payload. Each image is rendered with a label so
  // the model can cite "[Image: foo.pdf — page 3]" verbatim.
  images?: ImageInput[];
}

const REQUEST_TIMEOUT_MS = 595_000;

async function callGemini(profile: ModelProfile, prompt: NormalizedPrompt): Promise<{ text: string }> {
  const parts: any[] = [{ text: prompt.userText }];
  if (prompt.images?.length) {
    parts.push({
      text: `\n\nThe following ${prompt.images.length} image(s) are part of the source material. Treat their visible content as evidence on equal footing with text. Each image is identified by its source filename and (for PDF-derived images) page number; for those, set evidence_source: "image" and include page_number when citing.`,
    });
    for (const img of prompt.images) {
      const label = img.page_number !== undefined
        ? `[Image: ${img.source_name} — page ${img.page_number}]`
        : `[Image: ${img.source_name}]`;
      parts.push({ text: `\n${label}\n` });
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  const body = {
    model: profile.id,
    contents: [{ role: 'user', parts }],
    systemInstruction: prompt.systemInstruction,
    thinkingConfig: profile.thinkingConfig,
  };

  return postWithTimeout('/api/generate', body);
}

async function callAnthropic(profile: ModelProfile, prompt: NormalizedPrompt): Promise<{ text: string }> {
  const content: any[] = [{ type: 'text', text: prompt.userText }];
  if (prompt.images?.length) {
    content.push({
      type: 'text',
      text: `\n\nThe following ${prompt.images.length} image(s) are part of the source material. Treat their visible content as evidence on equal footing with text. Each image is identified by its source filename and (for PDF-derived images) page number; for those, set evidence_source: "image" and include page_number when citing.`,
    });
    for (const img of prompt.images) {
      const label = img.page_number !== undefined
        ? `[Image: ${img.source_name} — page ${img.page_number}]`
        : `[Image: ${img.source_name}]`;
      content.push({ type: 'text', text: `\n${label}\n` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data },
      });
    }
  }

  const body: any = {
    model: profile.id,
    messages: [{ role: 'user', content }],
    systemPrompt: prompt.systemInstruction,
    maxTokens: profile.maxTokens ?? 4096,
  };
  if (profile.anthropicThinking) {
    body.thinking = profile.anthropicThinking;
  }

  return postWithTimeout('/api/anthropic-generate', body);
}

async function postWithTimeout(url: string, body: any): Promise<{ text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${url} → ${res.status}: ${errText || res.statusText}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(profile: ModelProfile, prompt: NormalizedPrompt): Promise<{ text: string }> {
  if (profile.provider === 'gemini') return callGemini(profile, prompt);
  if (profile.provider === 'anthropic') return callAnthropic(profile, prompt);
  throw new Error(`Unknown provider: ${(profile as any).provider}`);
}

export interface RunStageResult {
  text: string;
  modelUsed: ModelProfile;
  attempts: Array<{ profile: ModelProfile; error: string }>;
}

export async function runStage(stage: StageId, prompt: NormalizedPrompt): Promise<RunStageResult> {
  const chain = modelsFor(stage);
  const failures: Array<{ profile: ModelProfile; error: string }> = [];
  for (const profile of chain) {
    try {
      const result = await callModel(profile, prompt);
      return { text: result.text, modelUsed: profile, attempts: failures };
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[modelRouter] stage=${stage} provider=${profile.provider} id=${profile.id} failed: ${msg}`);
      failures.push({ profile, error: msg });
    }
  }
  const summary = failures.map((f) => `${f.profile.id}: ${f.error}`).join(' | ');
  throw new Error(`All models exhausted for stage '${stage}'. ${summary}`);
}
