import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { issueCookie } from '../lib/auth.js';
import { clearBlockHandler } from '../api/golden-standard-clear-block.js';
import { clearBlockCase } from '../lib/goldenStandardClearBlock.js';

process.env.SECRET_KEY = 'disposable-clear-block-test';
const headers = { cookie: issueCookie().split(';')[0] };
const input = Buffer.from('x,y\n1,2\n');
const manifest = [{ path: 'inputs/clear-block/example.csv', sha256: createHash('sha256').update(input).digest('hex'), bytes: input.length }];
const expected = {
  reference_version: 'v1',
  proposed_decisions: { evidence_sufficiency: 'BLOCK', quality_gate: 'BLOCK', planning_decision: 'NO GO' },
  facts: [
    { id: 'billed-cost', local_numeric_expectation: { total: '258.22', rows: 4 } },
    { id: 'estimated-opportunity', local_numeric_expectation: { total: '13180', rows: 5 } },
  ],
  review: ['SERVER_ONLY_REFERENCE'],
};
const reader = clearBlockCase({ GOLDEN_STANDARD_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_stub_stored' }, async (url, init) => {
  assert.equal(new URL(url).hostname, 'stub.private.blob.vercel-storage.com');
  assert.equal(init.redirect, 'error');
  return new Response(input);
});
const handler = clearBlockHandler({ loadInputs: async () => manifest, loadReference: async () => expected, read: reader.read });
async function request(method, query, body, authenticated = true) {
  const response = {
    statusCode: 0,
    headers: {},
    status(statusCode) { this.statusCode = statusCode; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(payload) { this.body = payload; },
    send(payload) { this.body = payload; },
  };
  await handler({ method, query, body, headers: authenticated ? headers : {} }, response);
  return response;
}

assert.equal((await request('GET', {}, undefined, false)).statusCode, 401);
const metadata = await request('GET', {});
assert.equal(metadata.headers['Cache-Control'], 'private, no-store');
assert.deepEqual(metadata.body.files, [{ name: 'example.csv', bytes: input.length, sha256: manifest[0].sha256 }]);
assert.equal((await request('GET', { input: '../reference' })).statusCode, 400);
assert.deepEqual((await request('GET', { input: '0' })).body, input);
manifest[0].sha256 = '0'.repeat(64);
assert.equal((await request('GET', { input: '0' })).body.error, 'GOLDEN_STANDARD_INTEGRITY');
const observation = {
  evidenceSufficiency: 'BLOCK', qualityGate: 'BLOCK', planningDecision: 'NO GO',
  loadedInputsInTrace: true, excludedDocument: true, directiveRoadmapWithheld: true, maturityClassificationWithheld: true,
  billingRows: 4, billingCents: 25822, backlogRows: 5, backlogCents: 1318000,
};
const comparison = await request('POST', {}, observation);
assert.equal(comparison.body.status, 'Review');
assert.ok(comparison.body.checks.every(check => check.matches));
assert.equal(JSON.stringify(comparison.body).includes('SERVER_ONLY_REFERENCE'), false);
const mismatch = await request('POST', {}, { ...observation, excludedDocument: false, qualityGate: 'WARN' });
assert.equal(mismatch.body.checks.filter(check => !check.matches).length, 2);
assert.equal((await request('POST', {}, { ...observation, summaryHtml: '<p>unexpected</p>' })).statusCode, 400);
console.log('Clear BLOCK authenticated fixture, digest and comparison tests passed.');
