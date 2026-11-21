import type { DiagnosticResult } from '../types';
import { FINOPS_CRITERIA, FINOPS_ANTIPATTERNS, FINOPS_TACTICS_LOCAL } from '../knowledge_base';
import { formatReaderParagraph, type ReaderCriterion } from './reportTextService';

export function createReportNarrative(result: DiagnosticResult) {
  const criteria = new Map<string, ReaderCriterion>();
  const records = result.phase_2_validation?.resolution_maturity?.criterion_resolutions || [];
  for (const stream of ['maturity', 'antipattern'] as const) {
    const registry = stream === 'maturity' ? FINOPS_CRITERIA : FINOPS_ANTIPATTERNS;
    for (const { id, title } of registry) {
      const resolution = records.find(r => r.stream === stream && r.criterion_id === id);
      const item = result.phase_1_audit_logs?.[stream]?.[id];
      const resolved = resolution?.state === 'RESOLVED';
      const status = resolved
        ? resolution.antipattern_absence_status?.replace(/_/g, ' ') || `assessed ${resolution.score_count}/3`
        : resolution || item?.assessment_status === 'not_assessed' ? 'not assessed' : undefined;
      const locators = new Set<string>();
      if (resolved) for (const quote of item?.evidence_quotes || []) {
        const location = quote.derived_evidence_id || quote.chunk_id || quote.page_id;
        if (location && quote.source_id && quote.quote?.trim()) locators.add(`${quote.source_id}/${location}`);
      }
      criteria.set(stream === 'maturity' ? id : 'AP-' + id, { title, status, locators: locators.size === 1 ? [...locators] : [] });
    }
  }
  const tactics = new Set(FINOPS_TACTICS_LOCAL.map(tactic => tactic.id));
  return (text: string) => formatReaderParagraph(text, criteria, tactics);
}
