import { FactCheckClaim, FactCheckResult, StrategySanitationItem } from '../types';
import { isBlockingUnsupportedClaim } from './qualityGateService';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compact = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const makeItem = (claim: FactCheckClaim, action: StrategySanitationItem['action']): StrategySanitationItem => ({
  action,
  claim: claim.claim,
  rationale: claim.rationale || '',
  source_location: claim.source_location,
  failure_type: claim.failure_type,
  severity: claim.severity,
});

const isAntipatternBurdenSpendMisuse = (claim: FactCheckClaim): boolean => {
  const blob = `${claim.claim}\n${claim.rationale}`.toLowerCase();
  return blob.includes('anti-pattern burden') && blob.includes('share of cloud spend');
};

const rewriteMetricMisuse = (value: string): { value: string; changed: boolean } => {
  const before = value;
  let next = value.replace(
    /The anti-pattern burden is confirmed at (\d+)%, meaning [^.]*share of cloud spend[^.]*\./gi,
    'The confirmed anti-pattern burden index is $1%, based on validated anti-pattern severity rather than financial spend allocation.',
  );
  next = next.replace(
    /anti-pattern burden is confirmed at (\d+)%[^.]*share of cloud spend[^.]*/gi,
    'confirmed anti-pattern burden index is $1%, based on validated anti-pattern severity rather than financial spend allocation',
  );
  return { value: next, changed: next !== before };
};

const removeClaimFromString = (value: string, claim: string): { value: string; changed: boolean } => {
  const before = value;
  const exact = claim.trim();
  if (!exact) return { value, changed: false };

  if (value.includes(exact)) {
    const sentencePattern = new RegExp(`(?:^|[\\n\\r]|(?<=[.!?])\\s+)[^.!?\\n\\r]*${escapeRegExp(exact)}[^.!?\\n\\r]*[.!?]?`, 'g');
    let next = value.replace(sentencePattern, ' ');
    if (next === value) next = value.replace(exact, '');
    next = next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { value: next, changed: next !== before };
  }

  const normalizedValue = compact(value);
  const normalizedClaim = compact(exact);
  if (normalizedValue.includes(normalizedClaim)) {
    const loose = new RegExp(escapeRegExp(normalizedClaim).replace(/\\ /g, '\\s+'), 'i');
    const next = value.replace(loose, '').replace(/[ \t]{2,}/g, ' ').trim();
    return { value: next, changed: next !== before };
  }

  return { value, changed: false };
};

const sanitizeStringsDeep = (
  value: any,
  claim: FactCheckClaim,
  mode: 'remove' | 'rewrite',
): { value: any; changed: boolean } => {
  if (typeof value === 'string') {
    return mode === 'rewrite'
      ? rewriteMetricMisuse(value)
      : removeClaimFromString(value, claim.claim);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items: any[] = [];
    for (const item of value) {
      if (typeof item === 'string' && mode === 'remove') {
        const removed = removeClaimFromString(item, claim.claim);
        if (removed.changed) changed = true;
        if (compact(removed.value).length > 0) items.push(removed.value);
      } else {
        const sanitized = sanitizeStringsDeep(item, claim, mode);
        changed ||= sanitized.changed;
        items.push(sanitized.value);
      }
    }
    return { value: items, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: any = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeStringsDeep(child, claim, mode);
      changed ||= sanitized.changed;
      next[key] = sanitized.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
};

const removeRoadmapAction = (strategy: any, claim: FactCheckClaim): boolean => {
  const roadmap = strategy?.phase_3_strategy?.remediation_roadmap;
  if (!Array.isArray(roadmap)) return false;
  let changed = false;
  const claimText = compact(claim.claim);
  for (const phase of roadmap) {
    if (!Array.isArray(phase?.actions)) continue;
    const kept: string[] = [];
    for (const action of phase.actions) {
      const actionText = compact(String(action || ''));
      const matches = actionText.includes(claimText) || claimText.includes(actionText);
      if (matches) {
        changed = true;
      } else {
        kept.push(action);
      }
    }
    phase.actions = kept;
  }
  return changed;
};

export const sanitizeStrategyAfterFactCheck = (
  strategyData: any,
  factCheck: FactCheckResult,
): { strategyData: any; factCheck: FactCheckResult; sanitized: StrategySanitationItem[] } => {
  if (factCheck.failed || factCheck.unsupported_claims.length === 0) {
    return { strategyData, factCheck, sanitized: [] };
  }

  let data = clone(strategyData);
  const remaining: FactCheckClaim[] = [];
  const sanitized: StrategySanitationItem[] = [];

  for (const claim of factCheck.unsupported_claims) {
    if (!isBlockingUnsupportedClaim(claim)) {
      remaining.push(claim);
      continue;
    }

    if (isAntipatternBurdenSpendMisuse(claim)) {
      const result = sanitizeStringsDeep(data.phase_3_strategy, claim, 'rewrite');
      if (result.changed) {
        data.phase_3_strategy = result.value;
        sanitized.push(makeItem(claim, 'rewritten'));
        continue;
      }
    }

    if (claim.source_location === 'roadmap') {
      if (removeRoadmapAction(data, claim)) {
        sanitized.push(makeItem(claim, 'removed'));
        continue;
      }
    }

    const result = sanitizeStringsDeep(data.phase_3_strategy, claim, 'remove');
    if (result.changed) {
      data.phase_3_strategy = result.value;
      sanitized.push(makeItem(claim, 'quarantined'));
      continue;
    }

    remaining.push(claim);
  }

  return {
    strategyData: data,
    factCheck: {
      ...factCheck,
      unsupported_claims: remaining,
      sanitized_claims: [...(factCheck.sanitized_claims || []), ...sanitized],
    },
    sanitized,
  };
};
