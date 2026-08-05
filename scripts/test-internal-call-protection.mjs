import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const router = await read('../src/services/modelRouter.ts');
const anthropic = await read('../api/anthropic-generate.js');
const openai = await read('../api/openai-generate.js');
const modelResult = await read('../api/model-result.js');
const resultStore = await read('../lib/internalModelResults.js');
const gateway = await read('../lib/providerGateway.js');

assert.match(router, /internal_pipeline_call:true/);
assert.match(router, /internal_call_id/);
assert.match(router, /\/api\/model-result/);
assert.match(router, /internal_result_recovered/);
assert.match(router, /internal_result_timeout/);
assert.match(router, /GATEWAY_DEADLINE_MS = 540_000/);
assert.match(router, /dispatchStarted \+ GATEWAY_DEADLINE_MS \+ RECOVERY_PROPAGATION_MS/);
assert.doesNotMatch(router, /\/api\/generate/);
assert.doesNotMatch(router, /provider === 'gemini'/);

assert.match(anthropic, /providerHandler\('anthropic'\)/);
assert.match(openai, /providerHandler\('openai'\)/);
assert.match(gateway, /registerInternalModelResult/);
assert.match(gateway, /completeInternalModelResult/);
assert.match(gateway, /failInternalModelResult/);
assert.match(gateway, /claimApprovedPacket/);
assert.match(modelResult, /getInternalModelResult/);
assert.match(modelResult, /status: 'pending'/);
assert.match(modelResult, /status: 'done'/);
assert.match(modelResult, /status: 'error'/);
assert.match(resultStore, /TTL_MS = 15 \* 60 \* 1000/);
assert.match(resultStore, /MAX_ENTRIES = 200/);
assert.match(resultStore, /registerInternalModelResult/);
assert.match(resultStore, /completeInternalModelResult/);
assert.match(resultStore, /failInternalModelResult/);

console.log('internal call protection regression tests passed');
