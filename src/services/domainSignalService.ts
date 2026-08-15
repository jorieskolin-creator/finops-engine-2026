import type { AuditItem, DiagnosticResult } from '../types';
import { BATCH_TITLES, MASTER_BINGO_FINOPS } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';

export type DomainSignalTone = 'green' | 'yellow' | 'red' | 'grey';

export interface DomainSignalRow {
  domain: string;
  title: string;
  maturityPercent: number;
  antiPatternPercent: number;
  maturityTone: DomainSignalTone;
  antiPatternTone: DomainSignalTone;
  maturityAssessed: number;
  maturityTotal: number;
  antiPatternTotal: number;
  antiPatternFindings: number;
  antiPatternPartialFindings: number;
  antiPatternTestedAbsent: number;
  antiPatternNotAssessed: number;
  evidencePercent: number;
  coverageNote?: string;
}

const BATCHES = Object.keys(BATCH_TITLES);

const clampScore = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 3);
};

const maturityItemAssessed = (item: AuditItem | undefined): boolean => {
  if (!item || item.is_silent || item.verification_unresolved) return false;
  if ((item.evidence_quotes?.length ?? 0) > 0) return true;
  if (item.count > 0) return true;
  return item.evidence_check_status === 'supported' || item.evidence_check_status === 'weak';
};

const maturityTone = (percent: number, assessed: number, total: number): DomainSignalTone => {
  if (assessed === 0 || assessed / Math.max(total, 1) < 0.6) return 'grey';
  if (percent >= 70) return 'green';
  if (percent >= 40) return 'yellow';
  return 'red';
};

const antiPatternTone = (percent: number, notAssessed: number, total: number): DomainSignalTone => {
  if (total > 0 && notAssessed / total >= 0.6) return 'grey';
  if (percent <= 10) return 'green';
  if (percent <= 30) return 'yellow';
  return 'red';
};

export const computeDomainSignalRows = (result: DiagnosticResult): DomainSignalRow[] => (
  BATCHES.map(domain => {
    const maturityCriteria = MASTER_BINGO_FINOPS.maturity.filter(item => item.batch === domain);
    const antiPatternCriteria = MASTER_BINGO_FINOPS.antipattern.filter(item => item.batch === domain);

    const maturityItems = maturityCriteria.map(criteria => result.phase_1_audit_logs.maturity[criteria.id]);
    const maturityTotal = maturityCriteria.length;
    const maturityAssessed = maturityItems.filter(maturityItemAssessed).length;
    const maturityScore = maturityItems.reduce((sum, item) => sum + (maturityItemAssessed(item) ? clampScore(item?.count) : 0), 0);
    const maturityPercent = maturityAssessed > 0 ? Math.round((maturityScore / (maturityAssessed * 3)) * 100) : 0;

    let antiPatternFindingWeight = 0;
    let antiPatternFindings = 0;
    let antiPatternPartialFindings = 0;
    let antiPatternTestedAbsent = 0;
    let antiPatternNotAssessed = 0;

    for (const criteria of antiPatternCriteria) {
      const item = result.phase_1_audit_logs.antipattern[criteria.id];
      if (item?.verification_unresolved) {
        antiPatternNotAssessed += 1;
        continue;
      }
      const status = inferAntiPatternAbsenceStatus(item);
      if (status === 'confirmed_present') {
        antiPatternFindingWeight += 1;
        antiPatternFindings += 1;
      } else if (status === 'partially_present') {
        antiPatternFindingWeight += 0.5;
        antiPatternPartialFindings += 1;
      } else if (status === 'tested_absent') {
        antiPatternTestedAbsent += 1;
      } else {
        antiPatternNotAssessed += 1;
      }
    }

    const antiPatternTotal = antiPatternCriteria.length;
    const antiPatternPercent = antiPatternTotal > 0
      ? Math.round((antiPatternFindingWeight / antiPatternTotal) * 100)
      : 0;
    const notAssessedShare = antiPatternTotal > 0 ? antiPatternNotAssessed / antiPatternTotal : 0;
    const evidencePercent = maturityTotal + antiPatternTotal > 0
      ? Math.round(((maturityAssessed + antiPatternTotal - antiPatternNotAssessed) / (maturityTotal + antiPatternTotal)) * 100)
      : 0;

    return {
      domain,
      title: BATCH_TITLES[domain] || domain,
      maturityPercent,
      antiPatternPercent,
      maturityTone: maturityTone(maturityPercent, maturityAssessed, maturityTotal),
      antiPatternTone: antiPatternTone(antiPatternPercent, antiPatternNotAssessed, antiPatternTotal),
      maturityAssessed,
      maturityTotal,
      antiPatternTotal,
      antiPatternFindings,
      antiPatternPartialFindings,
      antiPatternTestedAbsent,
      antiPatternNotAssessed,
      evidencePercent,
      coverageNote: notAssessedShare >= 0.4
        ? 'Anti-pattern absence is not fully assessable from source coverage.'
        : undefined
    };
  })
);
