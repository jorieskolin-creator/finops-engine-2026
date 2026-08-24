import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { coefficientOfVariation, relativeChange } from '../stats';
import { magnitudeBand, persistenceBand, variabilityBand } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { detectTrendSeries, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor, analysisRows } from '../shape';

const alignedCount = (points: number[]): number => {
  if (points.length < 2) return 0;
  const overall = Math.sign(relativeChange(points));
  const window = points.slice(-6);
  const deltas = window.slice(1).map((value, index) => value - window[index]);
  if (overall === 0) return deltas.filter(delta => Math.abs(delta) < Math.abs(window[0] || 1) * 0.05 || delta === 0).length;
  return deltas.filter(delta => Math.sign(delta) === overall || Math.sign(delta) === 0).length;
};

export const analyzeTrendTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
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
        analyzerId: 'trend_v1',
        analyzerVersion: '1.0.0',
        method: 'trend_analysis',
        calculationIds: ['direction', 'magnitude_band', 'persistence'],
        sourceId: source.source_id,
        targets: series.targets,
        result: baseResult('NO_STATISTICALLY_USABLE_POPULATION', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
          withheld_source_row_count: table.hidden_row_count || 0,
          withheld_source_column_count: table.hidden_column_count || 0,
          trend: { direction: 'NO_MATERIAL_TREND', magnitude_band: 'LT_5_PERCENT', persistence: 'SINGLE_PERIOD', variation: 'LOW' },
        }),
        summaryLines: [
          `${series.name} trend: NO_STATISTICALLY_USABLE_POPULATION; n below 6.`,
          'Exact slope and observations are LOCAL_ONLY.',
        ],
        locator: locatorFor(table),
        eligibilityReasons: [...reasons, 'NO_STATISTICALLY_USABLE_POPULATION'],
        fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, name: series.name, n }),
        quality: qualityFor(n, !truncated, 'Fewer than 6 observations; no direction is claimed.'),
        mayUseAsEvidence: false,
      })];
    }
    const relative = relativeChange(series.points);
    const magnitude = magnitudeBand(relative);
    const variability = variabilityBand(coefficientOfVariation(series.points));
    const persistence = persistenceBand(alignedCount(series.points), n);
    const direction = magnitude === 'LT_5_PERCENT'
      ? 'NO_MATERIAL_TREND' as const
      : relative > 0
        ? (series.higherIs === 'better' ? 'IMPROVING' as const : 'DETERIORATING' as const)
        : (series.higherIs === 'better' ? 'DETERIORATING' as const : 'IMPROVING' as const);
    return [buildDerived({
      analyzerId: 'trend_v1',
      analyzerVersion: '1.0.0',
      method: 'trend_analysis',
      calculationIds: ['direction', 'magnitude_band', 'persistence'],
      sourceId: source.source_id,
      targets: series.targets,
      result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
        withheld_source_row_count: table.hidden_row_count || 0,
        withheld_source_column_count: table.hidden_column_count || 0,
        trend: { direction, magnitude_band: magnitude, persistence, variation: variability },
      }),
      summaryLines: [
        `${series.name} trend: direction=${direction}; magnitude_band=${magnitude}; persistence=${persistence}; variation=${variability}.`,
        'Exact slope, mean, and observations are LOCAL_ONLY and must not be recalculated.',
      ],
      locator: locatorFor(table),
      eligibilityReasons: reasons,
      fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, name: series.name, direction, magnitude, persistence }),
      quality: qualityFor(n, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
    })];
  });
