import { createHash } from 'node:crypto';

import { cases, packageVersion } from './goldenStandardCases.js';

const BLOB_API_URL = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '12';
const LIST_CACHE_TTL_MS = 5 * 60_000;
const MAX_LISTED_BLOBS = 500;
const defaultPrefix = `golden-standard/${packageVersion}/`;
const { manifest, reference } = cases['clear-block'];

const storeInventoryCache = new Map();

const taggedError = (message, code = message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const cleanEnvValue = value => typeof value === 'string'
  ? value.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  : '';

const normalizePrefix = value => {
  const trimmed = cleanEnvValue(value).replace(/^\/+/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
};

const allowedBlobDownloadUrl = rawUrl => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:'
      && (parsed.hostname.endsWith('.blob.vercel-storage.com') || parsed.hostname === 'vercel.com');
  } catch {
    return false;
  }
};

export function resolveGoldenStandardBlobConfig(env = process.env) {
  const candidates = [
    ['GOLDEN_STANDARD_BLOB_READ_WRITE_TOKEN', cleanEnvValue(env?.GOLDEN_STANDARD_BLOB_READ_WRITE_TOKEN)],
    ['BLOB_READ_WRITE_TOKEN', cleanEnvValue(env?.BLOB_READ_WRITE_TOKEN)],
  ];
  const found = candidates.find(([, value]) => value.length > 0);
  if (!found) {
    throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_TOKEN_MISSING');
  }
  const [source, token] = found;
  const storeId = token.split('_')[3];
  if (!/^vercel_blob_rw_[a-z0-9]+_.+$/i.test(token) || !/^[a-z0-9]+$/i.test(storeId ?? '')) {
    throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_TOKEN_INVALID', { blobSource: source });
  }
  const configuredPrefix = env?.GOLDEN_STANDARD_BLOB_PREFIX !== undefined
    ? normalizePrefix(env.GOLDEN_STANDARD_BLOB_PREFIX)
    : defaultPrefix;
  return { token, storeId, source, prefix: configuredPrefix };
}

async function listStoreBlobs(config, fetchBlob, forceRefresh = false) {
  const cached = storeInventoryCache.get(config.storeId);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < LIST_CACHE_TTL_MS) {
    return cached.blobs;
  }
  const blobs = [];
  let cursor;
  let count = 0;
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    let response;
    try {
      response = await fetchBlob(`${BLOB_API_URL}?${params}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
          'x-vercel-blob-store-id': config.storeId,
          'x-api-version': BLOB_API_VERSION,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_UPSTREAM_ERROR', { blobSource: config.source });
    }
    if (!response.ok) {
      throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_UPSTREAM_ERROR', {
        blobSource: config.source,
        httpStatus: response.status,
      });
    }
    const page = await response.json().catch(() => null);
    for (const blob of Array.isArray(page?.blobs) ? page.blobs : []) {
      count++;
      if (count > MAX_LISTED_BLOBS) break;
      if (typeof blob?.pathname === 'string') blobs.push(blob);
    }
    cursor = count <= MAX_LISTED_BLOBS && page?.hasMore ? page.cursor : undefined;
  } while (cursor);
  storeInventoryCache.set(config.storeId, { fetchedAt: now, blobs });
  return blobs;
}

function candidateBlobsForPath(blobs, relativePath, configuredPrefix, { bytes, maxBytes }) {
  const cleanRel = relativePath.replace(/^\/+/, '');
  const lowerRel = cleanRel.toLowerCase();
  const fullConfigured = `${configuredPrefix}${cleanRel}`.toLowerCase();
  const fullDefault = `${defaultPrefix}${cleanRel}`.toLowerCase();
  const withinSize = blob => {
    const size = Number(blob?.size);
    if (!Number.isFinite(size) || size < 0) return true;
    return bytes !== undefined ? size === bytes : maxBytes !== undefined ? size <= maxBytes : true;
  };

  const exact = [];
  const suffixed = [];
  const lastSlash = lowerRel.lastIndexOf('/');
  const dirSuffix = lastSlash >= 0 ? lowerRel.slice(0, lastSlash + 1) : '';
  const fileName = lastSlash >= 0 ? lowerRel.slice(lastSlash + 1) : lowerRel;
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';

  for (const blob of blobs) {
    if (!withinSize(blob)) continue;
    const pathname = String(blob.pathname).replace(/^\/+/, '');
    const lower = pathname.toLowerCase();
    if (lower === fullConfigured || lower === fullDefault || lower === lowerRel || lower.endsWith(`/${lowerRel}`)) {
      exact.push(blob);
      continue;
    }
    const blobSlash = lower.lastIndexOf('/');
    const blobDir = blobSlash >= 0 ? lower.slice(0, blobSlash + 1) : '';
    const blobFile = blobSlash >= 0 ? lower.slice(blobSlash + 1) : lower;
    if ((dirSuffix === '' || blobDir === dirSuffix || blobDir.endsWith(`/${dirSuffix}`))
      && blobFile.startsWith(`${stem}-`) && (ext === '' || blobFile.endsWith(ext))) {
      suffixed.push(blob);
    }
  }
  const byNewest = (left, right) => String(right?.uploadedAt ?? '').localeCompare(String(left?.uploadedAt ?? ''));
  return [...exact.sort(byNewest), ...suffixed.sort(byNewest)];
}

async function readBoundedBody(response, { sha256, maxBytes, bytes }) {
  if (!response.body) throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_UPSTREAM_ERROR');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (bytes ?? maxBytes)) throw taggedError('GOLDEN_STANDARD_INTEGRITY', 'GOLDEN_STANDARD_INTEGRITY');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = Buffer.concat(chunks, size);
  if ((bytes !== undefined && bytes !== size) || createHash('sha256').update(data).digest('hex') !== sha256) {
    throw taggedError('GOLDEN_STANDARD_INTEGRITY', 'GOLDEN_STANDARD_INTEGRITY');
  }
  return data;
}

export function goldenStandardCase(caseId, env = process.env, fetchBlob = fetch) {
  const pinned = Object.hasOwn(cases, caseId) && cases[caseId];
  if (!pinned) throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_UNAVAILABLE');

  async function read({ path, sha256, maxBytes, bytes }) {
    const config = resolveGoldenStandardBlobConfig(env);
    let directStatus;
    try {
      const direct = await fetchBlob(`https://${config.storeId}.private.blob.vercel-storage.com/${config.prefix}${path}`, {
        headers: { authorization: `Bearer ${config.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      directStatus = direct.status;
      if (direct.ok) {
        return await readBoundedBody(direct, { sha256, maxBytes, bytes });
      }
    } catch (error) {
      if (error?.message === 'GOLDEN_STANDARD_INTEGRITY') throw error;
    }

    for (const refresh of [false, true]) {
      let blobs;
      try {
        blobs = await listStoreBlobs(config, fetchBlob, refresh);
      } catch (listError) {
        if (directStatus === 401 || directStatus === 403) {
          throw taggedError('GOLDEN_STANDARD_UNAVAILABLE', 'GOLDEN_STANDARD_BLOB_FORBIDDEN', {
            blobSource: config.source,
            httpStatus: directStatus,
          });
        }
        throw listError;
      }
      const candidates = candidateBlobsForPath(blobs, path, config.prefix, { bytes, maxBytes });
      let sawIntegrityMismatch = false;
      for (const candidate of candidates) {
        const targetUrl = candidate.downloadUrl || candidate.url;
        if (!allowedBlobDownloadUrl(targetUrl)) continue;
        let response;
        try {
          response = await fetchBlob(targetUrl, {
            headers: { authorization: `Bearer ${config.token}` },
            signal: AbortSignal.timeout(20_000),
          });
        } catch {
          continue;
        }
        if (!response.ok) continue;
        try {
          return await readBoundedBody(response, { sha256, maxBytes, bytes });
        } catch (error) {
          if (error?.message === 'GOLDEN_STANDARD_INTEGRITY') sawIntegrityMismatch = true;
        }
      }
      if (sawIntegrityMismatch && refresh) {
        throw taggedError('GOLDEN_STANDARD_INTEGRITY', 'GOLDEN_STANDARD_INTEGRITY', { blobSource: config.source });
      }
      if (candidates.length > 0 && !refresh && !sawIntegrityMismatch) break;
    }

    throw taggedError(
      'GOLDEN_STANDARD_UNAVAILABLE',
      directStatus === 401 || directStatus === 403 ? 'GOLDEN_STANDARD_BLOB_FORBIDDEN' : 'GOLDEN_STANDARD_BLOB_NOT_FOUND',
      { blobSource: config.source, httpStatus: directStatus },
    );
  }

  const loadInputs = async () => {
    const data = JSON.parse(await read(pinned.manifest));
    if (data.case_id !== caseId || data.input_files?.length !== pinned.files) {
      throw taggedError('GOLDEN_STANDARD_INTEGRITY', 'GOLDEN_STANDARD_INTEGRITY');
    }
    return data.input_files;
  };
  const loadReference = async () => {
    const card = JSON.parse(await read(pinned.reference));
    if (card.case_id !== caseId) throw taggedError('GOLDEN_STANDARD_INTEGRITY', 'GOLDEN_STANDARD_INTEGRITY');
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
