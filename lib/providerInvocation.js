import { GovernanceError } from './governance.js';
import { structuredOutputForPacket } from './outputContracts.js';

const qwenUsage = usage => usage ? {
  input_tokens: usage.prompt_tokens,
  output_tokens: usage.completion_tokens,
  reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
} : null;

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
    } else if (packet.provider === 'qwen') {
      const key = env.QWEN_API_KEY;
      if (!key) throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
      url = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
      body = {
        model: packet.model,
        messages: [
          ...(packet.system_instruction ? [{ role: 'system', content: packet.system_instruction }] : []),
          { role: 'user', content: packet.parts.map(p => p.text).join('\n') },
        ],
        // Qwen structured output is incompatible with its default thinking
        // mode. JSON is already required explicitly by every stage prompt.
        enable_thinking: false,
        response_format: { type: 'json_object' },
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
        ...(packet.settings.thinking_budget_tokens
          ? { thinking: { type: 'enabled', budget_tokens: packet.settings.thinking_budget_tokens } }
          : {}),
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
    if (!response.ok) throw new GovernanceError('UPSTREAM_HTTP_ERROR');
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
    if (packet.provider === 'qwen' && payload.choices?.[0]?.finish_reason === 'length') {
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'MAX_OUTPUT_TOKENS');
    }

    if (packet.provider === 'openai') {
      return {
        text: payload.output_text || (payload.output || []).flatMap(x => x.content || []).map(x => x.text || x.output_text || '').join(''),
        usage: payload.usage || null,
      };
    }
    if (packet.provider === 'qwen') {
      return {
        text: payload.choices?.[0]?.message?.content || '',
        usage: qwenUsage(payload.usage),
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
