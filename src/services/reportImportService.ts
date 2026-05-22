import type { DiagnosticResult } from '../types';

export type ReportImportResult =
  | { kind: 'report'; result: DiagnosticResult }
  | { kind: 'not_report' }
  | { kind: 'invalid_report'; error: string };

export const isDiagnosticResultPayload = (payload: unknown): payload is DiagnosticResult => {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<DiagnosticResult>;
  return Boolean(
    value.meta &&
    value.phase_1_audit_logs &&
    value.phase_2_validation &&
    value.phase_3_strategy &&
    value.quality_gate
  );
};

const FINOPS_DATA_SCRIPT_RE = /<script\b(?=[^>]*\bid\s*=\s*["']finops-data["'])[^>]*>([\s\S]*?)<\/script>/i;

export const parseDiagnosticResultJson = (jsonText: string): ReportImportResult => {
  try {
    const parsed = JSON.parse(jsonText);
    if (!isDiagnosticResultPayload(parsed)) {
      return { kind: 'invalid_report', error: 'The embedded FinOps report payload is incomplete or incompatible.' };
    }
    return { kind: 'report', result: parsed };
  } catch {
    return { kind: 'invalid_report', error: 'The embedded FinOps report payload could not be parsed.' };
  }
};

export const extractDiagnosticResultFromHtmlReport = (html: string): ReportImportResult => {
  const match = html.match(FINOPS_DATA_SCRIPT_RE);
  if (!match) return { kind: 'not_report' };
  return parseDiagnosticResultJson(match[1].trim());
};

export const serializeDiagnosticResultForHtml = (result: DiagnosticResult): string =>
  JSON.stringify(result)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
