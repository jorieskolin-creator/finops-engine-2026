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
const GATEWAY_DEADLINE_MS = 540_000;
const RECOVERY_PROPAGATION_MS = 15_000;
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

const REQUEST_SCHEMA = 'stage_packet_request_v1';
const APPROVED_SCHEMA = 'approved_stage_packet_v1';
const OUTPUT_SCHEMA = 'governed_output_v1';
const POLICY = 'llm_egress_policy_v1';
async function governedCall(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
  if (prompt.images?.length) throw new Error('IMAGE_PAYLOAD_DISABLED: external image processing is disabled until local OCR/redaction exists');
  const settings: any = { max_tokens: profile.maxTokens ?? 4096 };
  if (profile.openaiReasoning) settings.reasoning_effort = profile.openaiReasoning.effort;
  if (profile.anthropicThinking) settings.thinking_budget_tokens = profile.anthropicThinking.budget_tokens;
  const approval = await fetch('/api/governed-packet', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ schema_version:REQUEST_SCHEMA, policy_version:POLICY, run_id:ctx.runId, stage, provider:profile.provider, model:profile.id, destination:`${profile.provider}:external_model`, system_instruction:prompt.systemInstruction || '', parts:[{type:'text',text:prompt.userText}], settings }) });
  if (!approval.ok) throw new Error(`STAGE_PACKET_REJECTED HTTP ${approval.status}`);
  const packet = await approval.json();
  if (packet.classification_method !== 'deterministic_pattern_screen_v1' || packet.approval_basis !== 'policy_approved_after_pattern_screening' || packet.run_id !== ctx.runId || packet.stage !== stage || packet.provider !== profile.provider || packet.model !== profile.id) throw new Error('INVALID_PACKET_APPROVAL');
  const body = { packet_id:packet.packet_id, packet_hash:packet.packet_hash, schema_version:APPROVED_SCHEMA, policy_version:POLICY, run_id:ctx.runId, stage, internal_pipeline_call:true, internal_call_id:newInternalCallId() };
  return postWithTimeout(`/api/${profile.provider}-generate`, body, packet);
}

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};
const validOutput = async (output: any, body: any, approval: any): Promise<boolean> => Boolean(
  output && output.schema_version === OUTPUT_SCHEMA && output.policy_version === POLICY && output.inspection_status === 'passed'
  && output.inspection_method === 'deterministic_pattern_screen_and_contact_redaction_v1'
  && output.run_id === body.run_id && output.stage === body.stage && output.provider === approval.provider && output.model === approval.model
  && output.source_packet_id === approval.packet_id && output.source_packet_hash === approval.packet_hash
  && typeof output.text === 'string' && output.char_count === output.text.length && output.output_hash === await sha256Hex(output.text)
);

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
async function pollInternalResult(body: any, approval: any, cause: unknown, dispatchStarted: number): Promise<{ text: string; usage?: any } | null> {
  const internalCallId = body?.internal_call_id;
  if (!body?.internal_pipeline_call || !internalCallId) return null;

  const started = Date.now();
  const stage = body.stage || 'unknown';
  const model = 'governed';
  const recoveryErrorCode = cause instanceof DOMException && cause.name === 'AbortError'
    ? 'request_timeout'
    : 'model_request_failed';
  let firstMissingAt: number | null = null;
  const recoveryDeadline = Math.max(
    dispatchStarted + GATEWAY_DEADLINE_MS + RECOVERY_PROPAGATION_MS,
    started + RECOVERY_PROPAGATION_MS
  );
  while (Date.now() < recoveryDeadline) {
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
        await serverLog(body.run_id, 'info', 'internal_result_recovered', {
          stage,
          model,
          internal_call_id: internalCallId,
          duration_ms: Date.now() - started,
          response_chars: typeof data.text === 'string' ? data.text.length : 0,
        });
        const output = data.output;
        if (!await validOutput(output, body, approval)) return null;
        return { text: output.text, usage: data.usage };
      }
      if (data?.status === 'error') {
        const errorCode = typeof data.message === 'string' && INTERNAL_ERROR_CODES.has(data.message)
          ? data.message
          : 'model_request_failed';
        await serverLog(body.run_id, 'error', 'internal_result_error', {
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

  await serverLog(body.run_id, 'warn', 'internal_result_timeout', {
    stage,
    model,
    internal_call_id: internalCallId,
    duration_ms: Date.now() - started,
    error_code: recoveryErrorCode,
  });
  return null;
}

async function postWithTimeout(url: string, body: any, approval: any): Promise<{ text: string; usage?: any }> {
  const dispatchStarted = Date.now();
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
          const output = frame.output;
          if (!await validOutput(output, body, approval)) {
            streamError = 'INVALID_GOVERNED_OUTPUT';
          } else finalText = output.text;
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
    const recovered = await pollInternalResult(body, approval, err, dispatchStarted);
    if (recovered) return recovered;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
  if (profile.provider === 'anthropic' || profile.provider === 'openai') return governedCall(profile, prompt, stage, ctx);
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
  if (prompt.images?.length) throw new Error('IMAGE_PAYLOAD_DISABLED: external image processing is disabled until local OCR/redaction exists');
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
