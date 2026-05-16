import type { AuditItem, EvidenceCheckStatus } from '../types';

const clampScore = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 3);
};

export const normalizeEvidenceText = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

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
    if (quote.length >= 8 && normalizedSource.includes(quote)) return 'supported';

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
