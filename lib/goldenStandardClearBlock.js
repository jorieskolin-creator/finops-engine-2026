import { createHash } from 'node:crypto';

const prefix = 'golden-standard/2026-11-26-v1/';
const manifest = {
  path: 'manifests/clear-block/inputs-v1.json',
  sha256: 'e37ca059b9d1e5f44e1ffbff71b23b4fd8109aa3bfaf75e3a29d304b862fdcf0',
  maxBytes: 4096,
};
const reference = {
  path: 'references/clear-block/reference-v1.json',
  sha256: '9aeb6700e9fa021ca0b5c49903eb8aa0ecf8d7b597279041a9109e15bc197766',
  maxBytes: 16384,
};

function privateBlobReader(env, fetchBlob) {
  const token = env.GOLDEN_STANDARD_BLOB_READ_WRITE_TOKEN;
  const storeId = token?.split('_')[3];
  if (!/^vercel_blob_rw_[a-z0-9]+_.+$/i.test(token ?? '') || !/^[a-z0-9]+$/i.test(storeId ?? '')) {
    throw new Error('GOLDEN_STANDARD_UNAVAILABLE');
  }
  return path => fetchBlob(`https://${storeId}.private.blob.vercel-storage.com/${prefix}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
}

export function clearBlockCase(env = process.env, fetchBlob = fetch) {
  async function read({ path, sha256, maxBytes, bytes }) {
    const response = await privateBlobReader(env, fetchBlob)(path);
    if (!response.ok || !response.body) throw new Error('GOLDEN_STANDARD_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (bytes ?? maxBytes)) throw new Error('GOLDEN_STANDARD_INTEGRITY');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = Buffer.concat(chunks, size);
    if ((bytes !== undefined && bytes !== size) || createHash('sha256').update(data).digest('hex') !== sha256) {
      throw new Error('GOLDEN_STANDARD_INTEGRITY');
    }
    return data;
  }

  const loadInputs = async () => JSON.parse(await read(manifest)).input_files;
  const loadReference = async () => JSON.parse(await read(reference));
  return { loadInputs, loadReference, read };
}

const fields = {
  evidenceSufficiency: ['PASS', 'BLOCK'],
  qualityGate: ['GO', 'WARN', 'BLOCK'],
  planningDecision: ['GO', 'CONDITIONAL GO', 'NO GO', 'NOT AVAILABLE'],
};
const booleans = ['loadedInputsInTrace', 'excludedDocument', 'directiveRoadmapWithheld', 'maturityClassificationWithheld'];
export function validClearBlockObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(fields).length + booleans.length + 4) return false;
  return Object.entries(fields).every(([key, allowed]) => allowed.includes(value[key]))
    && booleans.every(key => typeof value[key] === 'boolean')
    && ['billingRows', 'billingCents', 'backlogRows', 'backlogCents'].every(key =>
      Number.isSafeInteger(value[key]) && value[key] >= 0);
}

export function compareClearBlock(card, observation) {
  const billed = card.facts.find(fact => fact.id === 'billed-cost').local_numeric_expectation;
  const backlog = card.facts.find(fact => fact.id === 'estimated-opportunity').local_numeric_expectation;
  const decision = card.proposed_decisions;
  const check = (label, expected, observed) => ({ label, expected, observed, matches: expected === observed });
  const money = cents => `EUR ${(cents / 100).toFixed(2)}`;
  const checks = [
    check('Assessment Sufficiency', decision.evidence_sufficiency, observation.evidenceSufficiency),
    check('Quality Gate', decision.quality_gate, observation.qualityGate),
    check('Planning decision', decision.planning_decision, observation.planningDecision),
    check('Frozen inputs in RunTrace', true, observation.loadedInputsInTrace),
    check('Unrelated PDF excluded from evidence packets', true, observation.excludedDocument),
    check('Billed cost in the supplied sample', money(Math.round(Number(billed.total) * 100)), money(observation.billingCents)),
    check('Billing rows', billed.rows, observation.billingRows),
    check('Estimated backlog opportunities', money(Math.round(Number(backlog.total) * 100)), money(observation.backlogCents)),
    check('Backlog rows', backlog.rows, observation.backlogRows),
    check('Directive roadmap withheld in Summary', true, observation.directiveRoadmapWithheld),
    check('Maturity classification withheld in Summary', true, observation.maturityClassificationWithheld),
  ];
  return { status: 'Review', referenceVersion: card.reference_version, checks };
}
