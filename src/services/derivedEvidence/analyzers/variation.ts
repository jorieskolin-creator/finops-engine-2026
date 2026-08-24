import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { coefficientOfVariation } from '../stats';
import { variabilityBand } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectTrendSeries, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeVariationTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const series = detectTrendSeries(table);
    if (!series) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const n = series.points.length;
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    if (n < 6) {
      return [buildDerived({
        analyzerId: 'variation_v1',
        analyzerVersion: '1.0.0',
        method: 'variation_analysis',
        calculationIds: ['variability'],
        sourceId: source.source_id,
        targets: series.targets,
        result: baseResult('NO_STATISTICALLY_USABLE_POPULATION', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
          variation: { variability: 'LOW', pattern: 'NO_MATERIAL_VARIATION' },
        }),
        summaryLines: [`${series.name} variation: NO_STATISTICALLY_USABLE_POPULATION; n below 6.`],
        locator: locatorFor(table),
        eligibilityReasons: [...reasons, 'NO_STATISTICALLY_USABLE_POPULATION'],
        fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, name: series.name, n, family: 'variation' }),
        quality: qualityFor(n, !truncated, 'Fewer than 6 observations; no variability claim.'),
        mayUseAsEvidence: false,
      })];
    }
    const variability = variabilityBand(coefficientOfVariation(series.points));
    const pattern = variability === 'LOW' ? 'STABLE' as const : variability === 'HIGH' ? 'ERRATIC' as const : 'STABLE' as const;
    return [buildDerived({
      analyzerId: 'variation_v1',
      analyzerVersion: '1.0.0',
      method: 'variation_analysis',
      calculationIds: ['variability'],
      sourceId: source.source_id,
      targets: series.targets,
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        variation: { variability, pattern: variability === 'LOW' ? 'NO_MATERIAL_VARIATION' : pattern },
      }),
      summaryLines: [
        `${series.name} variation: variability=${variability}; pattern=${variability === 'LOW' ? 'NO_MATERIAL_VARIATION' : pattern}.`,
        'Exact CV is LOCAL_ONLY.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, name: series.name, variability }),
      quality: qualityFor(n, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
