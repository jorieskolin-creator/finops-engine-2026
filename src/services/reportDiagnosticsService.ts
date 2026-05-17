import type { QualityGateResult } from '../types';

export const scannerEvidenceCheckDisagreementTitle = 'Scanner/evidence-check disagreement resolved by downgrade';

const phase1ScannerDisagreementPattern = /^Phase 1: (maturity|antipattern)\.[A-E][1-5]: Score 0 but evidence does not indicate silence$/;

export interface QualityGateDiagnosticsSplit {
  primaryWarnings: string[];
  appendixDiagnostics: string[];
}

export const isScannerEvidenceCheckDisagreement = (warning: string): boolean =>
  phase1ScannerDisagreementPattern.test(warning);

export const displayQualityGateDiagnostic = (warning: string): string =>
  isScannerEvidenceCheckDisagreement(warning)
    ? `${scannerEvidenceCheckDisagreementTitle}: ${warning.replace(/^Phase 1: /, '')}`
    : warning;

export const splitQualityGateDiagnostics = (gate: QualityGateResult): QualityGateDiagnosticsSplit => {
  const primaryWarnings: string[] = [];
  const appendixDiagnostics: string[] = [];

  for (const warning of gate.warnings) {
    if (isScannerEvidenceCheckDisagreement(warning)) appendixDiagnostics.push(warning);
    else primaryWarnings.push(warning);
  }

  return { primaryWarnings, appendixDiagnostics };
};
