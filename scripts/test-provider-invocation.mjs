import assert from 'node:assert/strict';
import { invokeProvider } from '../lib/providerInvocation.js';
import { OUTPUT_CONTRACT_IDS } from '../lib/outputContracts.js';

const packet = {
  provider: 'qwen',
  model: 'qwen3.8-max',
  system_instruction: 'Return valid JSON only.',
  parts: [{ type: 'text', text: 'Return {"ok":true}.' }],
  settings: {},
};

let request;
const result = await invokeProvider(packet, {
  env: { QWEN_API_KEY: 'test-key-not-a-real-secret' },
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

assert.equal(request.url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
assert.equal(request.options.headers.Authorization, 'Bearer test-key-not-a-real-secret');
assert.equal(request.body.model, 'qwen3.8-max');
assert.equal(request.body.enable_thinking, false);
assert.deepEqual(request.body.response_format, { type: 'json_object' });
assert.equal('max_tokens' in request.body, false);
assert.match(request.body.messages.map(message => message.content).join('\n'), /JSON/i);
assert.equal(result.text, '{"ok":true}');
assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4, reasoning_tokens: 0 });

await assert.rejects(
  invokeProvider(packet, { env: {}, fetchFn: async () => { throw new Error('must not dispatch'); } }),
  /PROVIDER_NOT_CONFIGURED/,
);

await assert.rejects(
  invokeProvider(packet, {
    env: { QWEN_API_KEY: 'test-key' },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"ok"' } }] }),
    }),
  }),
  error => error?.code === 'INCOMPLETE_RESPONSE' && error?.terminationReason === 'MAX_OUTPUT_TOKENS',
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

for (const provider of ['openai', 'anthropic']) {
  let structuredRequest;
  const structuredPacket = {
    ...packet,
    stage: 'synthesis',
    provider,
    model: provider === 'openai' ? 'gpt-5.6-sol' : 'claude-sonnet-5',
    output_contract: OUTPUT_CONTRACT_IDS.evidenceSynthesis,
    settings: { max_tokens: 8192 },
  };
  await invokeProvider(structuredPacket, {
    env: provider === 'openai' ? { OPENAI_API_KEY: 'test-key' } : { ANTHROPIC_API_KEY: 'test-key' },
    fetchFn: async (_url, options) => {
      structuredRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => provider === 'openai'
          ? { status: 'completed', output_text: '{"phase_3_strategy":{}}' }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"phase_3_strategy":{}}' }] },
      };
    },
  });
  const format = provider === 'openai'
    ? structuredRequest.text.format
    : structuredRequest.output_config.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required, ['phase_3_strategy']);
  if (provider === 'openai') {
    assert.equal(format.name, OUTPUT_CONTRACT_IDS.evidenceSynthesis);
    assert.equal(format.strict, true);
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
