import type { AntiPatternAbsenceStatus, AuditItem } from '../types';

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

export const inferAntiPatternAbsenceStatus = (item: Partial<AuditItem> | undefined): AntiPatternAbsenceStatus => {
  const count = typeof item?.count === 'number' ? Math.max(0, Math.min(3, Math.round(item.count))) : 0;
  if (count >= 3) return 'confirmed_present';
  if (count > 0) return 'partially_present';

  const explicit = normalizeAntiPatternAbsenceStatus(item?.antipattern_absence_status);
  if (explicit === 'tested_absent' || explicit === 'unknown_absent') return explicit;

  const hasCoverageEvidence = Array.isArray(item?.evidence_quotes) && item.evidence_quotes.length > 0;
  return hasCoverageEvidence ? 'tested_absent' : 'unknown_absent';
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
