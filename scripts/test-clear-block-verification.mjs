import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { issueCookie } from '../lib/auth.js';
import { clearBlockHandler } from '../api/golden-standard-clear-block.js';
import { clearBlockCase, goldenStandardCase, resolveGoldenStandardBlobConfig } from '../lib/goldenStandardClearBlock.js';

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

// Token fallback to BLOB_READ_WRITE_TOKEN and Vercel Blob store inventory discovery.
const fallbackConfig = resolveGoldenStandardBlobConfig({
  BLOB_READ_WRITE_TOKEN: ' "vercel_blob_rw_3qui09wjonlnjoes_secret" \n',
});
assert.equal(fallbackConfig.storeId, '3qui09wjonlnjoes');
assert.equal(fallbackConfig.source, 'BLOB_READ_WRITE_TOKEN');

const suffixedPayload = Buffer.from(JSON.stringify({
  case_id: 'clear-block',
  input_files: [
    { path: 'inputs/clear-block/01-billing.csv', bytes: 8, sha256: 'a'.repeat(64) },
    { path: 'inputs/clear-block/02-backlog.csv', bytes: 8, sha256: 'b'.repeat(64) },
    { path: 'inputs/clear-block/Systems-Thinking-and-the-Cynefin-Framework-Final.3.pdf', bytes: 8, sha256: 'c'.repeat(64) },
  ],
}));
const suffixedSha = createHash('sha256').update(suffixedPayload).digest('hex');
const discoveryCase = goldenStandardCase(
  'clear-block',
  { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_3qui09wjonlnjoes_secret' },
  async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === '3qui09wjonlnjoes.private.blob.vercel-storage.com' && parsed.pathname.startsWith('/golden-standard/')) {
      return new Response('Not found', { status: 404 });
    }
    if (parsed.hostname === 'vercel.com' && parsed.pathname === '/api/blob') {
      return Response.json({
        hasMore: false,
        blobs: [{
          pathname: 'Golden Standard/manifests/clear-block/inputs-v1-R4nd0m.json',
          downloadUrl: 'https://3qui09wjonlnjoes.private.blob.vercel-storage.com/Golden%20Standard/manifests/clear-block/inputs-v1-R4nd0m.json?download=1',
          size: suffixedPayload.length,
          uploadedAt: '2026-11-26T12:00:00.000Z',
        }],
      });
    }
    if (parsed.hostname === '3qui09wjonlnjoes.private.blob.vercel-storage.com') {
      return new Response(suffixedPayload, { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  },
);
const discoveredBytes = await discoveryCase.read({
  path: 'manifests/clear-block/inputs-v1.json',
  sha256: suffixedSha,
  maxBytes: 16384,
});
assert.deepEqual(discoveredBytes, suffixedPayload);
await assert.rejects(
  () => discoveryCase.read({ path: 'manifests/clear-block/inputs-v1.json', sha256: 'f'.repeat(64), maxBytes: 16384 }),
  /GOLDEN_STANDARD_INTEGRITY/,
);
console.log('Clear BLOCK authenticated fixture, digest, comparison, and narrative review tests passed.');
