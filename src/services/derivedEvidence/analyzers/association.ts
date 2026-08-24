import type { DerivedAnalyticalEvidence, SourceRecord } from '../../../types';
import { pearson } from '../stats';
import { associationStrength } from '../banding';
import { baseResult, buildDerived, qualityFor } from '../object';
import { analysisRows, detectAssociationPairs, locatorFor, tableEligibilityReasons, tableRowScope, tablesFor } from '../shape';

export const analyzeAssociationTable = (source: SourceRecord): DerivedAnalyticalEvidence[] =>
  tablesFor(source).flatMap(table => {
    const pairs = detectAssociationPairs(table);
    if (pairs.length === 0) return [];
    const rows = analysisRows(table);
    const scope = tableRowScope(table, rows);
    const reasons = tableEligibilityReasons(table, rows);
    const truncated = scope === 'bounded_prefix' || table.analysis_complete === false;
    return pairs.flatMap(pair => {
      const n = pair.left.length;
      if (n < pair.min_observations) {
        return [buildDerived({
          analyzerId: 'association_v1',
          analyzerVersion: '1.0.0',
          method: 'association_analysis',
          calculationIds: ['association_direction', 'association_strength'],
          sourceId: source.source_id,
          targets: pair.targets,
          result: baseResult('NO_STATISTICALLY_USABLE_POPULATION', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
            withheld_source_row_count: table.hidden_row_count || 0,
            withheld_source_column_count: table.hidden_column_count || 0,
            association: {
              pair_id: pair.pair_id,
              association_direction: 'NONE',
              association_strength: 'NO_MATERIAL_ASSOCIATION',
              causal_authority: 'NONE',
            },
          }),
          summaryLines: [
            `Association ${pair.pair_id}: NO_STATISTICALLY_USABLE_POPULATION; n below ${pair.min_observations}.`,
            'causal_authority=NONE. Exact correlation is LOCAL_ONLY.',
          ],
          locator: locatorFor(table),
          eligibilityReasons: [...reasons, 'NO_STATISTICALLY_USABLE_POPULATION'],
          fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, pair: pair.pair_id, n }),
          quality: qualityFor(n, !truncated, 'Fewer than the registered minimum paired observations.'),
          mayUseAsEvidence: false,
        })];
      }
      const r = pearson(pair.left, pair.right);
      if (r === null) return [];
      const strength = associationStrength(r);
      const direction = strength === 'NO_MATERIAL_ASSOCIATION'
        ? 'NONE' as const
        : r > 0 ? 'POSITIVE' as const : 'NEGATIVE' as const;
      return [buildDerived({
        analyzerId: 'association_v1',
        analyzerVersion: '1.0.0',
        method: 'association_analysis',
        calculationIds: ['association_direction', 'association_strength'],
        sourceId: source.source_id,
        targets: pair.targets,
        result: baseResult('OBSERVED', table.source_total_row_count ?? table.total_row_count, n, scope, truncated, {
          withheld_source_row_count: table.hidden_row_count || 0,
          withheld_source_column_count: table.hidden_column_count || 0,
          association: {
            pair_id: pair.pair_id,
            association_direction: direction,
            association_strength: strength,
            causal_authority: 'NONE',
          },
        }),
        summaryLines: [
          `Association ${pair.pair_id}: direction=${direction}; strength=${strength}; causal_authority=NONE.`,
          'Do not infer causality, drivers, or exact correlation from this band.',
        ],
        locator: locatorFor(table),
        eligibilityReasons: reasons,
        fingerprintSeed: JSON.stringify({ sheet: table.sheet_name, pair: pair.pair_id, direction, strength }),
        quality: qualityFor(n, !truncated, truncated ? 'Bounded prefix is not full-population evidence.' : null),
      })];
    });
  });
