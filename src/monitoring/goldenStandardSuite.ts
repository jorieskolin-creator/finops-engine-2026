import type { ClearBlockResult, DurableAttemptSummary, MonitoringObservation } from './clearBlockVerification';
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
export interface CompactComparison extends Comparison {
  kbHash: string | null;
  assessed: number;
  checkIds: string[];
  usage: Usage;
  expectedDecisions?: {
    evidenceSufficiency: string | null;
    qualityGate: string | null;
    planningDecision: string | null;
  };
  observedDecisions?: {
    evidenceSufficiency: string;
    qualityGate: string;
    planningDecision: string;
    crawlWalkRun: string | null;
  };
  falseGoOnExpectedBlock?: boolean;
  monitoring?: MonitoringObservation;
  serverVerified?: boolean;
}
export interface AttemptFailure {
  stage: 'input_download' | 'input_parse' | 'pipeline' | 'cleanup' | 'delivery';
  code: string;
  timedOut: boolean;
  at?: string;
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
  summary?: DurableAttemptSummary | null;
  failure?: AttemptFailure | null;
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

export class GoldenStandardClientError extends Error {
  constructor(
    message: string,
    public readonly reason: string = message,
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

const endpoint = '/api/golden-standard-suite';
async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint + path, { cache: 'no-store', signal: AbortSignal.timeout(45_000), ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = typeof body?.error === 'string' ? body.error : 'GOLDEN_STANDARD_UNAVAILABLE';
    const reason = typeof body?.reason === 'string' ? body.reason : code;
    throw new GoldenStandardClientError(code, reason, response.status);
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
export type SuiteReport = Pick<ClearBlockResult, 'narrative' | 'summary' | 'completedAt' | 'review'> & {
  comparison: Comparison;
  shortSummary?: Omit<DurableAttemptSummary, 'narrative'>;
};

export function attemptStatus(attempt: SuiteAttempt): string {
  if (attempt.state === 'queued') return 'Queued';
  if (attempt.state === 'running') return 'Running';
  const comparison = attempt.comparison;
  if (attempt.state !== 'delivered' || !comparison) return 'Incomplete';
  const judgments = comparison.checkIds.map(id => attempt.review?.dispositions[id]);
  if (comparison.falseGoOnExpectedBlock
    || comparison.checks.some(check => check.matches === false)
    || judgments.some(value => value === 'Missing' || value === 'Contradicted')) return 'Fail';
  return comparison.referenceApproved && comparison.kbHash && comparison.serverVerified !== false
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
  // Overall suite Pass requires all five approved cases on the displayed configuration.
  if (perCase.length !== caseIds.length) return 'Review';
  const repetitions = perCase[0]?.length;
  const sameConfiguration = [1, 3].includes(repetitions) && perCase.every(group =>
    group.length === repetitions
    && new Set(group.map(attempt => attempt.comparison?.referenceSha256)).size === 1
    && new Set(group.map(attempt => JSON.stringify(attempt.comparison?.usage.models))).size === 1);
  return sameConfiguration ? 'Pass' : 'Review';
}

const medianAndRange = (values: number[]): { values: number[]; median: number; range: number } | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
  const range = Math.round((sorted[sorted.length - 1] - sorted[0]) * 10) / 10;
  return { values, median, range };
};

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

export function summarizeMonitoringDashboard(suite: Suite) {
  const delivered = suite.attempts.filter(attempt => attempt.state === 'delivered' && attempt.comparison);
  const gateChecks = delivered.map(attempt => {
    const comp = attempt.comparison!;
    const gateCheck = comp.checks.find(check => check.label === 'Quality Gate');
    return {
      expected: comp.expectedDecisions?.qualityGate ?? (typeof gateCheck?.expected === 'string' ? gateCheck.expected : null),
      observed: comp.observedDecisions?.qualityGate ?? (typeof gateCheck?.observed === 'string' ? gateCheck.observed : null),
      matches: gateCheck?.matches ?? null,
    };
  });
  const evaluableGates = gateChecks.filter(entry => entry.matches !== null);
  const matchedGates = evaluableGates.filter(entry => entry.matches === true).length;

  const expectedBlockRuns = delivered.filter(attempt => {
    const comp = attempt.comparison!;
    const qg = comp.checks.find(check => check.label === 'Quality Gate');
    const suff = comp.checks.find(check => check.label === 'Assessment Sufficiency');
    return comp.expectedDecisions?.qualityGate === 'BLOCK'
      || comp.expectedDecisions?.evidenceSufficiency === 'BLOCK'
      || qg?.expected === 'BLOCK'
      || suff?.expected === 'BLOCK';
  });
  const falseGoCount = delivered.filter(attempt => attempt.comparison?.falseGoOnExpectedBlock === true).length;

  const factTotals = delivered.reduce(
    (acc, attempt) => {
      const fc = attempt.comparison?.monitoring?.factCheck;
      if (fc) {
        acc.totalClaims += fc.totalClaims;
        acc.unsupportedClaims += fc.unsupportedClaims;
        acc.sanitizedClaims += fc.sanitizedClaims;
        acc.byCategory.evidence += fc.byCategory.evidence;
        acc.byCategory.inference += fc.byCategory.inference;
        acc.byCategory.scope += fc.byCategory.scope;
        acc.byCategory.other += fc.byCategory.other;
      }
      const reviewValues = Object.values(attempt.review?.dispositions ?? {});
      acc.reviewedTotal += reviewValues.length;
      acc.reviewedFlagged += reviewValues.filter(v => v === 'Missing' || v === 'Contradicted').length;
      return acc;
    },
    {
      totalClaims: 0,
      unsupportedClaims: 0,
      sanitizedClaims: 0,
      byCategory: { evidence: 0, inference: 0, scope: 0, other: 0 },
      reviewedTotal: 0,
      reviewedFlagged: 0,
    },
  );

  const perCaseVariation = caseIds.flatMap(caseId => {
    const runs = delivered.filter(attempt => attempt.case_id === caseId);
    if (!runs.length) return [];
    const maturityValues = runs
      .map(attempt => attempt.comparison?.monitoring?.adjustedMaturity)
      .filter((value): value is number => typeof value === 'number');
    const assessedValues = runs.map(attempt => attempt.comparison!.assessed);
    return [{
      caseId,
      name: caseNames[caseId],
      runs: runs.length,
      adjustedMaturity: medianAndRange(maturityValues),
      assessed: medianAndRange(assessedValues),
    }];
  });

  const timedOut = suite.attempts.filter(attempt => attempt.state === 'incomplete' && attempt.failure?.timedOut === true).length;
  const failed = suite.attempts.filter(attempt => attempt.state === 'incomplete' && attempt.failure?.timedOut !== true).length;
  const skipped = suite.attempts.filter(attempt => suite.state === 'cancelled' && attempt.state === 'queued').length;

  return {
    gateAccuracy: {
      matched: matchedGates,
      evaluable: evaluableGates.length,
      delivered: delivered.length,
    },
    safetyCritical: {
      falseGoCount,
      expectedBlockCount: expectedBlockRuns.length,
    },
    evidenceQuality: factTotals,
    repeatability: perCaseVariation,
    operations: {
      completed: delivered.length,
      timedOut,
      failed,
      skipped,
      total: suite.attempts.length,
    },
  };
}
