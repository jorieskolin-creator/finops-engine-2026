import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterOperationalMetadata, safeOperationalIdentifier } from '../lib/operationalLogPolicy.js';
import { safeWorkerErrorCode, workerOperationalLog } from '../lib/workerOperationalLog.js';

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
assert.deepEqual(filterOperationalMetadata('pipeline_integrity_failed', {
  gate: 'pre_synthesis', error_code: 'DOMAIN_ANALYSIS_FAILED', domains: 'F', source_text: 'private source content',
}), { gate: 'pre_synthesis', error_code: 'DOMAIN_ANALYSIS_FAILED', domains: 'F' });
assert.equal(safeOperationalIdentifier('gpt-5.2/model:v1'), 'gpt-5.2/model:v1');
assert.equal(safeOperationalIdentifier('private.pdf'), '?');
assert.equal(safeOperationalIdentifier('private.pdf\nsource contents'), '?');
assert.equal(safeWorkerErrorCode({ code: 'REDIS_UNAVAILABLE' }), 'REDIS_UNAVAILABLE');
assert.equal(safeWorkerErrorCode(new Error('private source content')), 'INTERNAL_ERROR');

const logged = [];
const originalLog = console.log;
try {
  console.log = value => logged.push(String(value));
  workerOperationalLog('info', 'execution_attempt_claimed', {
    run_id: 'run-1', attempt_id: 'attempt-1', stage: 'preflight', provider: 'openai', model: 'gpt-5.5', queue_age_ms: 17,
    prompt: 'private source content', filename: 'private.pdf', response_body: 'private model output',
  });
} finally {
  console.log = originalLog;
}
assert.equal(logged.length, 1);
assert.match(logged[0], /event=execution_attempt_claimed/);
assert.match(logged[0], /run_id=run-1/);
assert.doesNotMatch(logged[0], /private source content|private\.pdf|private model output/);

for (const file of ['../api/openai-generate.js', '../api/anthropic-generate.js', '../api/qwen-generate.js']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /errorText\.substring|errorText\.replace/);
  assert.doesNotMatch(source, /msg=\\?"\$\{msg/);
  assert.doesNotMatch(source, /failInternalModelResult\(internalCallId, error\?\.message/);
}

const routerSource = await readFile(new URL('../src/services/modelRouter.ts', import.meta.url), 'utf8');
assert.doesNotMatch(routerSource, /failed: \$\{msg\}|failures\.push\(\{ profile, error: msg \}\)/, 'router logs and traces must retain stable error codes only');

console.log('operational logging policy tests passed');
