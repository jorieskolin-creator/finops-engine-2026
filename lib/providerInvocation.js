import http from 'node:http';
import https from 'node:https';
import { GovernanceError } from './governance.js';
import { structuredOutputForPacket } from './outputContracts.js';
import { providerCapabilities } from './providerCapabilities.js';

const compatibleUsage = usage => usage ? {
  input_tokens: usage.prompt_tokens ?? usage.input_tokens,
  output_tokens: usage.completion_tokens ?? usage.output_tokens,
  reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
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

const abortError = () => Object.assign(new Error('Provider request aborted'), { name: 'AbortError' });

// Node.js built-in fetch (undici) enforces a hardcoded 300,000 ms headersTimeout
// and bodyTimeout. Using node:http/node:https as the default transport honors
// the full timeoutMs (540,000 ms) without adding an external dependency.
export const defaultNodeFetch = (url, { method = 'POST', headers = {}, body, signal, timeoutMs = 540_000 } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : '';
  const req = transport.request(target, {
    method,
    headers: {
      ...headers,
      ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    },
  }, res => {
    const status = res.statusCode || 0;
    const rawHeaders = res.headers || {};
    const getHeader = name => {
      const value = rawHeaders[String(name || '').toLowerCase()];
      return Array.isArray(value) ? value[value.length - 1] : (value ?? null);
    };
    const readAllText = () => new Promise((resText, rejText) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resText(Buffer.concat(chunks).toString('utf8')));
      res.on('error', rejText);
    });
    const onAbort = () => res.destroy(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    res.once('close', () => signal?.removeEventListener('abort', onAbort));
    resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: getHeader },
      body: res,
      text: readAllText,
      json: async () => JSON.parse(await readAllText()),
    });
  });

  const onAbort = () => req.destroy(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  req.setTimeout(timeoutMs, () => req.destroy(abortError()));
  req.on('error', err => {
    signal?.removeEventListener('abort', onAbort);
    reject(signal?.aborted ? abortError() : err);
  });
  req.once('close', () => signal?.removeEventListener('abort', onAbort));
  if (payload) req.write(payload);
  req.end();
});

async function* iterateSseEvents(body) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const emitFromBuffer = () => {
    const events = [];
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const rawBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = [];
      let eventType = '';
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) events.push({ eventType, data: dataLines.join('\n') });
    }
    return events;
  };

  const pushChunk = chunk => {
    const decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer += decoded.replace(/\r\n/g, '\n');
  };

  if (typeof body?.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pushChunk(value);
        for (const event of emitFromBuffer()) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      pushChunk(chunk);
      for (const event of emitFromBuffer()) yield event;
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) {
    buffer += '\n\n';
    for (const event of emitFromBuffer()) yield event;
  }
}

const extractOpenAiText = payload => (
  payload?.output_text
  || (payload?.output || []).flatMap(x => x.content || []).map(x => x.text || x.output_text || '').join('')
);

async function consumeProviderStream(provider, body) {
  if (provider === 'xai') {
    let text = '';
    let usage = null;
    let finishReason = null;
    let refusal = false;
    let sawDone = false;
    for await (const { data } of iterateSseEvents(body)) {
      if (data === '[DONE]') {
        sawDone = true;
        break;
      }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk?.error) {
        throw new GovernanceError('UPSTREAM_HTTP_ERROR', 502, undefined, {
          providerErrorCode: safeDiagnosticString(chunk.error?.code || chunk.error?.type),
        });
      }
      if (chunk?.usage) usage = compatibleUsage(chunk.usage);
      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.refusal) refusal = true;
      if (typeof choice.delta?.content === 'string') text += choice.delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (finishReason === 'length') throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'MAX_OUTPUT_TOKENS');
    if (refusal) throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'PROVIDER_REFUSAL');
    if (!sawDone && !finishReason) throw new GovernanceError('INCOMPLETE_RESPONSE', 502, 'PROVIDER_INCOMPLETE');
    if (!text.trim()) throw new GovernanceError('INCOMPLETE_RESPONSE', 502, 'EMPTY_MODEL_OUTPUT');
    return { text, usage };
  }

  if (provider === 'openai') {
    let text = '';
    let completed = null;
    let incomplete = null;
    for await (const { eventType, data } of iterateSseEvents(body)) {
      if (data === '[DONE]') break;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      const type = event?.type || eventType;
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
      } else if (type === 'response.completed') {
        completed = event.response || event;
      } else if (type === 'response.incomplete') {
        incomplete = event.response || event;
      } else if (type === 'response.failed' || type === 'error') {
        throw new GovernanceError('UPSTREAM_HTTP_ERROR', 502, undefined, {
          providerErrorCode: safeDiagnosticString(event.response?.error?.code || event.error?.code || event.code),
        });
      }
    }
    const terminal = incomplete || completed;
    if (incomplete || terminal?.status === 'incomplete' || terminal?.incomplete_details) {
      const reason = terminal?.incomplete_details?.reason === 'max_output_tokens'
        ? 'MAX_OUTPUT_TOKENS'
        : 'PROVIDER_INCOMPLETE';
      throw new GovernanceError('INCOMPLETE_RESPONSE', 400, reason);
    }
    if (!completed) throw new GovernanceError('INCOMPLETE_RESPONSE', 502, 'PROVIDER_INCOMPLETE');
    return {
      text: text || extractOpenAiText(completed),
      usage: compatibleUsage(completed.usage),
    };
  }

  let text = '';
  let inputTokens;
  let outputTokens;
  let stopReason = null;
  let sawStop = false;
  for await (const { eventType, data } of iterateSseEvents(body)) {
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    const type = event?.type || eventType;
    if (type === 'message_start') {
      if (Number.isSafeInteger(event.message?.usage?.input_tokens)) inputTokens = event.message.usage.input_tokens;
    } else if (type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      text += event.delta.text;
    } else if (type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (Number.isSafeInteger(event.usage?.output_tokens)) outputTokens = event.usage.output_tokens;
    } else if (type === 'message_stop') {
      sawStop = true;
    } else if (type === 'error') {
      throw new GovernanceError('UPSTREAM_HTTP_ERROR', 502, undefined, {
        providerErrorCode: safeDiagnosticString(event.error?.type || event.error?.code),
      });
    }
  }
  if (stopReason === 'max_tokens') throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'MAX_OUTPUT_TOKENS');
  if (stopReason === 'model_context_window_exceeded') throw new GovernanceError('INCOMPLETE_RESPONSE', 400, 'CONTEXT_WINDOW_EXCEEDED');
  if (!sawStop) throw new GovernanceError('INCOMPLETE_RESPONSE', 502, 'PROVIDER_INCOMPLETE');
  const usage = inputTokens !== undefined || outputTokens !== undefined
    ? { input_tokens: inputTokens, output_tokens: outputTokens }
    : null;
  return { text, usage };
}

export async function invokeProvider(packet, { fetchFn, env = process.env, timeoutMs = 540_000, signal } = {}) {
  const transportFetch = fetchFn || defaultNodeFetch;
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
      headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: `Bearer ${key}` };
      body = {
        model: packet.model,
        input: [{ role: 'user', content: packet.parts.map(p => ({ type: 'input_text', text: p.text })) }],
        instructions: packet.system_instruction,
        max_output_tokens: packet.settings.max_tokens,
        stream: true,
        ...(packet.settings.reasoning_effort ? { reasoning: { effort: packet.settings.reasoning_effort } } : {}),
        ...(structuredOutput ? { text: { format: { type: 'json_schema', name: structuredOutput.name, strict: true, schema: structuredOutput.schema } } } : {}),
      };
    } else if (packet.provider === 'xai') {
      const key = env.XAI_API_KEY;
      if (!key) throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
      url = 'https://api.x.ai/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: `Bearer ${key}` };
      body = {
        model: packet.model,
        messages: [
          ...(packet.system_instruction ? [{ role: 'system', content: packet.system_instruction }] : []),
          { role: 'user', content: packet.parts.map(p => p.text).join('\n') },
        ],
        max_completion_tokens: packet.settings.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
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
      headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = {
        model: packet.model,
        max_tokens: packet.settings.max_tokens,
        system: packet.system_instruction,
        messages: [{ role: 'user', content: packet.parts }],
        stream: true,
        ...(structuredOutput ? { output_config: { format: { type: 'json_schema', schema: structuredOutput.schema } } } : {}),
      };
    } else {
      throw new GovernanceError('PROVIDER_NOT_CONFIGURED');
    }

    const response = await transportFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      timeoutMs,
    });
    if (!response.ok) {
      throw new GovernanceError('UPSTREAM_HTTP_ERROR', 502, undefined, {
        providerHttpStatus: response.status,
        providerErrorCode: await providerErrorCode(response),
        providerRequestId: providerRequestId(response),
      });
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream') && response.body) {
      return await consumeProviderStream(packet.provider, response.body);
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
        text: extractOpenAiText(payload),
        usage: compatibleUsage(payload.usage),
      };
    }
    if (packet.provider === 'xai') {
      const content = payload.choices?.[0]?.message?.content || '';
      if (!content.trim()) throw new GovernanceError('INCOMPLETE_RESPONSE', 502, 'EMPTY_MODEL_OUTPUT');
      return {
        text: content,
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
