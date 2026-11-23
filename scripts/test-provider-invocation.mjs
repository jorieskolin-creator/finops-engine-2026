import assert from 'node:assert/strict';
import http from 'node:http';
import { defaultNodeFetch, invokeProvider } from '../lib/providerInvocation.js';
import { OUTPUT_CONTRACT_IDS } from '../lib/outputContracts.js';

const packet = {
  provider: 'xai',
  model: 'grok-4.6',
  system_instruction: 'Return valid JSON only.',
  parts: [{ type: 'text', text: 'Return {"ok":true}.' }],
  settings: { max_tokens: 16384, reasoning_effort: 'medium' },
};

let request;
const result = await invokeProvider(packet, {
  env: { XAI_API_KEY: 'test-key-not-a-real-secret' },
  fetchFn: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    };
  },
});

assert.equal(request.url, 'https://api.x.ai/v1/chat/completions');
assert.equal(request.options.headers.Authorization, 'Bearer test-key-not-a-real-secret');
assert.equal(request.body.model, 'grok-4.6');
assert.equal(request.body.max_completion_tokens, 16384);
assert.equal(request.body.reasoning_effort, 'medium');
assert.deepEqual(request.body.response_format, { type: 'json_object' });
assert.match(request.body.messages.map(message => message.content).join('\n'), /JSON/i);
assert.equal(result.text, '{"ok":true}');
assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4, reasoning_tokens: 0 });

await assert.rejects(
  invokeProvider(packet, { env: {}, fetchFn: async () => { throw new Error('must not dispatch'); } }),
  /PROVIDER_NOT_CONFIGURED/,
);

await assert.rejects(
  invokeProvider({ ...packet, provider: 'openai', model: 'gpt-5.6-sol' }, {
    env: { OPENAI_API_KEY: 'test-key' },
    fetchFn: async () => ({
      ok: false,
      status: 400,
      headers: { get: name => name === 'x-request-id' ? 'req_safe-123' : null },
      json: async () => ({
        error: {
          code: 'unsupported_parameter',
          message: 'raw provider response must never propagate',
        },
      }),
    }),
  }),
  error => error?.code === 'UPSTREAM_HTTP_ERROR'
    && error?.providerHttpStatus === 400
    && error?.providerErrorCode === 'unsupported_parameter'
    && error?.providerRequestId === 'req_safe-123'
    && !String(error?.message).includes('raw provider response'),
);

await assert.rejects(
  invokeProvider(packet, {
    env: { XAI_API_KEY: 'test-key' },
    fetchFn: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => 'invalid request id with spaces and source text' },
      json: async () => ({ error: { code: 'invalid code with spaces', message: 'private response content' } }),
    }),
  }),
  error => error?.code === 'UPSTREAM_HTTP_ERROR'
    && error?.providerHttpStatus === 429
    && error?.providerErrorCode === undefined
    && error?.providerRequestId === undefined,
);

await assert.rejects(
  invokeProvider(packet, {
    env: { XAI_API_KEY: 'test-key' },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"ok"' } }] }),
    }),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'MAX_OUTPUT_TOKENS',
);

await assert.rejects(
  invokeProvider(packet, {
    env: { XAI_API_KEY: 'test-key' },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'cannot comply' } }] }),
    }),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'PROVIDER_REFUSAL',
);

await assert.rejects(
  invokeProvider({ ...packet, provider: 'anthropic', model: 'claude-sonnet-5', settings: { max_tokens: 16384 } }, {
    env: { ANTHROPIC_API_KEY: 'test-key' },
    fetchFn: async () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [] }) }),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'MAX_OUTPUT_TOKENS',
);

await assert.rejects(
  invokeProvider({ ...packet, provider: 'anthropic', model: 'claude-sonnet-5', settings: { max_tokens: 16384 } }, {
    env: { ANTHROPIC_API_KEY: 'test-key' },
    fetchFn: async () => ({ ok: true, json: async () => ({ stop_reason: 'model_context_window_exceeded', content: [] }) }),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'CONTEXT_WINDOW_EXCEEDED',
);

for (const [provider, model, settings] of [
  ['openai', 'gpt-6.2-sol', { max_tokens: 32768, reasoning_effort: 'high' }],
  ['openai', 'gpt-6.1-terra', { max_tokens: 16384, reasoning_effort: 'medium' }],
  ['anthropic', 'claude-sonnet-5-5', { max_tokens: 32768 }],
  ['xai', 'grok-4.7', { max_tokens: 16384, reasoning_effort: 'medium' }],
]) {
  let structuredRequest;
  const structuredPacket = {
    ...packet,
    stage: 'synthesis',
    provider,
    model,
    output_contract: OUTPUT_CONTRACT_IDS.evidenceSynthesis,
    settings,
  };
  const responseText = '{"phase_3_strategy":{}}';
  const structuredResult = await invokeProvider(structuredPacket, {
    env: provider === 'openai'
      ? { OPENAI_API_KEY: 'test-key' }
      : provider === 'xai'
        ? { XAI_API_KEY: 'test-key' }
        : { ANTHROPIC_API_KEY: 'test-key' },
    fetchFn: async (_url, options) => {
      structuredRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => provider === 'openai'
          ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: responseText }] }] }
          : provider === 'xai'
            ? { choices: [{ finish_reason: 'stop', message: { content: responseText } }] }
            : { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: responseText }] },
      };
    },
  });
  assert.equal(structuredResult.text, responseText);
  assert.equal(structuredRequest.model, model);
  if (provider === 'openai') {
    assert.equal(structuredRequest.max_output_tokens, settings.max_tokens);
    assert.deepEqual(structuredRequest.reasoning, { effort: settings.reasoning_effort });
  } else if (provider === 'xai') {
    assert.equal(structuredRequest.max_completion_tokens, settings.max_tokens);
    assert.equal(structuredRequest.reasoning_effort, settings.reasoning_effort);
  } else {
    assert.equal(structuredRequest.max_tokens, settings.max_tokens);
    assert.equal(structuredRequest.thinking, undefined, 'Sonnet 5.5 uses the Claude API adaptive thinking default');
  }
  const format = provider === 'openai'
    ? structuredRequest.text.format
    : provider === 'xai'
      ? structuredRequest.response_format
      : structuredRequest.output_config.format;
  const schema = provider === 'xai' ? format.json_schema.schema : format.schema;
  assert.equal(format.type, 'json_schema');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['phase_3_strategy']);
  if (provider === 'openai' || provider === 'xai') {
    const namedFormat = provider === 'xai' ? format.json_schema : format;
    assert.equal(namedFormat.name, OUTPUT_CONTRACT_IDS.evidenceSynthesis);
    assert.equal(namedFormat.strict, true);
  }
}

let anthropicFindingsRequest;
await invokeProvider({
  ...packet,
  stage: 'synthesis',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  output_contract: OUTPUT_CONTRACT_IDS.findingsSynthesis,
  settings: { max_tokens: 8192 },
}, {
  env: { ANTHROPIC_API_KEY: 'test-key' },
  fetchFn: async (_url, options) => {
    anthropicFindingsRequest = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }),
    };
  },
});
const anthropicSchemaText = JSON.stringify(anthropicFindingsRequest.output_config.format.schema);
assert.doesNotMatch(anthropicSchemaText, /"(?:minimum|maximum|maxItems|minLength|maxLength)"/);
assert.doesNotMatch(anthropicSchemaText, /"minItems"/);

// SSE streaming tests for all three providers (prevents 300s undici headersTimeout)
const sseStreamResponse = chunks => ({
  ok: true,
  status: 200,
  headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
  body: (async function* () {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  })(),
});

{
  let xaiStreamReq;
  const xaiStreamed = await invokeProvider({ ...packet, model: 'grok-4.7' }, {
    env: { XAI_API_KEY: 'test-xai-key' },
    fetchFn: async (_url, options) => {
      xaiStreamReq = JSON.parse(options.body);
      return sseStreamResponse([
        ': keepalive\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"completion_tokens_details":{"reasoning_tokens":500}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });
  assert.equal(xaiStreamReq.stream, true);
  assert.deepEqual(xaiStreamReq.stream_options, { include_usage: true });
  assert.equal(xaiStreamed.text, '{"ok":true}');
  assert.deepEqual(xaiStreamed.usage, { input_tokens: 100, output_tokens: 20, reasoning_tokens: 500 });
}

await assert.rejects(
  invokeProvider({ ...packet, model: 'grok-4.7' }, {
    env: { XAI_API_KEY: 'test-xai-key' },
    fetchFn: async () => sseStreamResponse([
      'data: {"choices":[{"delta":{"content":"{\\"ok\\""},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'MAX_OUTPUT_TOKENS',
);

await assert.rejects(
  invokeProvider({ ...packet, model: 'grok-4.7' }, {
    env: { XAI_API_KEY: 'test-xai-key' },
    fetchFn: async () => sseStreamResponse([
      'data: {"choices":[{"delta":{"content":"{\\"partial\\":true"}}]}\n\n',
    ]),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'PROVIDER_INCOMPLETE',
);

{
  let openaiStreamReq;
  const openaiStreamed = await invokeProvider({ ...packet, provider: 'openai', model: 'gpt-6.1-terra' }, {
    env: { OPENAI_API_KEY: 'test-openai-key' },
    fetchFn: async (_url, options) => {
      openaiStreamReq = JSON.parse(options.body);
      return sseStreamResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"status\\":"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"\\"ok\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":50,"output_tokens":10,"output_tokens_details":{"reasoning_tokens":200}}}}\n\n',
      ]);
    },
  });
  assert.equal(openaiStreamReq.stream, true);
  assert.equal(openaiStreamed.text, '{"status":"ok"}');
  assert.deepEqual(openaiStreamed.usage, { input_tokens: 50, output_tokens: 10, reasoning_tokens: 200 });
}

{
  let anthropicStreamReq;
  const anthropicStreamed = await invokeProvider({
    ...packet,
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    settings: { max_tokens: 16384 },
  }, {
    env: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    fetchFn: async (_url, options) => {
      anthropicStreamReq = JSON.parse(options.body);
      return sseStreamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":80}}}\n\n',
        'event: ping\ndata: {"type":"ping"}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"ok\\":true}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    },
  });
  assert.equal(anthropicStreamReq.stream, true);
  assert.equal(anthropicStreamed.text, '{"ok":true}');
  assert.deepEqual(anthropicStreamed.usage, { input_tokens: 80, output_tokens: 15 });
}

// Exercise defaultNodeFetch against a real local HTTP SSE stream (split chunks + timeout abort)
{
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return; // intentionally never ends to test AbortError on timeout
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"choices":[{"delta":{"content":"{\\"streamed\\":"}}]}\n');
    setTimeout(() => {
      res.write('\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      res.end();
    }, 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const streamedOverTcp = await invokeProvider({ ...packet, model: 'grok-4.7' }, {
      env: { XAI_API_KEY: 'test-xai-key' },
      fetchFn: (_url, opts) => defaultNodeFetch(`http://127.0.0.1:${port}/sse`, opts),
      timeoutMs: 5000,
    });
    assert.equal(streamedOverTcp.text, '{"streamed":true}');

    await assert.rejects(
      invokeProvider({ ...packet, model: 'grok-4.7' }, {
        env: { XAI_API_KEY: 'test-xai-key' },
        fetchFn: (_url, opts) => defaultNodeFetch(`http://127.0.0.1:${port}/slow`, opts),
        timeoutMs: 80,
      }),
      error => error?.name === 'AbortError',
      'exceeding timeoutMs on defaultNodeFetch must reject with AbortError (mapped to OUTCOME_UNKNOWN)',
    );
  } finally {
    server.close();
  }
}

console.log('provider invocation behavioral tests passed');
