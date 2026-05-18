import type { FactCheckClaim, QualityGateResult } from '../types';

export const scannerEvidenceCheckDisagreementTitle = 'Scanner/evidence-check disagreement resolved by downgrade';
export const strategyHygieneNotesTitle = 'Strategy Hygiene Notes';

const phase1ScannerDisagreementPattern = /^Phase 1: (maturity|antipattern)\.[A-E][1-5]: Score 0 but evidence does not indicate silence$/;
const strategyHygienePatterns = [
  /^Strategy hygiene:/,
  /^Roadmap tactic grounding /,
  /^Roadmap grounding removed /,
  /^Strategy contains \d+ actions with no tactic IDs\./
];

export interface QualityGateDiagnosticsSplit {
  primaryWarnings: string[];
  appendixDiagnostics: string[];
}

export const isScannerEvidenceCheckDisagreement = (warning: string): boolean =>
  phase1ScannerDisagreementPattern.test(warning);

export const isStrategyHygieneDiagnostic = (warning: string): boolean =>
  strategyHygienePatterns.some(pattern => pattern.test(warning));

export const displayQualityGateDiagnostic = (warning: string): string =>
  isScannerEvidenceCheckDisagreement(warning)
    ? `${scannerEvidenceCheckDisagreementTitle}: ${warning.replace(/^Phase 1: /, '')}`
    : isStrategyHygieneDiagnostic(warning)
      ? `${strategyHygieneNotesTitle}: ${warning.replace(/^Strategy hygiene:\s*/, '')}`
    : warning;

export const splitQualityGateDiagnostics = (gate: QualityGateResult): QualityGateDiagnosticsSplit => {
  const primaryWarnings: string[] = [];
  const appendixDiagnostics: string[] = [];

  for (const warning of gate.warnings) {
    if (isScannerEvidenceCheckDisagreement(warning) || isStrategyHygieneDiagnostic(warning)) appendixDiagnostics.push(warning);
    else primaryWarnings.push(warning);
  }

  return { primaryWarnings, appendixDiagnostics };
};

const hygieneMissingMaterialTerms = [
  'revised wording',
  'rewording',
  'source attribution',
  'criterion mapping',
  'confirmed anti-pattern finding',
  'valid tactic',
  'tactic id',
  'tactic ids',
  'verified tactic',
  'tactics db',
  'kb-mapping',
  'kb mapping',
  'mechanism match',
  'removal of',
  'assigning it to domain'
];

export const isReportableSourceCoverageGap = (claim: FactCheckClaim): boolean => {
  if (!claim.missing_material) return false;
  if (claim.severity === 'WARN_MISCLASSIFIED_BUT_REAL' || claim.severity === 'WARN_TACTIC_HYGIENE') return false;
  if (claim.source_location === 'planning_decision' || claim.source_location === 'roadmap') return false;
  const material = claim.missing_material.toLowerCase();
  return !hygieneMissingMaterialTerms.some(term => material.includes(term));
};
