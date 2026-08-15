import type { DiagnosticResult } from '../types';

export interface PrivacyScrubOptions {
  redactOrganizationName?: string;
  redactPersonNames?: boolean;
}

export interface PrivacyScrubReport {
  result: DiagnosticResult;
  changed: boolean;
  replacements: number;
  potentialNames: string[];
}

const PERSON_CONTEXT_RE = /\b(?:prepared by|created by|author|owner|contact|responsible|interviewed|attendee|participant|presenter|reviewer|approver|reported by|submitted by)\s*:?\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö'’-]+(?:\s+[A-ZÅÄÖ][A-Za-zÅÄÖåäö'’-]+){0,2})\b/gi;
const HONORIFIC_NAME_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,2})\b/g;

const SAFE_PERSON_TERMS = new Set([
  'FinOps Lead',
  'Engineering Lead',
  'Quality Gate',
  'Evidence Check',
  'Source Confidence',
  'Cost Visibility',
  'Rate Usage',
  'Rate Optimization',
  'Architecture Engineering',
  'Culture Organization',
  'Governance Policy',
  'Planning Decision',
  'Crawl Walk',
  'Walk Run',
  'Cloud Cost',
  'Public Cloud',
  'Amazon Web',
  'Microsoft Azure',
  'Google Cloud',
  'Power BI',
  'Service Owner',
  'Product Owner',
  'Platform Team',
  'Finance Team',
  'Engineering Team',
  'FinOps Team'
]);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSpaces = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const isSafeNameCandidate = (value: string): boolean => {
  const normalized = normalizeSpaces(value);
  if (!normalized || SAFE_PERSON_TERMS.has(normalized)) return true;
  if (/\b(FinOps|Cloud|Cost|Governance|Policy|Architecture|Engineering|Culture|Organization|Roadmap|Quality|Evidence|Maturity|Crawl|Walk|Run|Summary|Diagnosis|Dashboard|Report)\b/i.test(normalized)) {
    return true;
  }
  return false;
};

const collectPotentialNames = (text: string): string[] => {
  const found = new Set<string>();
  const add = (value?: string) => {
    const normalized = normalizeSpaces(value || '');
    if (!normalized || isSafeNameCandidate(normalized)) return;
    found.add(normalized);
  };
  for (const match of text.matchAll(PERSON_CONTEXT_RE)) add(match[1]);
  for (const match of text.matchAll(HONORIFIC_NAME_RE)) add(match[1]);
  return Array.from(found);
};

export const scrubGeneratedText = (
  input: string,
  options: PrivacyScrubOptions = {}
): { text: string; replacements: number; potentialNames: string[] } => {
  if (!input) return { text: input, replacements: 0, potentialNames: [] };
  let text = input;
  let replacements = 0;
  const replace = (pattern: RegExp, token: string) => {
    text = text.replace(pattern, (match) => {
      replacements += 1;
      return token;
    });
  };

  replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');
  replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[IP_REDACTED]');
  replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, '[PHONE_REDACTED]');
  replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]');
  replace(/(?:sk-|pk_|vercel_blob_rw_)[a-zA-Z0-9_\-]{20,}/g, '[TOKEN_REDACTED]');

  const orgName = normalizeSpaces(options.redactOrganizationName || '');
  if (orgName.length >= 2) {
    replace(new RegExp(`\\b${escapeRegExp(orgName)}\\b`, 'gi'), '[ORGANIZATION_REDACTED]');
  }

  const potentialNames = collectPotentialNames(text);
  if (options.redactPersonNames) {
    for (const name of potentialNames) {
      replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), '[PERSON_NAME_REDACTED]');
    }
  }

  return { text, replacements, potentialNames };
};

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

const removeSourceFilenameFields = (
  value: unknown,
  stats?: { replacements: number; changed: boolean }
): void => {
  if (Array.isArray(value)) {
    value.forEach(item => removeSourceFilenameFields(item, stats));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['source_name', 'source_document']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    delete record[key];
    if (stats) {
      stats.replacements++;
      stats.changed = true;
    }
  }
  Object.values(record).forEach(child => removeSourceFilenameFields(child, stats));
};

export const stripSourceFilenameMetadata = (result: DiagnosticResult): DiagnosticResult => {
  const next = clone(result);
  removeSourceFilenameFields(next);
  return next;
};

const scrubStringDeep = (
  value: unknown,
  options: PrivacyScrubOptions,
  stats: { replacements: number; potentialNames: Set<string>; changed: boolean }
): unknown => {
  if (typeof value === 'string') {
    const scrubbed = scrubGeneratedText(value, options);
    stats.replacements += scrubbed.replacements;
    scrubbed.potentialNames.forEach(name => stats.potentialNames.add(name));
    if (scrubbed.text !== value) stats.changed = true;
    return scrubbed.text;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubStringDeep(item, options, stats));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = scrubStringDeep(child, options, stats);
    }
    return next;
  }
  return value;
};

export const scrubDiagnosticResultForPrivacy = (
  result: DiagnosticResult,
  options: PrivacyScrubOptions = { redactPersonNames: true }
): PrivacyScrubReport => {
  const next = clone(result);
  const stats = { replacements: 0, potentialNames: new Set<string>(), changed: false };
  next.phase_3_strategy = scrubStringDeep(next.phase_3_strategy, options, stats) as DiagnosticResult['phase_3_strategy'];
  if (next.quality_gate) {
    next.quality_gate = scrubStringDeep(next.quality_gate, options, stats) as DiagnosticResult['quality_gate'];
  }
  if (options.redactOrganizationName && next.meta?.document_analyzed) {
    const scrubbed = scrubGeneratedText(next.meta.document_analyzed, options);
    next.meta.document_analyzed = scrubbed.text;
    stats.replacements += scrubbed.replacements;
    scrubbed.potentialNames.forEach(name => stats.potentialNames.add(name));
    if (scrubbed.text !== result.meta.document_analyzed) stats.changed = true;
  }
  removeSourceFilenameFields(next, stats);
  return {
    result: next,
    changed: stats.changed,
    replacements: stats.replacements,
    potentialNames: Array.from(stats.potentialNames)
  };
};

export const findGeneratedReportPrivacyFindings = (result: DiagnosticResult): string[] => {
  const serialized = JSON.stringify({
    phase_3_strategy: result.phase_3_strategy,
    quality_gate: result.quality_gate
  });
  return collectPotentialNames(serialized);
};
