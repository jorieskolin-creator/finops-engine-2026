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

export const deriveAllEvidenceSignals = (
  sources: SourceRecord[],
  registry?: SourceRegistry
): { evidence: DerivedAnalyticalEvidence[]; locations: CoverageLocationMap } => {
  const coverage = analyzeCrucialItemCoverage(sources, registry);
  const shaped = sources.flatMap(source => [
    ...analyzeTrendTable(source),
    ...analyzeVariationTable(source),
    ...analyzeConcentrationTable(source),
    ...analyzeAdoptionTable(source),
    ...analyzeProcessTable(source),
    ...analyzeExceptionTable(source),
    ...analyzeAssociationTable(source),
  ]);
  return {
    evidence: [...analyzeStructuredSources(sources), ...coverage.evidence, ...shaped, ...analyzeConsistency(sources)],
    locations: coverage.locations,
  };
};
