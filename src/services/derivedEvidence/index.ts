import type { DerivedAnalyticalEvidence, SourceRecord, SourceRegistry } from '../../types';
import { analyzeStructuredSources } from '../structuredDataAnalysisService';
import { analyzeCrucialItemCoverage, type CoverageLocationMap } from './coverageAnalyzer';
import { analyzeTrendTable } from './analyzers/trend';
import { analyzeVariationTable } from './analyzers/variation';
import { analyzeConcentrationTable } from './analyzers/concentration';
import { analyzeAdoptionTable } from './analyzers/adoption';
import { analyzeProcessTable } from './analyzers/process';
import { analyzeConsistency } from './analyzers/consistency';
import { analyzeExceptionTable } from './analyzers/exception';
import { analyzeAssociationTable } from './analyzers/association';
import { aliasRetrySource } from './aliasRetry';

const STAT_ANALYZERS = new Set([
  'trend_v1',
  'variation_v1',
  'concentration_v1',
  'adoption_v1',
  'process_v1',
  'exception_v1',
  'association_v1',
]);

const shapedFrom = (source: SourceRecord): DerivedAnalyticalEvidence[] => [
  ...analyzeTrendTable(source),
  ...analyzeVariationTable(source),
  ...analyzeConcentrationTable(source),
  ...analyzeAdoptionTable(source),
  ...analyzeProcessTable(source),
  ...analyzeExceptionTable(source),
  ...analyzeAssociationTable(source),
];

const shapedWithAliasRetry = (source: SourceRecord): DerivedAnalyticalEvidence[] => {
  const first = shapedFrom(source);
  if (first.some(item => STAT_ANALYZERS.has(item.derivation.analyzer_id))) return first;
  const retried = aliasRetrySource(source);
  return retried ? shapedFrom(retried) : first;
};

export const deriveAllEvidenceSignals = (
  sources: SourceRecord[],
  registry?: SourceRegistry
): { evidence: DerivedAnalyticalEvidence[]; locations: CoverageLocationMap } => {
  const coverage = analyzeCrucialItemCoverage(sources, registry);
  const shaped = sources.flatMap(shapedWithAliasRetry);
  return {
    evidence: [...analyzeStructuredSources(sources), ...coverage.evidence, ...shaped, ...analyzeConsistency(sources)],
    locations: coverage.locations,
  };
};
