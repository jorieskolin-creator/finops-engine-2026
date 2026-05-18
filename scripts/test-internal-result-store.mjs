import assert from 'node:assert/strict';
import {
  clearInternalModelResultsForTests,
  completeInternalModelResult,
  failInternalModelResult,
  getInternalModelResult,
  registerInternalModelResult,
} from '../lib/internalModelResults.js';

clearInternalModelResultsForTests();

registerInternalModelResult('call-pending', {
  runId: 'run-1',
  provider: 'anthropic',
  stage: 'synthesis',
  model: 'claude-sonnet-4-6',
});
assert.equal(getInternalModelResult('call-pending').status, 'pending');

completeInternalModelResult('call-done', 'final text', { output_tokens: 12 }, {
  runId: 'run-2',
  provider: 'openai',
  stage: 'fact_check',
  model: 'gpt-5.5',
});
const done = getInternalModelResult('call-done');
assert.equal(done.status, 'done');
assert.equal(done.text, 'final text');
assert.equal(done.usage.output_tokens, 12);
assert.equal(done.model, 'gpt-5.5');

failInternalModelResult('call-error', 'upstream failed', {
  runId: 'run-3',
  provider: 'gemini',
  stage: 'evidence_check',
  model: 'gemini-3.1-pro-preview',
});
const error = getInternalModelResult('call-error');
assert.equal(error.status, 'error');
assert.equal(error.message, 'upstream failed');

assert.equal(getInternalModelResult('missing-call'), null);

clearInternalModelResultsForTests();
assert.equal(getInternalModelResult('call-done'), null);

console.log('internal result store unit tests passed');
