import type { ClearBlockResult } from './clearBlockVerification';
import type { Comparison, Disposition } from './clearBlockNarrativeReview';

export const caseNames = {
  'clear-block': 'Clear BLOCK',
  'near-block-conditional-go': 'Near BLOCK / CONDITIONAL GO',
  'clear-warn': 'Clear WARN',
  'near-warn-conditional-go': 'Near WARN / CONDITIONAL GO',
  'clear-go': 'Clear GO candidate',
};
export type CaseId = keyof typeof caseNames;
export type Selection = CaseId | 'all';
export const caseIds = Object.keys(caseNames) as CaseId[];

interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  calls: number;
  models: string[];
}
interface CompactComparison extends Comparison {
  kbHash: string | null;
  assessed: number;
  checkIds: string[];
  usage: Usage;
}
export interface SuiteAttempt {
  ordinal: number;
  case_id: CaseId;
  repetition: number;
  run_id: string | null;
  state: 'queued' | 'running' | 'delivered' | 'incomplete';
  started_at: string | null;
  finished_at: string | null;
  cleanup_status: string | null;
  comparison: CompactComparison | null;
  review: { dispositions: Record<string, Disposition>; reviewedAt: string } | null;
}
export interface Suite {
  suite_id: string;
  state: 'running' | 'completed' | 'cancelled';
  created_at: string;
  finished_at: string | null;
  configuration: {
    build: string | null;
    routingHash: string;
    routingLabel: string;
    deepMode: boolean;
    packageVersion: string;
    models: Record<string, string[]>;
  };
  attempts: SuiteAttempt[];
}

const endpoint = '/api/golden-standard-suite';
async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint + path, { cache: 'no-store', signal: AbortSignal.timeout(45_000), ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error === 'GOLDEN_STANDARD_STATE_CONFLICT'
      ? body.error : 'GOLDEN_STANDARD_UNAVAILABLE');
  }
  return response.json();
}
export const loadSuiteHistory = () => request<Suite[]>();
export function suiteCommand<T>(action: string, suiteId: string, fields: Record<string, unknown> = {}) {
  return request<T>('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, suiteId, ...fields }) });
}

export async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export type SuiteDelivery = { comparison: Comparison; suite: Suite };
export type SuiteReport = Pick<ClearBlockResult, 'narrative' | 'summary' | 'completedAt' | 'review'> & { comparison: Comparison };

export function attemptStatus(attempt: SuiteAttempt): string {
  if (attempt.state === 'queued') return 'Queued';
  if (attempt.state === 'running') return 'Running';
  const comparison = attempt.comparison;
  if (attempt.state !== 'delivered' || !comparison) return 'Incomplete';
  const judgments = comparison.checkIds.map(id => attempt.review?.dispositions[id]);
  if (comparison.checks.some(check => check.matches === false)
    || judgments.some(value => value === 'Missing' || value === 'Contradicted')) return 'Fail';
  return comparison.referenceApproved && comparison.kbHash
    && comparison.checks.every(check => check.matches === true) && judgments.length
    && judgments.every(value => value === 'Supported') ? 'Pass' : 'Review';
}

export function suiteStatus(suite: Suite) {
  const attempts = suite.attempts.map(attemptStatus);
  if (attempts.includes('Fail')) return 'Fail';
  if (suite.state === 'running') return 'Running';
  if (suite.state === 'cancelled' || attempts.includes('Incomplete')) return 'Incomplete';
  if (!suite.configuration.build || !attempts.length || attempts.some(status => status !== 'Pass')) return 'Review';
  const kb = new Set(suite.attempts.map(attempt => attempt.comparison?.kbHash));
  if (kb.size !== 1) return 'Review';
  const perCase = caseIds.map(id => suite.attempts.filter(attempt => attempt.case_id === id)).filter(group => group.length);
  if (perCase.length !== 1 && perCase.length !== caseIds.length) return 'Review';
  const repetitions = perCase[0]?.length;
  const sameConfiguration = [1, 3].includes(repetitions) && perCase.every(group =>
    group.length === repetitions
    && new Set(group.map(attempt => attempt.comparison?.referenceSha256)).size === 1
    && new Set(group.map(attempt => JSON.stringify(attempt.comparison?.usage.models))).size === 1);
  return sameConfiguration ? 'Pass' : 'Review';
}

export function repeatability(history: Suite[], selected: Suite, current: SuiteAttempt) {
  const { build, routingHash, deepMode, packageVersion } = selected.configuration;
  const target = current.comparison;
  if (!build || !target?.kbHash) return null;
  const matches = history.flatMap(suite => {
    const config = suite.configuration;
    if (config.build !== build || config.routingHash !== routingHash || config.deepMode !== deepMode
      || config.packageVersion !== packageVersion) return [];
    return suite.attempts.filter(attempt => {
      const comparison = attempt.comparison;
      return !!comparison && attempt.case_id === current.case_id && attempt.state === 'delivered'
        && comparison.referenceSha256 === target.referenceSha256 && comparison.kbHash === target.kbHash
        && JSON.stringify(comparison.usage.models) === JSON.stringify(target.usage.models);
    });
  });
  return {
    total: matches.length,
    matched: matches.filter(attempt => {
      const result = attempt.comparison!;
      return result.checks.every(check => check.matches === true)
        && result.checkIds.every(id => attempt.review?.dispositions[id] === 'Supported');
    }).length,
  };
}
