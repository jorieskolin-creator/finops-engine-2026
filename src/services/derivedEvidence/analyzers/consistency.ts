import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { medianGap } from '../stats';
import { cadenceBand } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import {
  analysisRows,
  detectDeclaredCadences,
  detectProcess,
  locatorFor,
  tableEligibilityReasons,
  tableRowScope,
  tablesFor,
} from '../shape';

export const analyzeConsistency = (sources: SourceRecord[]): DerivedAnalyticalEvidence[] => {
  const declared = detectDeclaredCadences(sources);
  if (declared.length === 0) return [];
  return sources.flatMap(source => tablesFor(source).flatMap(table => {
    const process = detectProcess(table);
    if (!process || process.timestamps.length < 2) return [];
    const observed = cadenceBand(medianGap(process.timestamps) === null ? null : (medianGap(process.timestamps) as number) / 86400000);
    if (observed === 'UNKNOWN') return [];
    const match = declared.find(item => process.targets.some(target => target.criterion_id === item.criterion_id));
    if (!match) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    const aligned = match.cadence === observed;
    const agreement = aligned ? 'ALIGNED' as const : 'DIVERGENT' as const;
    const alignment = aligned ? 'CONSISTENT' as const : 'INCONSISTENT' as const;
    return [buildDerived({
      analyzerId: 'consistency_v1',
      analyzerVersion: '1.0.0',
      method: 'consistency_analysis',
      calculationIds: ['declared_vs_observed_cadence', 'agreement_state'],
      sourceId: source.source_id,
      targets: process.targets.filter(target => target.criterion_id === match.criterion_id),
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, process.eligible, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        consistency: {
          declared_cadence: match.cadence,
          observed_cadence: observed,
          agreement_state: agreement,
          policy_execution_alignment: alignment,
        },
      }),
      summaryLines: [
        `Policy vs execution cadence: declared=${match.cadence}; observed=${observed}; agreement=${agreement}; alignment=${alignment}.`,
        'This is a cadence alignment band, not a maturity score and not a causal claim.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, declared: match.cadence, observed, agreement }),
      quality: qualityFor(process.eligible, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  }));
};
