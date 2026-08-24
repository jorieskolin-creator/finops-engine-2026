import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { median } from '../stats';
import { agingBand, coverageBand } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectException, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeExceptionTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const detected = detectException(table);
    if (!detected) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    const frequency = Math.round((detected.exceptionCount / detected.eligible) * 100);
    const closure = detected.closed === null || detected.exceptionCount === 0
      ? 'NOT_AVAILABLE' as const
      : coverageBand(Math.round((detected.closed / detected.exceptionCount) * 100));
    const aging = agingBand(detected.openAges.length ? median(detected.openAges) : null);
    return [buildDerived({
      analyzerId: 'exception_v1',
      analyzerVersion: '1.0.0',
      method: 'exception_profile_analysis',
      calculationIds: ['frequency', 'recurrence', 'aging', 'closure'],
      sourceId: source.source_id,
      targets: detected.targets,
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, detected.eligible, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        exception: {
          frequency_band: coverageBand(frequency),
          recurrence: detected.recurrence ? 'PRESENT' : 'NONE',
          aging_band: aging,
          closure_band: closure,
        },
      }),
      summaryLines: [
        `Registered exception profile: frequency_band=${coverageBand(frequency)}; recurrence=${detected.recurrence ? 'PRESENT' : 'NONE'}; aging_band=${aging}; closure_band=${closure}.`,
        'This is not open-ended anomaly discovery and not a spend spike hunt.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, frequency, recurrence: detected.recurrence, aging, closure }),
      quality: qualityFor(detected.eligible, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
