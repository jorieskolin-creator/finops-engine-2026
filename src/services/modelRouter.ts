// Provider-agnostic model dispatcher with fallback chain.
//
// Call sites build a NormalizedPrompt and hand it to `runStage(stageId, prompt, ctx)`.
// The router resolves the stage to its primary + fallbacks (see src/models.ts),
// adapts the prompt to the active provider's request shape, and posts to the
// matching server endpoint. On failure it logs and falls forward to the next
// model.
//
// `stage` and `runId` ride along in the request body so the server endpoints
// can emit correlated structured logs visible in Railway.

import { ImageInput } from '../types';
import { ModelProfile, StageId, modelsFor } from '../models';
import { estimateTokens, hashString, recordStageTrace } from './runTraceService';
// @ts-expect-error Pure JS policy is also consumed by the serverless API.
import { filterOperationalMetadata } from '../../lib/operationalLogPolicy.js';

export interface NormalizedPrompt {
  userText: string;
  systemInstruction?: string;
  images?: ImageInput[];
}

export interface RunContext {
  runId: string;
}

const REQUEST_TIMEOUT_MS = 595_000;
const INTERNAL_RESULT_POLL_MS = 120_000;
const INTERNAL_RESULT_POLL_INTERVAL_MS = 2_000;
const INTERNAL_RESULT_MISSING_GRACE_MS = 10_000;
const INTERNAL_ERROR_CODES = new Set([
  'upstream_http_error', 'upstream_stream_error', 'transport_error',
  'incomplete_response', 'empty_output', 'model_request_failed',
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const newInternalCallId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `internal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

async function callAnthropic(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
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
    internalPipelineCall: true,
  };
  if (profile.anthropicThinking) {
    body.thinking = profile.anthropicThinking;
  }

  return postWithTimeout('/api/anthropic-generate', body);
}

async function callOpenAI(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
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
    internalPipelineCall: true,
  });
}

// Reads the NDJSON stream emitted by api/anthropic-generate.js and
// api/openai-generate.js.
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
async function pollInternalResult(body: any, cause: unknown): Promise<{ text: string; usage?: any } | null> {
  const internalCallId = body?.internalCallId;
  if (!body?.internalPipelineCall || !internalCallId) return null;

  const started = Date.now();
  const stage = body.stage || 'unknown';
  const model = body.model || 'unknown';
  const recoveryErrorCode = cause instanceof DOMException && cause.name === 'AbortError'
    ? 'request_timeout'
    : 'model_request_failed';
  let firstMissingAt: number | null = null;
  while (Date.now() - started < INTERNAL_RESULT_POLL_MS) {
    try {
      const res = await fetch('/api/model-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internalCallId }),
      });
      if (res.status === 404) {
        if (firstMissingAt === null) firstMissingAt = Date.now();
        if (Date.now() - firstMissingAt > INTERNAL_RESULT_MISSING_GRACE_MS) {
          return null;
        }
        await sleep(INTERNAL_RESULT_POLL_INTERVAL_MS);
        continue;
      }
      if (!res.ok) {
        throw new Error(`/api/model-result → ${res.status}`);
      }
      const data = await res.json();
      if (data?.status === 'pending') {
        await sleep(INTERNAL_RESULT_POLL_INTERVAL_MS);
        continue;
      }
      if (data?.status === 'done') {
        await serverLog(body.runId, 'info', 'internal_result_recovered', {
          stage,
          model,
          internal_call_id: internalCallId,
          duration_ms: Date.now() - started,
          response_chars: typeof data.text === 'string' ? data.text.length : 0,
        });
        return { text: typeof data.text === 'string' ? data.text : '', usage: data.usage };
      }
      if (data?.status === 'error') {
        const errorCode = typeof data.message === 'string' && INTERNAL_ERROR_CODES.has(data.message)
          ? data.message
          : 'model_request_failed';
        await serverLog(body.runId, 'error', 'internal_result_error', {
          stage,
          model,
          internal_call_id: internalCallId,
          error_code: errorCode,
        });
        return null;
      }
    } catch (err: any) {
      await sleep(INTERNAL_RESULT_POLL_INTERVAL_MS);
    }
  }

  await serverLog(body.runId, 'warn', 'internal_result_timeout', {
    stage,
    model,
    internal_call_id: internalCallId,
    duration_ms: Date.now() - started,
    error_code: recoveryErrorCode,
  });
  return null;
}

async function postWithTimeout(url: string, body: any): Promise<{ text: string; usage?: any }> {
  if (body?.internalPipelineCall && !body.internalCallId) {
    body.internalCallId = newInternalCallId();
  }
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
      throw new Error(`${url} request failed (HTTP ${res.status})`);
    }
    if (!res.body) {
      throw new Error(`${url} → no response body`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalText: string | null = null;
    let finalUsage: any = null;
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
          finalUsage = frame.usage || null;
        } else if (frame.type === 'error') {
          streamError = typeof frame.message === 'string' ? frame.message : 'stream error';
        }
      }
    }

    if (streamError) throw new Error(streamError);
    if (finalText === null) {
      throw new Error(`${url} → stream ended without 'done' frame`);
    }
    return { text: finalText, usage: finalUsage };
  } catch (err) {
    const recovered = await pollInternalResult(body, err);
    if (recovered) return recovered;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
  if (profile.provider === 'anthropic') return callAnthropic(profile, prompt, stage, ctx);
  if (profile.provider === 'openai') return callOpenAI(profile, prompt, stage, ctx);
  throw new Error(`Unknown provider: ${(profile as any).provider}`);
}

export interface RunStageResult {
  text: string;
  modelUsed: ModelProfile;
  attempts: Array<{ profile: ModelProfile; error: string }>;
}

const tokenUsageFromProvider = (usage: any) => ({
  input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
  output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
  reasoning_tokens: typeof usage?.output_tokens_details?.reasoning_tokens === 'number'
    ? usage.output_tokens_details.reasoning_tokens
    : typeof usage?.reasoning_tokens === 'number'
      ? usage.reasoning_tokens
      : undefined
});

export async function runStage(stage: StageId, prompt: NormalizedPrompt, ctx: RunContext): Promise<RunStageResult> {
  const chain = modelsFor(stage);
  const failures: Array<{ profile: ModelProfile; error: string }> = [];
  const stageStarted = Date.now();
  const startedAt = new Date(stageStarted).toISOString();
  const inputChars = (prompt.systemInstruction || '').length + prompt.userText.length;
  const promptHash = hashString(`${stage}\n${prompt.systemInstruction || ''}\n${prompt.userText}`);
  const contextPacketHash = hashString(prompt.userText);
  const fallbackChain = chain.map(profile => profile.id);
  for (const profile of chain) {
    try {
      const result = await callModel(profile, prompt, stage, ctx);
      const providerUsage = tokenUsageFromProvider(result.usage);
      recordStageTrace(ctx.runId, {
        stage_id: stage,
        provider: profile.provider,
        model: profile.id,
        fallback_chain: fallbackChain,
        attempt_count: failures.length + 1,
        prompt_hash: promptHash,
        context_packet_hash: contextPacketHash,
        input_char_count: inputChars,
        output_char_count: result.text.length,
        input_tokens: providerUsage.input_tokens,
        output_tokens: providerUsage.output_tokens,
        reasoning_tokens: providerUsage.reasoning_tokens,
        input_token_estimate: estimateTokens(inputChars),
        output_token_estimate: estimateTokens(result.text.length),
        duration_ms: Date.now() - stageStarted,
        status: 'ok',
        fallback_reason: failures.length > 0 ? `Recovered after ${failures.length} failed fallback attempt(s).` : undefined,
        failed_attempts: failures.map(f => ({ model: f.profile.id, provider: f.profile.provider, error: f.error })),
        started_at: startedAt,
        completed_at: new Date().toISOString()
      });
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
      const errorCode = err instanceof DOMException && err.name === 'AbortError'
        ? 'request_timeout'
        : 'model_request_failed';
      console.warn(`[modelRouter] stage=${stage} provider=${profile.provider} id=${profile.id} error_code=${errorCode}`);
      failures.push({ profile, error: errorCode });
    }
  }
  const summary = failures.map((f) => `${f.profile.id}: ${f.error}`).join(' | ');
  recordStageTrace(ctx.runId, {
    stage_id: stage,
    fallback_chain: fallbackChain,
    attempt_count: failures.length,
    prompt_hash: promptHash,
    context_packet_hash: contextPacketHash,
    input_char_count: inputChars,
    input_token_estimate: estimateTokens(inputChars),
    duration_ms: Date.now() - stageStarted,
    status: 'error',
    error: summary,
    failed_attempts: failures.map(f => ({ model: f.profile.id, provider: f.profile.provider, error: f.error })),
    started_at: startedAt,
    completed_at: new Date().toISOString()
  });
  await serverLog(ctx.runId, 'error', 'stage_exhausted', { stage, attempt_count: failures.length, error_code: 'models_exhausted' });
  throw new Error(`All models exhausted for stage '${stage}'. ${summary}`);
}

// Fire-and-forget server-side log so pipeline events appear in Railway alongside
// the per-call proxy logs. Never throws — logging failures must not break runs.
export async function serverLog(runId: string, level: 'info' | 'warn' | 'error', event: string, fields: Record<string, any> = {}): Promise<void> {
  try {
    const filteredFields = filterOperationalMetadata(event, fields);
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, level, event, ...filteredFields }),
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
