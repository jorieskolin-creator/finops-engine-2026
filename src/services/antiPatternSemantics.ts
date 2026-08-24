import type { AntiPatternAbsenceStatus, AuditItem, EvidenceCheckStatus } from '../types';

const STATUSES: AntiPatternAbsenceStatus[] = [
  'confirmed_present',
  'partially_present',
  'tested_absent',
  'unknown_absent'
];

export const normalizeAntiPatternAbsenceStatus = (value: unknown): AntiPatternAbsenceStatus | undefined =>
  typeof value === 'string' && STATUSES.includes(value as AntiPatternAbsenceStatus)
    ? value as AntiPatternAbsenceStatus
    : undefined;

const clampScore = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 3);
};

export const hasAntiPatternPresenceSignal = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const text = value.toLowerCase();
  if (!text.trim()) return false;
  const phraseMatch = [
    'partial finding',
    'partially present',
    'partial presence',
    'partial anti-pattern',
    'weak anti-pattern',
    'weak harmful pattern',
    'harmful pattern is evidenced',
    'harmful pattern signal',
    'supports partial',
    'suggests partial',
    'indicates partial',
    'some evidence of',
    'some related evidence'
  ].some(phrase => text.includes(phrase));
  return phraseMatch || /\b(partial|weak)\b.{0,80}\b(anti-pattern|harmful|signal|finding|presence|present|evidence|cost-blind|tunnel vision|monolith|server-hugging|it['’]?s problem)\b/.test(text);
};

export const resolveAntiPatternAbsenceStatus = (input: {
  verifiedCount: number;
  originalCount?: number;
  explicitStatus?: unknown;
  evidenceStatus?: EvidenceCheckStatus;
  existing?: Partial<AuditItem>;
  rationale?: string;
  coverageReason?: string;
}): AntiPatternAbsenceStatus => {
  const verified = clampScore(input.verifiedCount);
  const original = clampScore(input.originalCount);
  const explicit = normalizeAntiPatternAbsenceStatus(input.explicitStatus);
  const status = input.evidenceStatus;
  const combinedText = [
    input.rationale,
    input.coverageReason,
    input.existing?.coverage_reason,
    input.existing?.reasoning,
    input.existing?.evidence
  ].filter(Boolean).join(' ');

  if (verified >= 3) return 'confirmed_present';
  if (verified > 0) return 'partially_present';

  // Evidence Check cannot create a harmful finding that the scanner did not
  // identify. For a zero-score scanner result, only a governed tested-absence
  // verdict may become positive control; every other absence remains unknown.
  if (original === 0) {
    return explicit === 'tested_absent' && (status === undefined || status === 'supported')
      ? 'tested_absent'
      : 'unknown_absent';
  }

  const weakScoredSignal = original > 0 && status === 'weak';
  const explicitPresenceSignal = explicit === 'confirmed_present' || explicit === 'partially_present';
  const textualPresenceSignal = hasAntiPatternPresenceSignal(combinedText);
  if (weakScoredSignal || ((explicitPresenceSignal || textualPresenceSignal) && status !== 'unsupported' && status !== 'missing')) {
    return 'partially_present';
  }

  if (original > 0) return 'unknown_absent';
  if (explicit === 'tested_absent' && (status === undefined || status === 'supported')) return 'tested_absent';
  if (explicit === 'unknown_absent') return 'unknown_absent';

  return inferAntiPatternAbsenceStatus({
    ...input.existing,
    count: verified,
    antipattern_absence_status: undefined,
    coverage_reason: input.coverageReason || input.existing?.coverage_reason || input.rationale
  });
};

export const inferAntiPatternAbsenceStatus = (item: Partial<AuditItem> | undefined): AntiPatternAbsenceStatus => {
  const count = typeof item?.count === 'number' ? Math.max(0, Math.min(3, Math.round(item.count))) : 0;
  if (count >= 3) return 'confirmed_present';
  if (count > 0) return 'partially_present';

  const explicit = normalizeAntiPatternAbsenceStatus(item?.antipattern_absence_status);
  if (explicit === 'confirmed_present' || explicit === 'partially_present') return explicit;

  const text = `${item?.coverage_reason || ''} ${item?.reasoning || ''}`.toLowerCase();
  if (hasAntiPatternPresenceSignal(text)) return 'partially_present';
  if (text.includes('not assessed') || text.includes('insufficient to verify absence')) return 'unknown_absent';
  if (
    explicit === 'tested_absent'
    && item?.evidence_check_status === 'supported'
    && typeof item?.coverage_reason === 'string'
    && item.coverage_reason.trim().length > 0
  ) return 'tested_absent';
  if (explicit === 'unknown_absent') return 'unknown_absent';
  return 'unknown_absent';
};

export const antiPatternStatusLabel = (item: Partial<AuditItem> | undefined): string => {
  const status = inferAntiPatternAbsenceStatus(item);
  if (status === 'confirmed_present') return 'Finding';
  if (status === 'partially_present') return 'Partial finding';
  if (status === 'tested_absent') return 'Tested absent';
  return 'Not assessed';
};

export const antiPatternStatusDescription = (status: AntiPatternAbsenceStatus): string => {
  if (status === 'confirmed_present') return 'Evidence shows the anti-pattern is present.';
  if (status === 'partially_present') return 'Evidence shows a partial or weak anti-pattern signal.';
  if (status === 'tested_absent') return 'Relevant source coverage was reviewed and the anti-pattern was not found.';
  return 'The source did not provide enough relevant coverage to treat absence as positive evidence.';
};
