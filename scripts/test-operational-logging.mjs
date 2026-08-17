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
assert.deepEqual(filterOperationalMetadata('checkpoint_saved', {
  kind: 'phase2', scope: 'accepted', revision: 3, payload: 'private source content',
}), { kind: 'phase2', scope: 'accepted', revision: 3 });
assert.deepEqual(filterOperationalMetadata('checkpoint_save_failed', {
  kind: 'phase2', scope: 'accepted', error_code: 'CHECKPOINT_UNAVAILABLE', error: 'private source content',
}), { kind: 'phase2', scope: 'accepted', error_code: 'CHECKPOINT_UNAVAILABLE' });
assert.deepEqual(filterOperationalMetadata('synthesis_candidate_rejected', {
  attempt: 2, reason_code: 'FACT_CHECK_FAILED', response_body: 'private model output',
}), { attempt: 2, reason_code: 'FACT_CHECK_FAILED' });
assert.deepEqual(filterOperationalMetadata('pipeline_integrity_failed', {
  gate: 'pre_synthesis', error_code: 'DOMAIN_ANALYSIS_FAILED', domains: 'F', source_text: 'private source content',
}), { gate: 'pre_synthesis', error_code: 'DOMAIN_ANALYSIS_FAILED', domains: 'F' });
assert.deepEqual(filterOperationalMetadata('source_packet_used', {
  batch: 'A', chunks: 2, evidence_stage_packet_hash: 'fnv1a_12345678', source_text: 'private source content',
}), { batch: 'A', chunks: 2, evidence_stage_packet_hash: 'fnv1a_12345678' });
assert.deepEqual(filterOperationalMetadata('finding_provenance_adjusted', {
  domains: 'A,C', criteria_count: 2, removed_quotes: 3, quote_text: 'private source content',
}), { domains: 'A,C', criteria_count: 2, removed_quotes: 3 });
assert.deepEqual(filterOperationalMetadata('targeted_rescan_unavailable', {
  batch: 'C', criteria_count: 5, error_code: 'DEPENDENCY_UNCERTAINTY', fallback: 'verified_downgrades', error: 'private source content',
}), { batch: 'C', criteria_count: 5, error_code: 'DEPENDENCY_UNCERTAINTY', fallback: 'verified_downgrades' });
assert.deepEqual(filterOperationalMetadata('evidence_check_unavailable', {
  batch: 'C', attempts: 2, error_code: 'DEPENDENCY_UNCERTAINTY', valid_items: 8, expected_items: 10, source_text: 'private source content',
}), { batch: 'C', attempts: 2, error_code: 'DEPENDENCY_UNCERTAINTY', valid_items: 8, expected_items: 10 });
assert.equal(safeOperationalIdentifier('gpt-5.2/model:v1'), 'gpt-5.2/model:v1');
assert.equal(safeOperationalIdentifier('private.pdf'), '?');
assert.equal(safeOperationalIdentifier('private.pdf\nsource contents'), '?');
assert.equal(safeWorkerErrorCode({ code: 'REDIS_UNAVAILABLE' }), 'REDIS_UNAVAILABLE');
assert.equal(safeWorkerErrorCode(new Error('private source content')), 'INTERNAL_ERROR');

const logged = [];
const originalLog = console.log;
const originalWarn = console.warn;
try {
  console.log = value => logged.push(String(value));
  console.warn = value => logged.push(String(value));
  workerOperationalLog('info', 'execution_attempt_claimed', {
    run_id: 'run-1', attempt_id: 'attempt-1', stage: 'forensic_audit', provider: 'openai', model: 'gpt-5.5', queue_age_ms: 17,
    prompt: 'private source content', filename: 'private.pdf', response_body: 'private model output',
  });
  workerOperationalLog('warn', 'execution_attempt_failed', {
    run_id: 'run-1', attempt_id: 'attempt-1', stage: 'forensic_audit', provider: 'anthropic', model: 'claude-sonnet-5',
    outcome_code: 'INCOMPLETE_RESPONSE', termination_reason: 'MAX_OUTPUT_TOKENS', duration_ms: 42,
  });
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}
assert.equal(logged.length, 2);
assert.match(logged[0], /event=execution_attempt_claimed/);
assert.match(logged[0], /run_id=run-1/);
assert.doesNotMatch(logged[0], /private source content|private\.pdf|private model output/);
assert.match(logged[1], /outcome_code=INCOMPLETE_RESPONSE/);
assert.match(logged[1], /termination_reason=MAX_OUTPUT_TOKENS/);

for (const file of ['../api/openai-generate.js', '../api/anthropic-generate.js', '../api/xai-generate.js']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /errorText\.substring|errorText\.replace/);
  assert.doesNotMatch(source, /msg=\\?"\$\{msg/);
  assert.doesNotMatch(source, /failInternalModelResult\(internalCallId, error\?\.message/);
}

const routerSource = await readFile(new URL('../src/services/modelRouter.ts', import.meta.url), 'utf8');
assert.doesNotMatch(routerSource, /failed: \$\{msg\}|failures\.push\(\{ profile, error: msg \}\)/, 'router logs and traces must retain stable error codes only');

console.log('operational logging policy tests passed');
