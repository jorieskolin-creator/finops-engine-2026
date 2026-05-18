const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 200;

const results = new Map();

const now = () => Date.now();

function pruneExpired() {
  const cutoff = now() - TTL_MS;
  for (const [id, entry] of results.entries()) {
    if ((entry.updatedAt || entry.createdAt || 0) < cutoff) {
      results.delete(id);
    }
  }
  while (results.size > MAX_ENTRIES) {
    const oldest = results.keys().next().value;
    if (!oldest) break;
    results.delete(oldest);
  }
}

function safeMetadata(metadata = {}) {
  return {
    runId: metadata.runId || '',
    provider: metadata.provider || '',
    stage: metadata.stage || '',
    model: metadata.model || '',
  };
}

export function registerInternalModelResult(id, metadata = {}) {
  if (!id) return;
  pruneExpired();
  const ts = now();
  const existing = results.get(id);
  results.set(id, {
    ...(existing || {}),
    ...safeMetadata(metadata),
    status: existing?.status || 'pending',
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  });
}

export function completeInternalModelResult(id, text, usage = null, metadata = {}) {
  if (!id) return;
  pruneExpired();
  const ts = now();
  const existing = results.get(id);
  results.set(id, {
    ...(existing || {}),
    ...safeMetadata(metadata),
    status: 'done',
    text: typeof text === 'string' ? text : '',
    usage: usage || null,
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  });
}

export function failInternalModelResult(id, message, metadata = {}) {
  if (!id) return;
  pruneExpired();
  const ts = now();
  const existing = results.get(id);
  results.set(id, {
    ...(existing || {}),
    ...safeMetadata(metadata),
    status: 'error',
    message: message || 'model call failed',
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  });
}

export function getInternalModelResult(id) {
  if (!id) return null;
  pruneExpired();
  const entry = results.get(id);
  if (!entry) return null;
  return {
    status: entry.status,
    text: entry.text,
    usage: entry.usage,
    message: entry.message,
    runId: entry.runId,
    provider: entry.provider,
    stage: entry.stage,
    model: entry.model,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function clearInternalModelResultsForTests() {
  results.clear();
}
