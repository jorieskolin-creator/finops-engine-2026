import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const router = await read('../src/services/modelRouter.ts');
const gemini = await read('../api/generate.js');
const anthropic = await read('../api/anthropic-generate.js');
const openai = await read('../api/openai-generate.js');

assert.equal((router.match(/internalPipelineCall: true/g) || []).length, 3);

for (const [name, source] of [
  ['gemini', gemini],
  ['anthropic', anthropic],
  ['openai', openai],
]) {
  assert.match(source, /internalPipelineCall/);
  assert.match(source, /isInternalPipelineCall/);
  assert.match(source, /close_source=req_aborted/);
  assert.match(source, /close_source=response_closed/);
  assert.match(source, /internal_pipeline_call=/);
  assert.match(source, /status=completed_after_response_closed/);
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

console.log('internal call protection regression tests passed');
