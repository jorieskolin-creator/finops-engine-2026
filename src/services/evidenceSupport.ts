import type {
  AntiPatternAbsenceStatus,
  AuditItem,
  EvidenceCheckStatus,
  EvidenceQuote,
  SourceChunk,
  SourcePacketManifestItem,
  DerivedAnalyticalEvidence,
} from '../types';

const EVIDENCE_CHECK_STATUSES: EvidenceCheckStatus[] = ['supported', 'weak', 'unsupported', 'missing'];
const ANTIPATTERN_ABSENCE_STATUSES: AntiPatternAbsenceStatus[] = ['confirmed_present', 'partially_present', 'tested_absent', 'unknown_absent'];

const clampScore = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 3);
};

export const normalizeEvidenceText = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

export const isEvidenceQuoteBoundToChunk = (
  quote: Partial<EvidenceQuote>,
  manifestItem: SourcePacketManifestItem | undefined,
  chunk: SourceChunk | undefined,
): boolean => Boolean(
  quote.chunk_id
  && quote.source_id
  && typeof quote.quote === 'string'
  && manifestItem
  && chunk
  && quote.source_id === manifestItem.source_id
  && quote.page_id === manifestItem.page_id
  && quote.page_number === manifestItem.page_number
  && quote.sheet_name === manifestItem.sheet_name
  && quote.row_number === manifestItem.row_number
  && normalizeEvidenceText(quote.quote).length >= 4
  && normalizeEvidenceText(chunk.text).includes(normalizeEvidenceText(quote.quote))
);

export const isEvidenceQuoteBoundToDerivedEvidence = (
  quote: Partial<EvidenceQuote>,
  evidence: DerivedAnalyticalEvidence | undefined,
  stream: 'maturity' | 'antipattern',
  criterionId: string,
): boolean => Boolean(
  quote.evidence_source === 'derived'
  && quote.derived_evidence_id
  && quote.source_id
  && typeof quote.quote === 'string'
  && evidence
  && evidence.mode === 'authoritative'
  && evidence.report_eligible
  && evidence.eligibility.state === 'ELIGIBLE'
  && quote.derived_evidence_id === evidence.evidence_id
  && quote.source_id === evidence.source_id
  && evidence.targets.some(target => target.stream === stream && target.criterion_id === criterionId)
  && normalizeEvidenceText(quote.quote).length >= 4
  && evidence.summary_lines.some(line => normalizeEvidenceText(line) === normalizeEvidenceText(quote.quote!))
);

export const isValidEvidenceVerifierItem = (input: {
  raw: any;
  stream: 'maturity' | 'antipattern';
  scannerCount: number;
  duplicate: boolean;
}): boolean => {
  const { raw, stream, scannerCount, duplicate } = input;
  if (!raw || typeof raw !== 'object' || duplicate) return false;
  if (!EVIDENCE_CHECK_STATUSES.includes(raw.status)) return false;
  if (!Number.isInteger(raw.original_count) || raw.original_count !== scannerCount) return false;
  if (!Number.isInteger(raw.verified_count) || raw.verified_count < 0 || raw.verified_count > scannerCount) return false;
  if (typeof raw.rationale !== 'string' || raw.rationale.trim().length === 0) return false;
  if (typeof raw.quote_supported !== 'boolean' || typeof raw.rescan_recommended !== 'boolean') return false;
  if (stream === 'maturity') return true;
  if (!ANTIPATTERN_ABSENCE_STATUSES.includes(raw.antipattern_absence_status)) return false;
  if (raw.antipattern_absence_status === 'confirmed_present' && raw.verified_count === 0) return false;
  if (raw.antipattern_absence_status === 'tested_absent' && (scannerCount !== 0 || raw.verified_count !== 0 || raw.status !== 'supported')) return false;
  if (raw.antipattern_absence_status === 'unknown_absent' && raw.verified_count !== 0) return false;
  if (
    (raw.antipattern_absence_status === 'tested_absent' || raw.antipattern_absence_status === 'unknown_absent')
    && (typeof raw.coverage_reason !== 'string' || raw.coverage_reason.trim().length === 0)
  ) return false;
  return true;
};

export const verifyTextEvidenceSupport = (item: Partial<AuditItem> | undefined, sourceText: string): EvidenceCheckStatus => {
  const count = clampScore(item?.count);
  if (count === 0) return 'supported';

  const quotes = Array.isArray(item?.evidence_quotes) ? item.evidence_quotes : [];
  const textQuotes = quotes.filter(q => q && q.evidence_source !== 'image' && typeof q.quote === 'string' && q.quote.trim().length > 0);
  const imageQuotes = quotes.filter(q => q?.evidence_source === 'image');

  if (textQuotes.length === 0) {
    return imageQuotes.length > 0 ? 'supported' : 'missing';
  }

  const normalizedSource = normalizeEvidenceText(sourceText);
  for (const q of textQuotes) {
    const quote = normalizeEvidenceText(q.quote);
    if (quote.length >= 4 && normalizedSource.includes(quote)) return 'supported';

    const meaningfulWords = quote
      .split(/\W+/)
      .filter(w => w.length > 3)
      .slice(0, 12);
    if (meaningfulWords.length >= 4) {
      const found = meaningfulWords.filter(w => normalizedSource.includes(w)).length;
      if (found / meaningfulWords.length >= 0.65) return 'weak';
    }
  }

  return 'unsupported';
};
