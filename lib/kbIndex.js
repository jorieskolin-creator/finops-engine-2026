const DOMAIN_NAMES = {
  A: 'Cost Visibility & Allocation',
  B: 'Rate & Usage Optimization',
  C: 'Governance & Policy',
  D: 'Architecture & Engineering',
  E: 'Culture & Organization',
  F: 'GenAI & AI Cost Management',
};

const DOMAIN_NAME_ALIASES = {
  F: new Set(['GenAI / Token Cost Management', 'GenAI & AI Cost Management']),
};

const REQUIRED_FORBIDDEN_USES = ['customer_current_state_claim', 'source_evidence_quote'];
const STREAMS = new Set(['maturity', 'antipattern']);

export function normalizeDomainName(domainId, value) {
  const expected = DOMAIN_NAMES[domainId];
  const raw = String(value || '').trim();
  const aliases = DOMAIN_NAME_ALIASES[domainId];
  if (raw === expected || aliases?.has(raw)) return expected;
  return raw;
}

export function normalizeCriterionId(value) {
  const raw = String(value || '').trim().toUpperCase();
  const compact = raw
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '');
  const anti = compact.match(/^AP-?([A-F][1-5])$/);
  if (anti) return `AP-${anti[1]}`;
  const maturity = compact.match(/^([A-F][1-5])$/);
  if (maturity) return maturity[1];
  return compact;
}

export function normalizeCapabilityId(value) {
  return normalizeCriterionId(value).replace(/^AP-/, '');
}

export function extractJsonFrontMatter(text) {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error('front matter JSON opening brace not found');
  }

  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        return JSON.parse(raw);
      }
    }
  }

  throw new Error('front matter JSON closing brace not found');
}

export function expectedIdsFromPathname(pathname) {
  const filename = String(pathname || '').split('/').pop() || '';
  const match = filename.match(/^([A-F]) - .+ - (?:(AP-[A-F][1-5])|([A-F][1-5])|([A-F][1-5])-AP)\b/);
  if (!match) return null;
  const domainId = match[1];
  const criterionId = match[2] || match[3] || `AP-${match[4]}`;
  const capabilityId = criterionId.replace(/^AP-/, '');
  return {
    domainId,
    domainName: DOMAIN_NAMES[domainId],
    criterionId,
    capabilityId,
    stream: criterionId.startsWith('AP-') ? 'antipattern' : 'maturity',
  };
}

export function validateKbMetadata(meta, pathname) {
  const problems = [];
  const expected = expectedIdsFromPathname(pathname);
  if (!expected) {
    problems.push('filename does not match canonical KB pattern');
    return problems;
  }

  if (!meta || typeof meta !== 'object') {
    problems.push('front matter is not an object');
    return problems;
  }
  if (meta.domain_id !== expected.domainId) problems.push(`domain_id=${meta.domain_id} expected=${expected.domainId}`);
  if (normalizeDomainName(expected.domainId, meta.domain_name) !== expected.domainName) problems.push(`domain_name=${meta.domain_name} expected=${expected.domainName}`);
  if (meta.stream !== expected.stream || !STREAMS.has(meta.stream)) problems.push(`stream=${meta.stream} expected=${expected.stream}`);
  if (normalizeCriterionId(meta.criterion_id) !== expected.criterionId) problems.push(`criterion_id=${meta.criterion_id} expected=${expected.criterionId}`);
  if (normalizeCapabilityId(meta.capability_id) !== expected.capabilityId) problems.push(`capability_id=${meta.capability_id} expected=${expected.capabilityId}`);
  if ('streams' in meta) problems.push('legacy streams field is still primary');
  if ('antipattern_id' in meta) problems.push('legacy antipattern_id field is still primary');

  const forbidden = Array.isArray(meta.forbidden_uses) ? meta.forbidden_uses : [];
  for (const use of REQUIRED_FORBIDDEN_USES) {
    if (!forbidden.includes(use)) problems.push(`missing forbidden_uses ${use}`);
  }
  return problems;
}

export function removeFrontMatter(text) {
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(i + 1);
    }
  }
  return text;
}

export function firstContentLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

export function compactText(text, maxChars = 5000) {
  const compacted = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return compacted.length > maxChars
    ? `${compacted.slice(0, maxChars).trim()}\n[truncated]`
    : compacted;
}

export function sanitizeKbDocument({ pathname, url, downloadUrl, size, uploadedAt, text }) {
  const meta = extractJsonFrontMatter(text);
  const problems = validateKbMetadata(meta, pathname);
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  const body = compactText(removeFrontMatter(text), 6000);
  const expected = expectedIdsFromPathname(pathname);
  return {
    pathname,
    url,
    downloadUrl,
    size,
    uploadedAt,
    kb_id: meta.kb_id,
    domain_id: meta.domain_id,
    domain_name: expected?.domainName || normalizeDomainName(meta.domain_id, meta.domain_name),
    stream: meta.stream,
    criterion_id: expected?.criterionId || normalizeCriterionId(meta.criterion_id),
    capability_id: expected?.capabilityId || normalizeCapabilityId(meta.capability_id),
    title: meta.capability_name || meta.antipattern_name || firstContentLine(body) || expected?.criterionId || pathname,
    evidence_categories: Array.isArray(meta.evidence_categories) ? meta.evidence_categories : [],
    allowed_uses: Array.isArray(meta.allowed_uses) ? meta.allowed_uses : [],
    forbidden_uses: Array.isArray(meta.forbidden_uses) ? meta.forbidden_uses : [],
    legacy_ids: Array.isArray(meta.legacy_ids) ? meta.legacy_ids : [],
    body_excerpt: body,
  };
}

export function buildKbStatus(documents, failures, source, prefix) {
  const domains = {};
  for (const doc of documents) {
    const key = doc.domain_id || '?';
    domains[key] = (domains[key] || 0) + 1;
  }
  return {
    source,
    prefix,
    document_count: documents.length,
    failure_count: failures.length,
    domains,
    loaded_at: new Date().toISOString(),
  };
}
