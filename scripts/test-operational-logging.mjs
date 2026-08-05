import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterOperationalMetadata, safeOperationalIdentifier } from '../lib/operationalLogPolicy.js';

assert.deepEqual(filterOperationalMetadata('stage_complete', {
  stage: 'synthesis', model: 'model-v1', duration_ms: 42,
  prompt: 'secret', evidence: 'secret', response_body: 'secret', filename: 'private.pdf',
}), { stage: 'synthesis', model: 'model-v1', duration_ms: 42 });
assert.deepEqual(filterOperationalMetadata('unknown_event', { stage: 'x', duration_ms: 1 }), {});
assert.deepEqual(filterOperationalMetadata('internal_result_error', {
  internal_call_id: 'call-1', error_code: 'upstream_http_error', http_status: 429,
  message: 'raw provider excerpt', cause: 'raw exception',
}), { internal_call_id: 'call-1', error_code: 'upstream_http_error', http_status: 429 });
assert.deepEqual(filterOperationalMetadata('pipeline_complete', { models: { secret: 'value' }, outcome: 'ok' }), { outcome: 'ok' });
assert.equal(safeOperationalIdentifier('gpt-5.2/model:v1'), 'gpt-5.2/model:v1');
assert.equal(safeOperationalIdentifier('private.pdf'), '?');
assert.equal(safeOperationalIdentifier('private.pdf\nsource contents'), '?');

for (const file of ['../api/openai-generate.js', '../api/anthropic-generate.js']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /errorText\.substring|errorText\.replace/);
  assert.doesNotMatch(source, /msg=\\?"\$\{msg/);
  assert.doesNotMatch(source, /failInternalModelResult\(internalCallId, error\?\.message/);
}

const routerSource = await readFile(new URL('../src/services/modelRouter.ts', import.meta.url), 'utf8');
assert.doesNotMatch(routerSource, /failed: \$\{msg\}|failures\.push\(\{ profile, error: msg \}\)/, 'router logs and traces must retain stable error codes only');

console.log('operational logging policy tests passed');
