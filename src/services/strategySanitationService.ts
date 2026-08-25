import { FactCheckClaim, FactCheckResult, StrategySanitationItem } from '../types';
import {
  isBlockingUnsupportedClaim,
  isDomainTaxonomyHygieneClaim,
  isMisclassifiedButRealClaim,
  isTacticHygieneClaim
} from './qualityGateService';

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

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
  tactic_disposition: claim.tactic_disposition,
});

const isAntipatternBurdenSpendMisuse = (claim: FactCheckClaim): boolean => {
  const blob = `${claim.claim}\n${claim.rationale}`.toLowerCase();
  return blob.includes('anti-pattern burden') && blob.includes('share of cloud spend');
};

const isSanitizableHygieneClaim = (claim: FactCheckClaim): boolean => {
  if (!claim.claim || !claim.source_location) return false;
  return claim.severity === 'WARN_MISCLASSIFIED_BUT_REAL'
    || claim.severity === 'WARN_TACTIC_HYGIENE'
    || isMisclassifiedButRealClaim(claim)
    || isTacticHygieneClaim(claim)
    || isDomainTaxonomyHygieneClaim(claim);
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

  const withoutTerminalPunctuation = exact.replace(/[.!?]+$/, '').trim();
  const fragmentIndex = value.toLowerCase().indexOf(withoutTerminalPunctuation.toLowerCase());
  if (withoutTerminalPunctuation.length >= 16 && fragmentIndex >= 0) {
    const next = `${value.slice(0, fragmentIndex)}${value.slice(fragmentIndex + withoutTerminalPunctuation.length)}`
      .replace(/^\s*[,;:]?\s*(?:and\s+)?/i, '')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
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
  if (!claimText) return false;
  const claimLower = claimText.toLowerCase();
  for (const phase of roadmap) {
    if (!Array.isArray(phase?.actions)) continue;
    const kept: string[] = [];
    for (const action of phase.actions) {
      const actionText = compact(String(action || ''));
      if (!actionText) continue;
      const actionLower = actionText.toLowerCase();
      const matches = actionLower.includes(claimLower) || claimLower.includes(actionLower);
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

const TACTIC_REFERENCE_RX = /\[(TAC-[A-Z]+-\d+(?:-[A-Z]+)?)\]/g;

const removeTacticReferences = (value: string, tacticIds: Set<string>): string => {
  let next = value;
  for (const tacticId of tacticIds) {
    const reference = `\\[${escapeRegExp(tacticId)}\\]`;
    next = next
      .replace(new RegExp(`\\bapply\\s+${reference}\\s+to\\b`, 'gi'), 'address')
      .replace(new RegExp(`\\buse\\s+${reference}\\s+only\\s+for\\b`, 'gi'), 'perform')
      .replace(new RegExp(`\\bextend\\s+${reference}\\s+from\\b`, 'gi'), 'extend the existing practice from')
      .replace(new RegExp(`\\s+(?:under|through|using|via|with)\\s+${reference}`, 'gi'), '')
      .replace(new RegExp(reference, 'gi'), '');
  }
  return next
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
};

const preserveRoadmapActionWithoutRejectedTactic = (strategy: any, claim: FactCheckClaim): boolean => {
  const roadmap = strategy?.phase_3_strategy?.remediation_roadmap;
  if (!Array.isArray(roadmap)) return false;
  const tacticIds = new Set(Array.from(claim.claim.matchAll(TACTIC_REFERENCE_RX), match => match[1]));
  const claimText = compact(claim.claim);
  if (tacticIds.size === 0 || !claimText) return false;
  const claimLower = claimText.toLowerCase();
  let changed = false;
  for (const phase of roadmap) {
    if (!Array.isArray(phase?.actions)) continue;
    phase.actions = phase.actions.flatMap((action: unknown) => {
      const actionText = compact(String(action || ''));
      const actionLower = actionText.toLowerCase();
      const matches = actionLower.includes(claimLower) || claimLower.includes(actionLower);
      if (!matches) return actionText ? [action] : [];
      const rewritten = removeTacticReferences(String(action), tacticIds);
      changed ||= rewritten !== String(action);
      return rewritten ? [rewritten] : [];
    });
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
      if (isSanitizableHygieneClaim(claim)) {
        if (
          claim.source_location === 'roadmap'
          && claim.severity === 'WARN_TACTIC_HYGIENE'
          && preserveRoadmapActionWithoutRejectedTactic(data, claim)
        ) {
          sanitized.push(makeItem(claim, 'rewritten'));
          continue;
        }
        if (claim.source_location === 'roadmap' && removeRoadmapAction(data, claim)) {
          sanitized.push(makeItem(claim, 'quarantined'));
          continue;
        }
        const result = sanitizeStringsDeep(data.phase_3_strategy, claim, 'remove');
        if (result.changed) {
          data.phase_3_strategy = result.value;
          sanitized.push(makeItem(claim, 'quarantined'));
          continue;
        }
      }
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
        const result = sanitizeStringsDeep(data.phase_3_strategy, claim, 'remove');
        if (result.changed) {
          data.phase_3_strategy = result.value;
        }
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

interface BlockedStrategyContext {
  evidenceDensity?: number;
  evidenceCheckCompleted?: boolean;
  scoreEvidenceGaps?: string[];
}

const unsafeDiagnosticBlock = (reasons: string[]): boolean => reasons.some(reason =>
  /integrity|security|privacy|no traceable evidence|evidence-check (?:result is missing|did not complete)|analysis unavailable/i.test(reason)
);

export const sanitizeEvidenceSummaryUncertainty = (strategyData: any): any => {
  const data = clone(strategyData || {});
  const summary = data?.phase_3_strategy?.evidence_summary;
  if (!summary || !Array.isArray(summary.confirmed_gaps)) return data;
  const retained: string[] = [];
  const moved: string[] = [];
  for (const value of summary.confirmed_gaps) {
    const gap = typeof value === 'string' ? value.trim() : '';
    if (/^(?:complete absence of|no evidence of|absence of)\b/i.test(gap)) {
      const subject = gap
        .replace(/^complete absence of\s*/i, '')
        .replace(/^no evidence of\s*/i, '')
        .replace(/^absence of\s*/i, '');
      moved.push(`Not demonstrated by the supplied material: ${subject}`);
    } else if (gap) {
      retained.push(gap);
    }
  }
  summary.confirmed_gaps = retained;
  summary.silent_or_missing_evidence = Array.from(new Set([
    ...(summary.silent_or_missing_evidence || []),
    ...moved,
  ]));
  return data;
};

export const sanitizeBlockedStrategy = (
  strategyData: any,
  blockingReasons: string[],
  context: BlockedStrategyContext = {}
): any => {
  const data = clone(strategyData || {});
  const strategy = data.phase_3_strategy && typeof data.phase_3_strategy === 'object'
    ? data.phase_3_strategy
    : {
      executive_summary: 'Strategy unavailable because required validation did not complete.',
      executive_summaries: {
        finops_lead: 'Strategy unavailable because required validation did not complete.',
        cfo: 'Strategy unavailable because required validation did not complete.',
        engineering_lead: 'Strategy unavailable because required validation did not complete.'
      },
      active_persona: 'finops_lead',
      visual_scorecard: { headline: 'Validation required', maturity_score: 'N/A', burden_score: 'N/A' }
    };
  data.phase_3_strategy = strategy;

  strategy.remediation_roadmap = [];
  strategy.effective_bracket = 'LOW';
  const mayReviewFindings =
    (context.evidenceDensity || 0) >= 30
    && context.evidenceCheckCompleted === true
    && !unsafeDiagnosticBlock(blockingReasons);
  const safeToActOn = mayReviewFindings
    ? [
      'Review confirmed, source-backed findings with accountable owners as diagnostic input; do not treat them as implementation authorization.',
      'Collect and validate the evidence listed under Evidence Needed Before Action.',
      'Rerun the assessment after the blocking conditions and evidence questions are resolved.',
    ]
    : [
      'Resolve the listed validation, integrity, security, or evidence-verification blockers before relying on the assessment findings.',
      'Rerun the assessment after the blocking conditions are resolved.',
    ];
  strategy.planning_decision = {
    decision: 'NO_GO',
    rationale: 'Required validation did not complete or the quality gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.',
    safe_to_act_on: safeToActOn,
    evidence_needed_before_action: blockingReasons.length > 0 || (context.scoreEvidenceGaps?.length || 0) > 0
      ? [...blockingReasons, ...(context.scoreEvidenceGaps || []).slice(0, 8)]
      : ['Resolve the quality-gate blockers and re-run required verification.']
  };
  return data;
};
