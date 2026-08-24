import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { median, medianGap } from '../stats';
import { agingBand, cadenceBand, coverageBand } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectProcess, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeProcessTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const detected = detectProcess(table);
    if (!detected || detected.eligible === 0) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    const closurePercent = Math.round((detected.closed / detected.eligible) * 100);
    const ownerlessPercent = detected.ownerless === null ? null : Math.round((detected.ownerless / detected.eligible) * 100);
    const medianAge = detected.openAges.length ? median(detected.openAges) : null;
    const cadence = cadenceBand(medianGap(detected.timestamps) === null ? null : (medianGap(detected.timestamps) as number) / 86400000);
    return [buildDerived({
      analyzerId: 'process_v1',
      analyzerVersion: '1.0.0',
      method: 'process_analysis',
      calculationIds: ['cadence', 'closure', 'aging'],
      sourceId: source.source_id,
      targets: detected.targets,
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, detected.eligible, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        process: {
          cadence,
          closure_band: coverageBand(closurePercent),
          aging_band: agingBand(medianAge),
          ownerless_band: ownerlessPercent === null ? 'NOT_AVAILABLE' : coverageBand(ownerlessPercent),
          recurrence: detected.recurrence ? 'PRESENT' : 'NONE',
        },
      }),
      summaryLines: [
        `Process execution: cadence=${cadence}; closure_band=${coverageBand(closurePercent)}; aging_band=${agingBand(medianAge)}; ownerless=${ownerlessPercent === null ? 'NOT_AVAILABLE' : coverageBand(ownerlessPercent)}; recurrence=${detected.recurrence ? 'PRESENT' : 'NONE'}.`,
        'Exact timestamps and owner names are withheld.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, cadence, closurePercent, aging: agingBand(medianAge), recurrence: detected.recurrence }),
      quality: qualityFor(detected.eligible, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
