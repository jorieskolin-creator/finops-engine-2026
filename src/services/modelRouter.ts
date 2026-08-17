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
import { AiRole, ModelProfile, ModelRoutingConfig, Provider, StageId } from '../models';
import { estimateTokens, hashString, recordStageTrace } from './runTraceService';
// @ts-expect-error Pure JS policy is also consumed by the serverless API.
import { filterOperationalMetadata } from '../../lib/operationalLogPolicy.js';

export interface NormalizedPrompt {
  userText: string;
  systemInstruction?: string;
  images?: ImageInput[];
  outputContract?: string;
  /** Provider-neutral semantic validation applied before an attempt succeeds. */
  validateOutput?: (text: string) => void;
}

export interface RunContext {
  runId: string;
  stageExecutionId?: string;
}

const REQUEST_TIMEOUT_MS = 595_000;
const GATEWAY_DEADLINE_MS = 540_000;
// The browser deadline starts at dispatch, while the provider deadline starts
// only when a worker claims the attempt. Recovery must cover that queue offset.
const RECOVERY_PROPAGATION_MS = 120_000;
const INTERNAL_RESULT_POLL_INTERVAL_MS = 2_000;
const INTERNAL_RESULT_MISSING_GRACE_MS = 10_000;
export class StageExecutionError extends Error { constructor(public code:string,public fallbackAllowed=false){super(code);} }

const STAGES: StageId[] = ['forensic_audit','targeted_rescan','evidence_check','evidence_adjudication','synthesis','roadmap_synthesis','synthesis_escalation','fact_check','fact_check_high','quality_gate'];
const ROLES = new Set<AiRole>(['REASONER', 'WORKHORSE', 'QUALITY_CHECKER']);
const PROVIDERS = new Set<Provider>(['anthropic', 'openai', 'xai']);
const ROLE_INSTRUCTIONS: Record<AiRole, string> = {
  WORKHORSE: 'AI ROLE: WORKHORSE. Perform only the bounded semantic task supplied. Use only the supplied evidence and reference universe, make no unsupported inference, and follow the exact output contract. Do not derive values that the prompt identifies as deterministic.',
  REASONER: 'AI ROLE: REASONER. Resolve only the supplied ambiguity or multi-factor decision. Weigh the competing supplied evidence and knowledge constraints, respect prohibited inferences, evaluate supplied decision alternatives when present, and provide a source-grounded rationale. Do not invent evidence or deterministic state.',
  QUALITY_CHECKER: 'AI ROLE: QUALITY_CHECKER. Independently verify the generated result; do not assume it is correct. Evaluate it only against the supplied authoritative evidence, knowledge rules, and approved reference data. Identify defects only when supported by that material. Do not invent missing evidence or requirements, and do not rewrite the assessment unless explicitly requested.',
};
let routingConfigPromise: Promise<ModelRoutingConfig> | undefined;

const validProfile = (value: any): value is ModelProfile => Boolean(
  value && typeof value === 'object' && !Array.isArray(value)
  && typeof value.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
  && PROVIDERS.has(value.provider)
  && (value.maxTokens === undefined || (Number.isInteger(value.maxTokens) && value.maxTokens > 0))
  && (value.reasoningEffort === undefined || ['none','low','medium','high','xhigh'].includes(value.reasoningEffort))
);

const validRoutingConfig = (value: any): value is ModelRoutingConfig => Boolean(
  value && value.schema_version === 'model_routing_config_v2'
  && typeof value.policy_version === 'string'
  && value.mode === 'role_policy'
  && typeof value.label === 'string' && /^[a-z_]{1,64}$/.test(value.label)
  && STAGES.every(stage => ROLES.has(value.stage_roles?.[stage]))
  && [...ROLES].every(role => value.roles?.[role]?.role === role
    && Array.isArray(value.roles[role].profiles)
    && value.roles[role].profiles.length === 2
    && value.roles[role].profiles.every(validProfile)
    && value.roles[role].primary_provider === value.roles[role].profiles[0].provider.toUpperCase()
    && value.roles[role].fallback_provider === value.roles[role].profiles[1].provider.toUpperCase())
  && STAGES.every(stage => Array.isArray(value.routes?.[stage])
    && value.routes[stage].length === 2
    && value.routes[stage].every(validProfile)
    && value.routes[stage].every((profile: ModelProfile, index: number) => {
      const roleProfile = value.roles[value.stage_roles[stage]].profiles[index];
      return profile.id === roleProfile.id && profile.provider === roleProfile.provider;
    }))
);

export function getModelRoutingConfig(): Promise<ModelRoutingConfig> {
  if (!routingConfigPromise) {
    const request = fetch('/api/model-routing', { method: 'GET' }).then(async response => {
      if (!response.ok) throw new Error(`MODEL_ROUTING_UNAVAILABLE HTTP ${response.status}`);
      const config = await response.json();
      if (!validRoutingConfig(config)) throw new Error('MODEL_ROUTING_CONFIGURATION_INVALID');
      return config;
    });
    routingConfigPromise = request.catch(error => {
      routingConfigPromise = undefined;
      throw error;
    });
  }
  return routingConfigPromise;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const newInternalCallId = (): string => {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  throw new StageExecutionError('SECURE_RANDOM_UNAVAILABLE');
};

const REQUEST_SCHEMA = 'stage_packet_request_v1';
const APPROVED_SCHEMA = 'approved_stage_packet_v1';
const OUTPUT_SCHEMA = 'governed_output_v1';
const POLICY = 'llm_egress_policy_v1';
async function governedCall(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
  if (prompt.images?.length) throw new Error('IMAGE_PAYLOAD_DISABLED: external image processing is disabled until local OCR/redaction exists');
  const settings: any = {};
  if (profile.maxTokens !== undefined) settings.max_tokens = profile.maxTokens;
  if (profile.reasoningEffort) settings.reasoning_effort = profile.reasoningEffort;
  const approval = await fetch('/api/governed-packet', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ schema_version:REQUEST_SCHEMA, policy_version:POLICY, run_id:ctx.runId, stage, ...(ctx.stageExecutionId ? { stage_execution_id: ctx.stageExecutionId } : {}), provider:profile.provider, model:profile.id, destination:`${profile.provider}:external_model`, system_instruction:prompt.systemInstruction || '', parts:[{type:'text',text:prompt.userText}], settings, ...(prompt.outputContract ? { output_contract: prompt.outputContract } : {}) }) });
  if (!approval.ok) {
    const failure = await approval.json().catch(() => null);
    throw new StageExecutionError(typeof failure?.error === 'string' ? failure.error : 'STAGE_PACKET_REJECTED');
  }
  const packet = await approval.json();
  if (packet.classification_method !== 'deterministic_pattern_screen_v1' || packet.approval_basis !== 'policy_approved_after_pattern_screening' || packet.run_id !== ctx.runId || packet.stage !== stage || packet.provider !== profile.provider || packet.model !== profile.id || packet.output_contract !== prompt.outputContract) throw new StageExecutionError('INVALID_PACKET_APPROVAL');
  const body = { packet_id:packet.packet_id, packet_hash:packet.packet_hash, schema_version:APPROVED_SCHEMA, policy_version:POLICY, run_id:ctx.runId, stage, internal_pipeline_call:true, internal_call_id:newInternalCallId(), ...(ctx.stageExecutionId ? { stage_execution_id: ctx.stageExecutionId } : {}) };
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

// Reads the NDJSON stream emitted by the provider generate endpoints.
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
interface InternalResultRecoveryOptions {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
  logFn?: typeof serverLog;
  gatewayDeadlineMs?: number;
  recoveryPropagationMs?: number;
  pollIntervalMs?: number;
  missingGraceMs?: number;
}

export async function pollInternalResult(body: any, approval: any, cause: unknown, dispatchStarted: number, options: InternalResultRecoveryOptions = {}): Promise<{ text: string; usage?: any } | null> {
  const internalCallId = body?.internal_call_id;
  if (!body?.internal_pipeline_call || !internalCallId) return null;

  const fetchFn = options.fetchFn || fetch;
  const sleepFn = options.sleepFn || sleep;
  const now = options.now || Date.now;
  const logFn = options.logFn || serverLog;
  const gatewayDeadlineMs = options.gatewayDeadlineMs ?? GATEWAY_DEADLINE_MS;
  const recoveryPropagationMs = options.recoveryPropagationMs ?? RECOVERY_PROPAGATION_MS;
  const pollIntervalMs = options.pollIntervalMs ?? INTERNAL_RESULT_POLL_INTERVAL_MS;
  const missingGraceMs = options.missingGraceMs ?? INTERNAL_RESULT_MISSING_GRACE_MS;
  const started = now();
  const stage = body.stage || 'unknown';
  const model = 'governed';
  const recoveryErrorCode = cause instanceof DOMException && cause.name === 'AbortError'
    ? 'request_timeout'
    : 'model_request_failed';
  let firstMissingAt: number | null = null;
  let lastAttemptStatus = 'unknown';
  const recoveryDeadline = Math.max(
    dispatchStarted + gatewayDeadlineMs + recoveryPropagationMs,
    started + recoveryPropagationMs
  );
  while (now() < recoveryDeadline) {
    try {
      const res = await fetchFn('/api/model-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ internalCallId }),
      });
      if (res.status === 404) {
        if (firstMissingAt === null) firstMissingAt = now();
        if (now() - firstMissingAt > missingGraceMs) {
          throw new StageExecutionError('NO_ATTEMPT_RESERVED', true);
        }
        await sleepFn(pollIntervalMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(`/api/model-result → ${res.status}`);
      }
      const data = await res.json();
      if (['queued','running','done','fallback_allowed','outcome_unknown','cancelled','expired','result_unavailable'].includes(data?.status)) {
        lastAttemptStatus = data.status;
      }
      if (data?.status === 'queued' || data?.status === 'running') {
        await sleepFn(pollIntervalMs);
        continue;
      }
      if (data?.status === 'done') {
        await logFn(body.run_id, 'info', 'internal_result_recovered', {
          stage,
          model,
          internal_call_id: internalCallId,
          duration_ms: now() - started,
          response_chars: typeof data.text === 'string' ? data.text.length : 0,
        });
        const output = data.output;
        if (!await validOutput(output, body, approval)) return null;
        return { text: output.text, usage: data.usage };
      }
      if (data?.status === 'fallback_allowed') throw new StageExecutionError(typeof data.outcome_code === 'string' ? data.outcome_code : 'FALLBACK_ALLOWED',true);
      if (data?.status === 'cancelled') throw new StageExecutionError(typeof data.outcome_code === 'string' ? data.outcome_code : 'CANCELLED');
      if (['outcome_unknown','expired','result_unavailable'].includes(data?.status)) throw new StageExecutionError(String(data.status).toUpperCase());
    } catch (err: any) {
      if (err instanceof StageExecutionError) throw err;
      await sleepFn(pollIntervalMs);
    }
  }

  await logFn(body.run_id, 'warn', 'internal_result_timeout', {
    stage,
    model,
    internal_call_id: internalCallId,
    duration_ms: now() - started,
    error_code: recoveryErrorCode,
    attempt_status: lastAttemptStatus,
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
      await serverLog(body.run_id, 'warn', 'internal_result_error', {
        stage: body.stage || 'unknown',
        model: approval.model || 'governed',
        internal_call_id: body.internal_call_id,
        error_code: res.status === 404 ? 'packet_unavailable' : 'gateway_http_error',
        http_status: res.status,
      });
      // Both provider-gateway 404 paths occur before an attempt is reserved
      // and before the external-send fence. A different model can therefore
      // be tried without risking duplicate provider execution.
      if (res.status === 404) throw new StageExecutionError('FALLBACK_ALLOWED', true);
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

    if (streamError) throw new StageExecutionError(streamError,['FALLBACK_ALLOWED','INVALID_OUTPUT_CONTRACT','UPSTREAM_HTTP_ERROR','INCOMPLETE_RESPONSE','OUTPUT_INSPECTION_REJECTED','PROVIDER_NOT_CONFIGURED'].includes(streamError));
    if (finalText === null) {
      throw new Error(`${url} → stream ended without 'done' frame`);
    }
    return { text: finalText, usage: finalUsage };
  } catch (err) {
    if (err instanceof StageExecutionError && err.fallbackAllowed) throw err;
    const recovered = await pollInternalResult(body, approval, err, dispatchStarted);
    if (recovered) return recovered;
    if(err instanceof StageExecutionError)throw err;
    throw new StageExecutionError('DEPENDENCY_UNCERTAINTY');
  } finally {
    clearTimeout(timer);
  }
}

export async function callModel(profile: ModelProfile, prompt: NormalizedPrompt, stage: StageId, ctx: RunContext): Promise<{ text: string; usage?: any }> {
  if (profile.provider === 'anthropic' || profile.provider === 'openai' || profile.provider === 'xai') return governedCall(profile, prompt, stage, ctx);
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
  const routing = await getModelRoutingConfig();
  const role = routing.stage_roles[stage];
  const chain = routing.routes[stage];
  const rolePrompt: NormalizedPrompt = {
    ...prompt,
    systemInstruction: [ROLE_INSTRUCTIONS[role], prompt.systemInstruction].filter(Boolean).join('\n\n'),
  };
  const failures: Array<{ profile: ModelProfile; error: string }> = [];
  const stageStarted = Date.now();
  const startedAt = new Date(stageStarted).toISOString();
  const inputChars = (rolePrompt.systemInstruction || '').length + rolePrompt.userText.length;
  const promptHash = hashString(`${stage}\n${role}\n${rolePrompt.outputContract || 'unstructured'}\n${rolePrompt.systemInstruction || ''}\n${rolePrompt.userText}`);
  const contextPacketHash = hashString(rolePrompt.userText);
  const fallbackChain = chain.map(profile => profile.id);
  const executionContext = { ...ctx, stageExecutionId: newInternalCallId() };
  for (const profile of chain) {
    try {
      const result = await callModel(profile, rolePrompt, stage, executionContext);
      if (rolePrompt.validateOutput) {
        try {
          rolePrompt.validateOutput(result.text);
        } catch (validationError: any) {
          // The provider completed, so trying the fallback cannot duplicate an
          // uncertain dispatch. Both attempts use this same validation contract.
          const code = typeof validationError?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(validationError.code)
            ? validationError.code
            : 'INVALID_SEMANTIC_OUTPUT';
          throw new StageExecutionError(code, true);
        }
      }
      const providerUsage = tokenUsageFromProvider(result.usage);
      recordStageTrace(ctx.runId, {
        stage_id: stage,
        ai_role: role,
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
          ai_role: role,
          succeeded_with: profile.id,
          provider: profile.provider,
          failed_models: failures.map((f) => f.profile.id).join(','),
        });
      }
      return { text: result.text, modelUsed: profile, attempts: failures };
    } catch (err: any) {
      if(err instanceof StageExecutionError&&!err.fallbackAllowed)throw err;
      const errorCode = err instanceof DOMException && err.name === 'AbortError'
        ? 'request_timeout'
        : err instanceof StageExecutionError ? err.code.toLowerCase() : 'model_request_failed';
      console.warn(`[modelRouter] stage=${stage} provider=${profile.provider} id=${profile.id} error_code=${errorCode}`);
      failures.push({ profile, error: errorCode });
    }
  }
  const summary = failures.map((f) => `${f.profile.id}: ${f.error}`).join(' | ');
  recordStageTrace(ctx.runId, {
    stage_id: stage,
    ai_role: role,
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
  if (rolePrompt.outputContract && failures.some(f => f.error === 'invalid_output_contract')) {
    throw new StageExecutionError('SYNTHESIS_OUTPUT_INVALID');
  }
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
