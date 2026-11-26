import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { issueCookie } from '../lib/auth.js';
import { clearBlockHandler } from '../api/golden-standard-clear-block.js';
import { clearBlockCase } from '../lib/goldenStandardClearBlock.js';

process.env.SECRET_KEY = 'disposable-clear-block-test';
const headers = { cookie: issueCookie().split(';')[0] };
const input = Buffer.from('x,y\n1,2\n');
const manifest = [{ path: 'inputs/clear-block/example.csv', sha256: createHash('sha256').update(input).digest('hex'), bytes: input.length }];
const expected = {
  reference_version: 'v1',
  status: 'review',
  approval: null,
  counts_toward_suite_pass: false,
  proposed_decisions: { evidence_sufficiency: 'BLOCK', quality_gate: 'BLOCK', planning_decision: 'NO GO' },
  facts: [
    {
      id: 'billed-cost', file: 'billing.csv', locator: 'Rows 2–5',
      expected_meaning: 'Four sampled billing rows total €258.22.',
      summary_expectation: 'If shown, preserve the sample scope.',
      local_numeric_expectation: { total: '258.22', rows: 4 },
    },
    {
      id: 'estimated-opportunity', file: 'backlog.csv', locator: 'Rows 2–6',
      expected_meaning: 'The backlog estimates €13,180 in opportunities.',
      summary_expectation: 'Realization is unverified.',
      local_numeric_expectation: { total: '13180', rows: 5 },
    },
  ],
  diagnosis: ['Billing and backlog support limited observations.'],
  allowed_roadmap: ['Request validation evidence. Withhold an implementation roadmap.'],
  forbidden: ['Describe the billed sample as total estate spend.'],
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
assert.equal(comparison.body.referenceApproved, false);
assert.ok(comparison.body.checks.every(check => check.matches));
assert.equal(JSON.stringify(comparison.body).includes('SERVER_ONLY_REFERENCE'), false);
assert.equal(JSON.stringify(metadata.body).includes('Sample'), false);
assert.deepEqual(comparison.body.narrativeChecks[1].sources, [{ file: 'backlog.csv', locator: 'Rows 2–6' }]);
const mismatch = await request('POST', {}, { ...observation, excludedDocument: false, qualityGate: 'WARN' });
assert.equal(mismatch.body.checks.filter(check => !check.matches).length, 2);
assert.equal((await request('POST', {}, { ...observation, summaryHtml: '<p>unexpected</p>' })).statusCode, 400);

const reviewSource = await readFile(new URL('../src/monitoring/clearBlockNarrativeReview.ts', import.meta.url), 'utf8');
const { code } = await transform(reviewSource, { loader: 'ts', format: 'esm' });
const { matchingReview, monitoringStatus, narrativeStatus, referenceIdentity } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);
const review = {
  runId: 'run-1',
  referenceIdentity: referenceIdentity(comparison.body),
  reviewer: 'Test reviewer',
  reviewedAt: '2026-11-26T12:00:00.000Z',
  judgments: Object.fromEntries(comparison.body.narrativeChecks.map(check => [check.id, 'Supported'])),
  note: 'The report says costs cover only the records supplied and calls for checking the backlog before action.',
};
assert.equal(matchingReview('run-1', comparison.body, review), review);
assert.equal(matchingReview('run-2', comparison.body, review), undefined);
assert.equal(matchingReview('run-1', { ...comparison.body, referenceSha256: 'changed' }, review), undefined);
assert.equal(narrativeStatus(comparison.body, review), 'Pass', 'A supported paraphrase passes narrative review');
assert.equal(monitoringStatus(comparison.body, review), 'Review', 'A candidate card prevents an overall Pass');
assert.equal(monitoringStatus({ ...comparison.body, referenceApproved: true }, review), 'Pass');
assert.equal(monitoringStatus(mismatch.body), 'Fail', 'A known mismatch survives pending narrative review');
assert.equal(monitoringStatus(undefined), 'Incomplete');
for (const id of ['billed-cost', 'estimated-opportunity', 'roadmap', 'other-claims']) {
  const flagged = { ...review, judgments: { ...review.judgments, [id]: 'Contradicted', diagnosis: 'Needs judgment' } };
  assert.equal(monitoringStatus(comparison.body, flagged), 'Fail', `A material contradiction in ${id} fails`);
}
assert.equal(monitoringStatus(comparison.body, { ...review, judgments: { ...review.judgments, diagnosis: 'Missing' } }), 'Fail');
assert.equal(monitoringStatus({ ...comparison.body, referenceApproved: true }, {
  ...review, judgments: { ...review.judgments, diagnosis: 'Needs judgment' },
}), 'Review');
console.log('Clear BLOCK authenticated fixture, digest, comparison, and narrative review tests passed.');
