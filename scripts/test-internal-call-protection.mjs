import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const router = await read('../src/services/modelRouter.ts');
const anthropic = await read('../api/anthropic-generate.js');
const openai = await read('../api/openai-generate.js');
const modelResult = await read('../api/model-result.js');
const resultStore = await read('../lib/internalModelResults.js');

assert.equal((router.match(/internalPipelineCall: true/g) || []).length, 2);
assert.match(router, /internalCallId/);
assert.match(router, /\/api\/model-result/);
assert.match(router, /internal_result_recovered/);
assert.match(router, /internal_result_timeout/);
assert.doesNotMatch(router, /\/api\/generate/);
assert.doesNotMatch(router, /provider === 'gemini'/);

for (const [name, source] of [
  ['anthropic', anthropic],
  ['openai', openai],
]) {
  assert.match(source, /internalPipelineCall/);
  assert.match(source, /internalCallId/);
  assert.match(source, /isInternalPipelineCall/);
  assert.match(source, /registerInternalModelResult/);
  assert.match(source, /completeInternalModelResult/);
  assert.match(source, /failInternalModelResult/);
  assert.match(source, /close_source=req_aborted/);
  assert.match(source, /close_source=response_closed/);
  assert.match(source, /internal_pipeline_call=/);
  assert.match(source, /internal_call_id=/);
  assert.match(source, /status=completed_after_response_closed/);
  assert.match(source, /event=internal_result_stored/);
  assert.match(source, /req\.on\('aborted', onRequestAborted\)/);
  assert.match(source, /res\.on\('close', onResponseClosed\)/);
  assert.match(
    source,
    /if \(isInternalPipelineCall\) \{\s+console\.warn\(`\$\{tag\} status=response_closed[\s\S]+?return;\s+\}/,
    `${name} should not treat internal response close as an upstream abort`,
  );
}

assert.match(anthropic, /upstreamController\.abort\(\)/);
assert.match(openai, /upstreamController\.abort\(\)/);
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
