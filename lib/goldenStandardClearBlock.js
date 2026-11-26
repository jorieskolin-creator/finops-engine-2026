import { createHash } from 'node:crypto';

import { cases, packageVersion } from './goldenStandardCases.js';

const prefix = `golden-standard/${packageVersion}/`;
const { manifest, reference } = cases['clear-block'];

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

export function goldenStandardCase(caseId, env = process.env, fetchBlob = fetch) {
  const pinned = Object.hasOwn(cases, caseId) && cases[caseId];
  if (!pinned) throw new Error('GOLDEN_STANDARD_UNAVAILABLE');
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

  const loadInputs = async () => {
    const data = JSON.parse(await read(pinned.manifest));
    if (data.case_id !== caseId || data.input_files?.length !== pinned.files) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    return data.input_files;
  };
  const loadReference = async () => {
    const card = JSON.parse(await read(pinned.reference));
    if (card.case_id !== caseId) throw new Error('GOLDEN_STANDARD_INTEGRITY');
    return card;
  };
  return { loadInputs, loadReference, read };
}

export const clearBlockCase = (...args) => goldenStandardCase('clear-block', ...args);

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
  return comparisonForCard(card, reference.sha256, checks);
}

export function comparisonForCard(card, sha256, checks) {
  return {
    status: 'Review',
    referenceVersion: card.reference_version,
    packageVersion,
    referenceSha256: sha256,
    referenceApproved: card.status === 'approved' && card.counts_toward_suite_pass === true && !!card.approval,
    checks,
    narrativeChecks: [
      ...card.facts.map(fact => ({
        id: fact.id,
        label: fact.id.split('-').map((part, index) => index === 0 ? part[0].toUpperCase() + part.slice(1) : part).join(' '),
        expected: [fact.expected_meaning, fact.summary_expectation],
        sources: [{ file: fact.file, locator: fact.locator }],
      })),
      {
        id: 'diagnosis', label: 'Diagnosis',
        expected: card.diagnosis,
      },
      {
        id: 'roadmap', label: 'Planning and roadmap',
        expected: card.allowed_roadmap,
      },
      {
        id: 'other-claims', label: 'Consequential claims and actions',
        expected: card.forbidden.map(claim => `Forbidden: ${claim}`),
      },
    ],
  };
}
