import assert from 'node:assert/strict';
import { invokeProvider } from '../lib/providerInvocation.js';

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
  /INCOMPLETE_RESPONSE/,
);

console.log('provider invocation behavioral tests passed');
