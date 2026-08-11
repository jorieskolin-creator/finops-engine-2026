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

const KB_SECTION_HEADINGS = [
  ['engine_usage_note', ['Engine Usage Note']],
  ['purpose', ['Purpose']],
  ['applies_to', ['Applies To']],
  ['canonical_definition', ['Canonical Definition']],
  ['primary_assessment_questions', ['Primary Assessment Questions']],
  ['state_interpretation', ['Anti-Pattern State Interpretation', 'Maturity State Interpretation', 'State Interpretation']],
  ['detailed_interpretation', ['Detailed Anti-Pattern Interpretation', 'Detailed Maturity Interpretation']],
  ['migration_economics_interpretation', ['Migration Economics Interpretation']],
  ['optimization_interpretation', ['Cloud-Native Optimization Interpretation']],
  ['evidence_requirements', ['Evidence Requirements']],
  ['strong_evidence_examples', ['Strong Evidence Examples', 'Strong Evidence']],
  ['moderate_evidence_examples', ['Moderate Evidence Examples', 'Moderate Evidence']],
  ['weak_evidence_examples', ['Weak Evidence Examples', 'Weak Evidence']],
  ['contradictory_evidence_examples', ['Contradictory Evidence Examples', 'Contradictory Evidence']],
  ['accepted_evidence_types', ['Accepted Evidence Types']],
  ['provider_mapping', ['Provider Mapping']],
  ['focus_normalized_interpretation', ['FOCUS-Normalized Interpretation']],
  ['related_capabilities', ['Relationship to Maturity Capabilities', 'Related Capabilities']],
  ['false_positive_guards', ['False Positive Guards']],
  ['validation_questions', ['Validation Questions']],
  ['detection_heuristics', ['Detection Heuristics']],
  ['operational_indicators', ['Operational Indicators of Severe Anti-Pattern Presence', 'Operational Indicators']],
  ['risk_notes', ['Risk Notes']],
  ['remediation_tactic_notes', ['Remediation / Tactic Notes', 'Remediation and Tactic Notes']],
  ['prohibited_inference_rules', ['Prohibited Inference Rules']],
  ['scoring_guidance', ['Scoring Guidance Notes', 'Scoring Guidance']],
  ['canonical_source_foundations', ['Canonical Source Foundations']],
];

const normalizeHeading = text => String(text || '')
  .replace(/[‐‑‒–—―−]/g, '-')
  .replace(/\s*-\s*/g, '-')
  .replace(/\s+/g, ' ')
  .replace(/^\d+(?:\.\d+)*\.?\s+/, '')
  .replace(/\s*[:.]$/, '')
  .trim();

function parseKbSections(text) {
  const lines = String(removeFrontMatter(text) || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\[\/?KB_PDF_PAGE[^\]]*\]/g, '').trim())
    .filter(Boolean);
  const aliases = new Map();
  for (const [key, values] of KB_SECTION_HEADINGS) {
    for (const value of values) aliases.set(normalizeHeading(value).toLowerCase(), key);
  }
  const matches = [];
  const duplicateHeadings = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const key = aliases.get(normalizeHeading(lines[lineIndex]).toLowerCase());
    if (!key) continue;
    if (matches.some(match => match.key === key)) {
      duplicateHeadings.push(key);
      continue;
    }
    matches.push({ key, lineIndex });
  }
  const sections = {};
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.lineIndex ?? lines.length;
    sections[match.key] = lines.slice(match.lineIndex + 1, end).join('\n').trim();
  });
  const headingOrder = new Map(KB_SECTION_HEADINGS.map(([key], index) => [key, index]));
  const outOfOrder = matches.some((match, index) => index > 0
    && headingOrder.get(match.key) < headingOrder.get(matches[index - 1].key));
  return { sections, duplicateHeadings, outOfOrder };
}

export function extractKbSections(text) {
  return parseKbSections(text).sections;
}

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

export function sanitizeKbDocument({
  pathname,
  url,
  downloadUrl,
  size,
  uploadedAt,
  text,
  sectionText,
  pdfSha256,
  extractedTextSha256,
  extraction = {},
}) {
  const meta = extractJsonFrontMatter(text);
  const problems = validateKbMetadata(meta, pathname);
  if (problems.length > 0) {
    throw new Error(problems.join('; '));
  }
  const body = compactText(removeFrontMatter(text), Number.POSITIVE_INFINITY);
  const sectionResult = parseKbSections(sectionText || text);
  const sections = sectionResult.sections;
  const expected = expectedIdsFromPathname(pathname);
  return {
    pathname,
    url,
    downloadUrl,
    size,
    uploadedAt,
    pdf_sha256: pdfSha256,
    extracted_text_sha256: extractedTextSha256,
    kb_id: meta.kb_id,
    version: meta.version,
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
    extraction: {
      total_pages: extraction.totalPages,
      processed_pages: extraction.processedPages,
      sparse_pages: Array.isArray(extraction.sparsePages) ? extraction.sparsePages : [],
      page_limit_reached: Boolean(extraction.pageLimitReached),
      section_count: Object.keys(sections).length,
      duplicate_section_headings: sectionResult.duplicateHeadings,
      section_order_valid: !sectionResult.outOfOrder,
    },
    sections,
    body_excerpt: body,
  };
}

export function buildKbStatus(documents, failures, source, prefix) {
  const domains = {};
  for (const doc of documents) {
    const key = doc.domain_id || '?';
    domains[key] = (domains[key] || 0) + 1;
  }
  const pageLimitCount = documents.filter(doc => doc.extraction?.page_limit_reached).length;
  const sparsePageCount = documents.reduce((sum, doc) => sum + (doc.extraction?.sparse_pages?.length || 0), 0);
  const sectionedDocumentCount = documents.filter(doc => (doc.extraction?.section_count || 0) > 0).length;
  const duplicateSectionHeadingCount = documents.reduce(
    (sum, doc) => sum + (doc.extraction?.duplicate_section_headings?.length || 0), 0
  );
  const invalidSectionOrderDocumentCount = documents.filter(
    doc => doc.extraction?.section_order_valid === false
  ).length;
  const expectedDocumentKeys = new Set(['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domainId => (
    Array.from({ length: 5 }, (_, index) => [
      `maturity:${domainId}${index + 1}`,
      `antipattern:AP-${domainId}${index + 1}`
    ]).flat()
  )));
  const actualDocumentKeys = documents.map(doc => `${doc.stream}:${doc.criterion_id}`);
  const uniqueDocumentKeys = new Set(actualDocumentKeys);
  const missingExpectedDocumentCount = [...expectedDocumentKeys]
    .filter(key => !uniqueDocumentKeys.has(key)).length;
  const unexpectedDocumentCount = [...uniqueDocumentKeys]
    .filter(key => !expectedDocumentKeys.has(key)).length;
  const duplicateDocumentCount = actualDocumentKeys.length - uniqueDocumentKeys.size;
  return {
    source,
    prefix,
    document_count: documents.length,
    failure_count: failures.length,
    domains,
    delivery: {
      sectioned_document_count: sectionedDocumentCount,
      page_limit_document_count: pageLimitCount,
      sparse_page_count: sparsePageCount,
      duplicate_section_heading_count: duplicateSectionHeadingCount,
      invalid_section_order_document_count: invalidSectionOrderDocumentCount,
      missing_expected_document_count: missingExpectedDocumentCount,
      unexpected_document_count: unexpectedDocumentCount,
      duplicate_document_count: duplicateDocumentCount,
      shadow_ready: documents.length > 0
        && failures.length === 0
        && pageLimitCount === 0
        && sectionedDocumentCount === documents.length
        && duplicateSectionHeadingCount === 0
        && invalidSectionOrderDocumentCount === 0
        && missingExpectedDocumentCount === 0
        && unexpectedDocumentCount === 0
        && duplicateDocumentCount === 0,
    },
    loaded_at: new Date().toISOString(),
  };
}
