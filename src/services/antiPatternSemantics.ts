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

const stripNegatedPresenceSpans = (clause: string): string =>
  clause
    .replace(/\bfinal anti-pattern assessment:\s*(?:tested absent|not assessed)\b/g, ' ')
    .replace(/\b(?:packet\s+)?coverage\s+is\s+(?:not\s+)?weak\b/g, ' ')
    .replace(/\bweak\s+(?:packet|source|routing)\s+coverage\b/g, ' ')
    .replace(/\b(?:no|not|neither|never|without|zero|lacks?|refutes?|contradicts?|absent)\b[^,;]{0,45}\b(?:weak\s+or\s+partial|partial\s+or\s+weak|partial|weak)\b[^,;]{0,65}/g, ' ')
    .replace(/\b(?:partial|weak)\b[^,;]{0,65}\b(?:is\s+not|are\s+not|was\s+not|were\s+not|not\s+present|not\s+found|not\s+detected|not\s+evidenced|absent)\b/g, ' ');

export const hasAntiPatternPresenceSignal = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const raw = value.toLowerCase().trim();
  if (!raw) return false;
  const phrases = [
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
  ];
  const pattern = /\b(partial|weak)\b.{0,80}\b(anti-pattern|harmful|signal|finding|presence|present|evidence|cost-blind|tunnel vision|monolith|server-hugging|it['’]?s problem)\b/;
  return raw.split(/[.!?;]+/).some(sentence => {
    const cleaned = stripNegatedPresenceSpans(sentence).trim();
    if (!cleaned) return false;
    return phrases.some(phrase => cleaned.includes(phrase)) || pattern.test(cleaned);
  });
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
  if (item?.assessment_status === 'not_assessed' || item?.antipattern_absence_status === 'unknown_absent') return 'unknown_absent';
  const count = typeof item?.count === 'number' ? Math.max(0, Math.min(3, Math.round(item.count))) : 0;
  if (count >= 3) return 'confirmed_present';
  if (count > 0) return 'partially_present';

  const explicit = normalizeAntiPatternAbsenceStatus(item?.antipattern_absence_status);
  const text = `${item?.coverage_reason || ''} ${item?.reasoning || ''}`.toLowerCase();
  const notAssessedText = /\bfinal anti-pattern assessment:\s*not assessed\b|\binsufficient to (?:verify|prove|establish) absence\b|\bcannot (?:be )?(?:confirm|verify|prove|establish)(?:ed)? (?:from silence|absence)\b/.test(text);

  // Preserve the Evidence Check invariant: when the scanner found 0/3 and
  // verified count is 0/3, verifier wording cannot manufacture a partial finding.
  if (typeof item?.original_count === 'number' && Math.round(item.original_count) === 0 && count === 0) {
    if (notAssessedText) return 'unknown_absent';
    return (
      explicit === 'tested_absent'
      && (item?.evidence_check_status === undefined || item?.evidence_check_status === 'supported')
      && typeof item?.coverage_reason === 'string'
      && item.coverage_reason.trim().length > 0
    ) ? 'tested_absent' : 'unknown_absent';
  }

  if (explicit === 'confirmed_present' || explicit === 'partially_present') return explicit;

  if (hasAntiPatternPresenceSignal(text)) return 'partially_present';
  if (notAssessedText) return 'unknown_absent';
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
