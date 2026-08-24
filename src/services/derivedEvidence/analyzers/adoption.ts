import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { coverageBand, organizationalReach } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectAdoption, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeAdoptionTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const detected = detectAdoption(table);
    if (!detected) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    const band = coverageBand(detected.percent);
    return [buildDerived({
      analyzerId: 'adoption_v1',
      analyzerVersion: '1.0.0',
      method: 'adoption_analysis',
      calculationIds: ['practice_presence', 'adoption_band'],
      sourceId: source.source_id,
      targets: detected.targets,
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, detected.eligible, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        adoption: {
          practice_presence: detected.present ? 'PRESENT' : 'NOT_OBSERVED',
          adoption_band: band,
          organizational_reach: organizationalReach(detected.percent),
        },
      }),
      summaryLines: [
        `Control adoption: presence=${detected.present ? 'PRESENT' : 'NOT_OBSERVED'}; adoption_band=${band}; reach=${organizationalReach(detected.percent)}.`,
        'This is eligible-population share, not a maturity score.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, band, present: detected.present, targets: detected.targets }),
      quality: qualityFor(detected.eligible, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
