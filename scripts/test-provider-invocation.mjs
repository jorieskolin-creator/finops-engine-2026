import assert from 'node:assert/strict';
import { invokeProvider } from '../lib/providerInvocation.js';
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

for (const provider of ['openai', 'anthropic', 'xai']) {
  let structuredRequest;
  const structuredPacket = {
    ...packet,
    stage: 'synthesis',
    provider,
    model: provider === 'openai' ? 'gpt-5.6-sol' : provider === 'xai' ? 'grok-4.6' : 'claude-sonnet-5',
    output_contract: OUTPUT_CONTRACT_IDS.evidenceSynthesis,
    settings: { max_tokens: 8192 },
  };
  await invokeProvider(structuredPacket, {
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
          ? { status: 'completed', output_text: '{"phase_3_strategy":{}}' }
          : provider === 'xai'
            ? { choices: [{ finish_reason: 'stop', message: { content: '{"phase_3_strategy":{}}' } }] }
            : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"phase_3_strategy":{}}' }] },
      };
    },
  });
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

console.log('provider invocation behavioral tests passed');
