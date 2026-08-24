import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { herfindahlHirschman } from '../stats';
import { concentrationBandFromHhi } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectConcentration, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeConcentrationTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const detected = detectConcentration(table);
    if (!detected) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    const hhi = herfindahlHirschman(detected.weights);
    const band = concentrationBandFromHhi(hhi);
    const total = detected.weights.reduce((sum, value) => sum + value, 0);
    const minShare = total > 0 ? Math.min(...detected.weights) / total : 0;
    const lowest = minShare >= 0.05 ? 'MATERIAL' as const : 'IMMATERIAL' as const;
    const distribution = band === 'EVEN' ? 'EVEN' as const : 'SKEWED' as const;
    return [buildDerived({
      analyzerId: 'concentration_v1',
      analyzerVersion: '1.0.0',
      method: 'concentration_analysis',
      calculationIds: ['hhi_band'],
      sourceId: source.source_id,
      targets: [{ stream: 'maturity', criterion_id: 'A1' }],
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, detected.eligible, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        concentration: {
          concentration_band: band,
          lowest_segment: lowest,
          distribution: band === 'EVEN' ? 'NO_MATERIAL_CONCENTRATION' : distribution,
        },
      }),
      summaryLines: [
        `Segment concentration: band=${band}; lowest_segment=${lowest}; distribution=${band === 'EVEN' ? 'NO_MATERIAL_CONCENTRATION' : distribution}.`,
        'Segment names and exact shares are withheld.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, band, lowest, segments: detected.weights.length }),
      quality: qualityFor(detected.eligible, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
