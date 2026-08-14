import type {
  EvidencePrivacyDecision,
  EvidencePrivacyFindingKind,
  SourceRecord
} from '../types';

type Pattern = {
  kind: EvidencePrivacyFindingKind;
  severity: 'redact' | 'block';
  regex: RegExp;
  replacement: string;
};

const PATTERNS: Pattern[] = [
  { kind: 'private_key', severity: 'block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { kind: 'cloud_key', severity: 'block', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: '[CLOUD_KEY_REDACTED]' },
  { kind: 'api_key', severity: 'block', regex: /\b(?:sk-|pk_|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/g, replacement: '[API_KEY_REDACTED]' },
  { kind: 'credential_assignment', severity: 'block', regex: /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token)\s*[:=]\s*\S+/gi, replacement: '[CREDENTIAL_REDACTED]' },
  { kind: 'bearer_token', severity: 'block', regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, replacement: '[BEARER_TOKEN_REDACTED]' },
  { kind: 'government_identifier', severity: 'redact', regex: /\b\d{3}-\d{2}-\d{4}\b|\b(passport(?:\s+(?:number|no\.?|id))?\s*[:#=-]\s*)[A-Z0-9][A-Z0-9_-]{5,}\b/gi, replacement: '[GOVERNMENT_ID_REDACTED]' },
  { kind: 'personal_financial_identifier', severity: 'redact', regex: /\b((?:bank|credit\s+card|routing)\s+(?:account\s+)?(?:number|no\.?|id)\s*[:#=-]\s*)[A-Z0-9][A-Z0-9 _-]{5,}\b/gi, replacement: '$1[PERSONAL_FINANCIAL_ID_REDACTED]' },
  { kind: 'home_address', severity: 'redact', regex: /\b(?:home|residential)\s+address\s*[:#=-]\s*[^\n]{5,160}/gi, replacement: '[HOME_ADDRESS_REDACTED]' },
  { kind: 'email', severity: 'redact', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[EMAIL_REDACTED]' },
  { kind: 'phone', severity: 'redact', regex: /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3}[ .-]\d{4}(?![\w.-])/g, replacement: '[PHONE_REDACTED]' },
  { kind: 'ip', severity: 'redact', regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, replacement: '[IP_REDACTED]' },
  { kind: 'billing_identifier', severity: 'redact', regex: /\b(billing\s+account(?:\s+(?:number|no\.?|id))?\s*[:#=-]\s*)[A-Z0-9][A-Z0-9_-]{4,}\b/gi, replacement: '$1[BILLING_ID_REDACTED]' },
  { kind: 'invoice_identifier', severity: 'redact', regex: /\b(invoice(?:\s+(?:number|no\.?|id))?\s*[:#=-]\s*)[A-Z0-9][A-Z0-9_-]{4,}\b/gi, replacement: '$1[INVOICE_ID_REDACTED]' },
  { kind: 'sensitive_financial_value', severity: 'redact', regex: /\b(negotiated\s+(?:discount\s+)?rates?|discount\s+rate|contract\s+value|edp\s+pricing)\b([^\n]{0,48}?)(?:[$€£]\s?\d[\d,.]*|\d+(?:\.\d+)?\s*%)/gi, replacement: '$1$2[FINANCIAL_VALUE_REDACTED]' }
];

type FindingAccumulator = Map<EvidencePrivacyFindingKind, {
  severity: 'redact' | 'block';
  count: number;
  sourceIds: Set<string>;
}>;

const sanitizeText = (value: string, sourceId: string, findings: FindingAccumulator): string => {
  let sanitized = value;
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    const matches = sanitized.match(pattern.regex);
    if (!matches?.length) continue;
    const current = findings.get(pattern.kind) || {
      severity: pattern.severity,
      count: 0,
      sourceIds: new Set<string>()
    };
    current.count += matches.length;
    current.sourceIds.add(sourceId);
    findings.set(pattern.kind, current);
    sanitized = sanitized.replace(pattern.regex, pattern.replacement);
  }
  return sanitized;
};

const applyKnownRedactions = (value: string): string => PATTERNS.reduce((sanitized, pattern) => {
  pattern.regex.lastIndex = 0;
  return sanitized.replace(pattern.regex, pattern.replacement);
}, value);

const containsProhibitedRawValue = (value: string): boolean => PATTERNS.some(pattern => {
  pattern.regex.lastIndex = 0;
  return pattern.regex.test(value);
});

export const sanitizeEvidenceSources = (sources: SourceRecord[]): {
  sources: SourceRecord[];
  decision: EvidencePrivacyDecision;
} => {
  const findings: FindingAccumulator = new Map();
  let scannedTextUnitCount = 0;
  let scannedTableCellCount = 0;

  const sanitizedSources = sources.map(source => {
    const sanitizedText = source.text === undefined
      ? undefined
      : (scannedTextUnitCount++, sanitizeText(source.text, source.source_id, findings));
    const sanitizedPages = source.pages?.map(page => {
      scannedTextUnitCount++;
      return { ...page, text: sanitizeText(page.text, source.source_id, findings) };
    });
    const table = source.structured_table;
    const completeRows = table?.analysis_rows || table?.rows || [];
    const sanitizedCompleteRows = completeRows.map(row => row.map(cell => {
      scannedTableCellCount++;
      return sanitizeText(cell, source.source_id, findings);
    }));
    const sanitizedTable = table ? {
      ...table,
      headers: table.headers.map(header => {
        scannedTableCellCount++;
        return sanitizeText(header, source.source_id, findings);
      }),
      rows: table.rows.map(row => row.map(applyKnownRedactions)),
      analysis_rows: table.analysis_rows ? sanitizedCompleteRows : undefined
    } : undefined;
    return {
      ...source,
      text: sanitizedText,
      pages: sanitizedPages,
      structured_table: sanitizedTable
    };
  });

  const residual = sanitizedSources.some(source =>
    (source.text !== undefined && containsProhibitedRawValue(source.text))
    || Boolean(source.pages?.some(page => containsProhibitedRawValue(page.text)))
    || Boolean(source.structured_table && [
      ...source.structured_table.headers,
      ...source.structured_table.rows.flat(),
      ...(source.structured_table.analysis_rows?.flat() || [])
    ].some(containsProhibitedRawValue))
  );
  const blockingKinds = [...findings.entries()]
    .filter(([, finding]) => finding.severity === 'block')
    .map(([kind]) => kind);
  const blockingCodes = [
    ...blockingKinds.map(kind => `PROHIBITED_${kind.toUpperCase()}_DETECTED`),
    ...(residual ? ['POST_REDACTION_SCAN_FAILED'] : [])
  ];
  const redactionCount = [...findings.values()]
    .filter(finding => finding.severity === 'redact')
    .reduce((sum, finding) => sum + finding.count, 0);

  return {
    sources: sanitizedSources,
    decision: {
      schema_version: 'evidence_privacy_decision_v1',
      policy_version: 'deterministic_evidence_privacy_v1',
      decision: blockingCodes.length > 0
        ? 'BLOCK'
        : redactionCount > 0
          ? 'PASS_WITH_REDACTIONS'
          : 'PASS',
      scanned_source_count: sources.length,
      scanned_text_unit_count: scannedTextUnitCount,
      scanned_table_cell_count: scannedTableCellCount,
      redaction_count: redactionCount,
      findings: [...findings.entries()].map(([kind, finding]) => ({
        kind,
        severity: finding.severity,
        count: finding.count,
        source_ids: [...finding.sourceIds].sort()
      })),
      blocking_codes: blockingCodes
    }
  };
};

export const assertDeterministicEgressText = (values: string[]): void => {
  if (values.some(containsProhibitedRawValue)) throw new Error('DETERMINISTIC_EGRESS_SCAN_FAILED');
};
