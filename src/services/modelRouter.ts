// Provider-agnostic model dispatcher with fallback chain.
//
// Call sites build a NormalizedPrompt and hand it to `runStage(stageId, prompt, ctx)`.
// The router resolves the stage to its primary + fallbacks (see src/models.ts),
// adapts the prompt to the active provider's request shape, and posts to the
// matching server endpoint (/api/generate for Gemini, /api/anthropic-generate
// for Anthropic). On failure it logs and falls forward to the next model.
//
// `stage` and `runId` ride along in the request body so the server endpoints
// can emit correlated structured logs visible in Railway.

import { ImageInput } from '../types';
import { ModelProfile, StageId, modelsFor } from '../models';

export interface NormalizedPrompt {
  userText: string;
  systemInstruction?: string;
  images?: ImageInput[];
}

export interface RunContext {
  runId: string;
}

const REQUEST_TIMEOUT_MS = 595_000;

async function callGemini(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string }> {
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

  return postWithTimeout('/api/generate', {
    model: profile.id,
    contents: [{ role: 'user', parts }],
    systemInstruction: prompt.systemInstruction,
    thinkingConfig: profile.thinkingConfig,
    stage,
    runId: ctx.runId,
  });
}

async function callAnthropic(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string }> {
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
    stage,
    runId: ctx.runId,
  };
  if (profile.anthropicThinking) {
    body.thinking = profile.anthropicThinking;
  }

  return postWithTimeout('/api/anthropic-generate', body);
}

async function callOpenAI(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string }> {
  const content: any[] = [{ type: 'input_text', text: prompt.userText }];
  if (prompt.images?.length) {
    content.push({
      type: 'input_text',
      text: `\n\nThe following ${prompt.images.length} image(s) are part of the source material. Treat their visible content as evidence on equal footing with text. Each image is identified by its source filename and (for PDF-derived images) page number; for those, set evidence_source: "image" and include page_number when citing.`,
    });
    for (const img of prompt.images) {
      const label = img.page_number !== undefined
        ? `[Image: ${img.source_name} — page ${img.page_number}]`
        : `[Image: ${img.source_name}]`;
      content.push({ type: 'input_text', text: `\n${label}\n` });
      content.push({
        type: 'input_image',
        image_url: `data:${img.mimeType};base64,${img.data}`,
      });
    }
  }

  return postWithTimeout('/api/openai-generate', {
    model: profile.id,
    input: [{ role: 'user', content }],
    instructions: prompt.systemInstruction,
    reasoning: profile.openaiReasoning,
    maxOutputTokens: profile.maxTokens ?? 4096,
    stage,
    runId: ctx.runId,
  });
}

// Reads the NDJSON stream emitted by api/generate.js + api/anthropic-generate.js.
//
// Wire frames:
//   { type: 'text',      delta: string }    incremental text (accumulated)
//   { type: 'keepalive' }                   ignored, keeps proxy alive
//   { type: 'done',      text: string, usage?: any }  terminal success
//   { type: 'error',     message: string }  terminal failure
//
// If the stream ends without a 'done' frame (connection dropped, server
// crashed), we throw — the router catches it and falls forward to the
// next model in the chain. Returning partial text would corrupt downstream
// JSON.parse, which is worse than retrying.
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
    if (!res.body) {
      throw new Error(`${url} → no response body`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalText: string | null = null;
    let streamError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame.type === 'keepalive') continue;
        if (frame.type === 'text') continue; // accumulated server-side
        if (frame.type === 'done') {
          finalText = typeof frame.text === 'string' ? frame.text : '';
        } else if (frame.type === 'error') {
          streamError = typeof frame.message === 'string' ? frame.message : 'stream error';
        }
      }
    }

    if (streamError) throw new Error(streamError);
    if (finalText === null) {
      throw new Error(`${url} → stream ended without 'done' frame`);
    }
    return { text: finalText };
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string }> {
  if (profile.provider === 'gemini') return callGemini(profile, prompt, stage, ctx);
  if (profile.provider === 'anthropic') return callAnthropic(profile, prompt, stage, ctx);
  if (profile.provider === 'openai') return callOpenAI(profile, prompt, stage, ctx);
  throw new Error(`Unknown provider: ${(profile as any).provider}`);
}

export interface RunStageResult {
  text: string;
  modelUsed: ModelProfile;
  attempts: Array<{ profile: ModelProfile; error: string }>;
}

export async function runStage(stage: StageId, prompt: NormalizedPrompt, ctx: RunContext): Promise<RunStageResult> {
  const chain = modelsFor(stage);
  const failures: Array<{ profile: ModelProfile; error: string }> = [];
  for (const profile of chain) {
    try {
      const result = await callModel(profile, prompt, stage, ctx);
      if (failures.length > 0) {
        await serverLog(ctx.runId, 'warn', 'stage_fallback_used', {
          stage,
          succeeded_with: profile.id,
          provider: profile.provider,
          failed_models: failures.map((f) => f.profile.id).join(','),
        });
      }
      return { text: result.text, modelUsed: profile, attempts: failures };
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[modelRouter] stage=${stage} provider=${profile.provider} id=${profile.id} failed: ${msg}`);
      failures.push({ profile, error: msg });
    }
  }
  const summary = failures.map((f) => `${f.profile.id}: ${f.error}`).join(' | ');
  await serverLog(ctx.runId, 'error', 'stage_exhausted', { stage, summary });
  throw new Error(`All models exhausted for stage '${stage}'. ${summary}`);
}

// Fire-and-forget server-side log so pipeline events appear in Railway alongside
// the per-call proxy logs. Never throws — logging failures must not break runs.
export async function serverLog(runId: string, level: 'info' | 'warn' | 'error', event: string, fields: Record<string, any> = {}): Promise<void> {
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, level, event, ...fields }),
      keepalive: true,
    });
  } catch {
    // intentionally swallow
  }
}

export function newRunId(): string {
  // Compact, sortable, human-grep-able. 9 chars random suffix is enough for
  // unique-per-day given low volume.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const rand = Math.random().toString(36).slice(2, 11);
  return `${ts}-${rand}`;
}
