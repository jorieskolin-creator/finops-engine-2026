import { GovernanceError } from './governance.js';
import { structuredOutputForPacket } from './outputContracts.js';
import { providerCapabilities } from './providerCapabilities.js';

const compatibleUsage = usage => usage ? {
  input_tokens: usage.prompt_tokens,
  output_tokens: usage.completion_tokens,
  reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
} : null;

const safeDiagnosticString = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value)
  ? value
  : undefined;

const providerRequestId = response => safeDiagnosticString(
  response?.headers?.get?.('x-request-id')
  || response?.headers?.get?.('request-id')
);

const providerErrorCode = async response => {
  try {
    const payload = await response.json();
    return safeDiagnosticString(payload?.error?.code || payload?.error?.type || payload?.type);
  } catch {
    return undefined;
  }
};

export async function invokeProvider(packet, { fetchFn = fetch, env = process.env, timeoutMs = 540_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    let url;
    let headers;
    let body;
    const structuredOutput = structuredOutputForPacket(packet);
    const capabilities = providerCapabilities(packet.provider);
    if (!capabilities
      || packet.settings.max_tokens > capabilities.max_output_tokens
      || (packet.settings.reasoning_effort && !capabilities.reasoning_effort_support.includes(packet.settings.reasoning_effort))
      || (structuredOutput && !capabilities.supports_strict_schema)
      || (structuredOutput && packet.settings.reasoning_effort && !capabilities.supports_reasoning_with_structured_output)) {
      throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
    }

    if (packet.provider === 'openai') {
      const key = env.GPT_API_KEY || env.OPENAI_API_KEY;
      if (!key) throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
      url = 'https://api.openai.com/v1/responses';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      body = {
        model: packet.model,
        input: [{ role: 'user', content: packet.parts.map(p => ({ type: 'input_text', text: p.text })) }],
        instructions: packet.system_instruction,
        max_output_tokens: packet.settings.max_tokens,
        ...(packet.settings.reasoning_effort ? { reasoning: { effort: packet.settings.reasoning_effort } } : {}),
        ...(structuredOutput ? { text: { format: { type: 'json_schema', name: structuredOutput.name, strict: true, schema: structuredOutput.schema } } } : {}),
      };
    } else if (packet.provider === 'xai') {
      const key = env.XAI_API_KEY;
      if (!key) throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
      url = 'https://api.x.ai/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      body = {
        model: packet.model,
        messages: [
          ...(packet.system_instruction ? [{ role: 'system', content: packet.system_instruction }] : []),
          { role: 'user', content: packet.parts.map(p => p.text).join('\n') },
        ],
        max_completion_tokens: packet.settings.max_tokens,
        ...(packet.settings.reasoning_effort ? { reasoning_effort: packet.settings.reasoning_effort } : {}),
        ...(structuredOutput ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: structuredOutput.name, strict: true, schema: structuredOutput.schema },
          },
        } : { response_format: { type: 'json_object' } }),
      };
    } else if (packet.provider === 'anthropic') {
      const key = env.ANTHROPIC_API_KEY;
      if (!key) throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
      url = 'https://api.anthropic.com/v1/messages';
      headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = {
        model: packet.model,
        max_tokens: packet.settings.max_tokens,
        system: packet.system_instruction,
        messages: [{ role: 'user', content: packet.parts }],
        ...(structuredOutput ? { output_config: { format: { type: 'json_schema', schema: structuredOutput.schema } } } : {}),
      };
    } else {
      throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
    }

    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new GovernanceError('UPSTREAM_HTTP_ERROR', 502, undefined, {
        providerHttpStatus: response.status,
        providerErrorCode: await providerErrorCode(response),
        providerRequestId: providerRequestId(response),
      });
    }
    const payload = await response.json();

    if (packet.provider === 'openai' && (payload.status === 'incomplete' || payload.incomplete_details)) {
      const reason = payload.incomplete_details?.reason === 'max_output_tokens'
        ? 'MAX_OUTPUT_TOKENS'
        : 'PROVIDER_INCOMPLETE';
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, reason);
    }
    if (packet.provider === 'anthropic' && payload.stop_reason === 'max_tokens') {
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'MAX_OUTPUT_TOKENS');
    }
    if (packet.provider === 'anthropic' && payload.stop_reason === 'model_context_window_exceeded') {
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'CONTEXT_WINDOW_EXCEEDED');
    }
    if (packet.provider === 'xai' && payload.choices?.[0]?.finish_reason === 'length') {
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'MAX_OUTPUT_TOKENS');
    }
    if (packet.provider === 'xai' && payload.choices?.[0]?.message?.refusal) {
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'PROVIDER_REFUSAL');
    }

    if (packet.provider === 'openai') {
      return {
        text: payload.output_text || (payload.output || []).flatMap(x => x.content || []).map(x => x.text || x.output_text || '').join(''),
        usage: payload.usage || null,
      };
    }
    if (packet.provider === 'xai') {
      return {
        text: payload.choices?.[0]?.message?.content || '',
        usage: compatibleUsage(payload.usage),
      };
    }
    return {
      text: (payload.content || []).filter(x => x.type === 'text').map(x => x.text).join(''),
      usage: payload.usage || null,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
