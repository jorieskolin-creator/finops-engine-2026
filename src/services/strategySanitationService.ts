import type { AcceptedCriterionBasis } from './factCheckService';
import { AuditItem, DerivedAnalyticalEvidence, DomainId, FactCheckClaim, FactCheckResult, Phase1AuditLogs, Phase2Validation, StrategySanitationItem } from '../types';
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

const preserveRoadmapActionWithoutRejectedTactic = (
  strategy: any,
  claim: FactCheckClaim,
  preservedOut?: Set<string>,
): boolean => {
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
      if (rewritten && preservedOut) preservedOut.add(normalizeStatement(rewritten).toLowerCase());
      return rewritten ? [rewritten] : [];
    });
  }
  return changed;
};

interface PlanningReview {
  basisByCriterion: ReadonlyMap<string, AcceptedCriterionBasis>;
  verifiedClaims: FactCheckClaim[];
  excludedPremises: string[];
  preservedRoadmapActions?: ReadonlySet<string>;
}

const normalizeStatement = (value: string): string =>
  compact(value).replace(/^[-*•]\s+/, '').trim();

const CRITERION_MENTION_RX = /\b(AP-)?([A-F])([1-5])(?:\s*(?:-|to|through|–)\s*(?:\2)?([1-5]))?\b/g;

const extractCriterionKeys = (text: string): string[] => {
  const keys = new Set<string>();
  for (const [, ap, domain, start, end] of text.matchAll(CRITERION_MENTION_RX)) {
    const first = Math.min(Number(start), Number(end || start));
    const last = Math.max(Number(start), Number(end || start));
    for (let n = first; n <= last; n++) {
      keys.add(`${ap ? 'antipattern' : 'maturity'}.${domain}${n}`);
    }
  }
  return Array.from(keys);
};

const PREMISE_STOPWORDS = new Set([
  'about', 'above', 'accepted', 'across', 'action', 'actions', 'actual', 'actuals', 'after', 'against',
  'allocation', 'alone', 'along', 'already', 'also', 'although', 'among', 'analysis', 'anti-pattern',
  'architecture', 'assessed', 'assessment', 'asserted', 'azure', 'based', 'because', 'before', 'below',
  'between', 'beyond', 'billing', 'bounded', 'broad', 'budget', 'budgets', 'cannot', 'check', 'checks',
  'cited', 'claim', 'claims', 'cloud', 'collect', 'commitment', 'commitments', 'confidence', 'confirmed',
  'context', 'control', 'controls', 'cost-per-task', 'could', 'count', 'cover', 'coverage', 'covers',
  'crawl', 'criteria', 'criterion', 'culture', 'current', 'customer', 'daily', 'decision', 'decisions',
  'defined', 'deliverable', 'deliverables', 'delivery', 'demonstrated', 'density', 'direct', 'directly',
  'documented', 'does', 'domain', 'domains', 'during', 'engineering', 'established', 'evidence',
  'evidenced', 'every', 'exception', 'exceptions', 'existing', 'fact', 'facts', 'figure', 'figures',
  'final', 'finance', 'finding', 'findings', 'finops', 'first', 'follow', 'forecast', 'found',
  'framework', 'full', 'fully', 'further', 'governed', 'guardrail', 'guardrails', 'having', 'however',
  'identified', 'implementation', 'include', 'included', 'includes', 'including', 'incomplete',
  'independent', 'instead', 'integrity', 'into', 'inventory', 'investment', 'issue', 'items', 'itself',
  'level', 'levels', 'limited', 'locked', 'management', 'material', 'maturity', 'means', 'measured',
  'medium', 'metric', 'metrics', 'missing', 'model', 'month', 'monthly', 'narrow', 'needed', 'neither',
  'never', 'noted', 'notes', 'observation', 'observations', 'observed', 'optimization', 'organization',
  'organizational', 'other', 'outcome', 'outcomes', 'overall', 'owner', 'owners', 'packet', 'partial',
  'passing', 'payments', 'phase', 'phases', 'planning', 'platform', 'point', 'policies', 'policy',
  'portfolio', 'present', 'primary', 'prior', 'process', 'program', 'prove', 'proven', 'provides',
  'question', 'questions', 'quote', 'quoted', 'rather', 'record', 'recorded', 'records', 'recurring',
  'reflect', 'register', 'related', 'relevant', 'remain', 'remains', 'remediation', 'report', 'reported',
  'reporting', 'required', 'requires', 'reservation', 'reservations', 'resolution', 'resolved',
  'resource', 'resources', 'result', 'results', 'review', 'reviewed', 'reviews', 'roadmap', 'route',
  'routes', 'routing', 'sample', 'sampled', 'savings', 'scanner', 'scope', 'scoped', 'scopes', 'score',
  'scored', 'scores', 'section', 'several', 'should', 'showback', 'shown', 'shows', 'signal', 'silent',
  'since', 'single', 'source', 'source-backed', 'sources', 'spend', 'stage', 'stated', 'statement',
  'states', 'status', 'still', 'strategy', 'subcriteria', 'subcriterion', 'sufficiency', 'summary',
  'supplied', 'support', 'supported', 'supports', 'surface', 'synthetic', 'tactic', 'tactics', 'tagging',
  'target', 'targets', 'teams', 'tested', 'their', 'there', 'therefore', 'these', 'those', 'though',
  'three', 'through', 'total', 'treat', 'treated', 'treats', 'under', 'unknown', 'unproven', 'unscored',
  'until', 'unverified', 'using', 'utilisation', 'utilization', 'valid', 'validate', 'validation', 'value',
  'variance', 'verified', 'verifier', 'where', 'whether', 'which', 'while', 'within', 'without',
  'workload', 'workloads', 'would',
]);

const extractPremiseTokens = (text: string): string[] =>
  (text.toLowerCase().match(/\b[a-z][a-z0-9-]{4,}\b/g) || [])
    .filter(token => !PREMISE_STOPWORDS.has(token) && !/^tac-[a-z]+-\d+/.test(token));

const splitSentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

const isPureEvidenceCollectionStatement = (text: string, evidenceRequest: boolean): boolean => {
  if (TACTIC_REFERENCE_RX.test(text)) {
    TACTIC_REFERENCE_RX.lastIndex = 0;
    return false;
  }
  TACTIC_REFERENCE_RX.lastIndex = 0;
  if (evidenceRequest || text.trim().endsWith('?')) return true;
  return /\b(?:collect|gather|request|confirm\s+(?:full\s+)?scope|scope[- ]confirmation|scope[- ]verification|evidence\s+register|evidence\s+requests?|re-?check|(?:re-?run|repeat)\s+the\s+(?:[\w-]+\s+)?assessment|verification\s+gap)\b/i.test(text)
    && !/\b(?:from\s+scratch|broken|confirmed\s+deficiency|confirmed\s+weakness)\b/i.test(text);
};

interface CompiledPremise {
  normalized: string;
  criteria: Set<string>;
  tactics: Set<string>;
  tokens: Set<string>;
}

// Keep the review transient. Statements tainted by quarantined premises must
// carry whole-statement verification grounded in accepted criterion evidence,
// while unaffected statements on clean criteria are preserved.
const reconcilePlanning = (
  strategy: any, review: PlanningReview, sanitized: StrategySanitationItem[],
): void => {
  const preservedActions = review.preservedRoadmapActions || new Set<string>();
  const compiledPremises: CompiledPremise[] = review.excludedPremises
    .map(premise => {
      const normalized = normalizeStatement(premise).toLowerCase();
      const sentences = splitSentences(premise);
      const wordCount = normalized ? normalized.split(/\s+/).length : 0;
      // Multi-sentence composite summary/rationale paragraphs match by substring,
      // explicit criterion IDs, or tactic IDs — never as a global bag of words.
      const tokens = (sentences.length <= 1 && wordCount <= 28)
        ? new Set(extractPremiseTokens(premise))
        : new Set<string>();
      return {
        normalized,
        criteria: new Set(extractCriterionKeys(premise)),
        tactics: new Set(Array.from(premise.matchAll(TACTIC_REFERENCE_RX), match => match[1])),
        tokens,
      };
    })
    .filter(cp => cp.normalized.length > 0);

  const directlyOverlapsPremise = (value: string): boolean => {
    const normalized = normalizeStatement(value).toLowerCase();
    if (!normalized || preservedActions.has(normalized)) return false;
    const valueCriteria = extractCriterionKeys(value);
    const valueTactics = Array.from(value.matchAll(TACTIC_REFERENCE_RX), match => match[1]);
    const valueTokens = new Set(extractPremiseTokens(value));

    for (const cp of compiledPremises) {
      if (normalized.includes(cp.normalized)) return true;
      if (valueCriteria.some(key => cp.criteria.has(key))) return true;
      if (valueTactics.some(tid => cp.tactics.has(tid))) return true;
      if (cp.tokens.size > 0) {
        let overlapCount = 0;
        for (const token of valueTokens) {
          if (cp.tokens.has(token)) overlapCount++;
        }
        const needed = cp.tokens.size === 1 ? 1 : cp.tokens.size <= 3 ? 2 : Math.ceil(cp.tokens.size * 0.6);
        if (overlapCount >= needed) return true;
      }
    }
    return false;
  };

  // Transitive criterion taint: if any candidate statement directly overlaps an
  // excluded premise, statements citing that same criterion must prove independent support.
  const affectedCriteria = new Set<string>();
  for (const cp of compiledPremises) {
    for (const key of cp.criteria) affectedCriteria.add(key);
  }
  const allCandidateStrings: string[] = [];
  const decision = strategy?.planning_decision;
  if (decision) {
    if (typeof decision.rationale === 'string') allCandidateStrings.push(decision.rationale);
    for (const key of ['safe_to_act_on', 'evidence_needed_before_action'] as const) {
      if (Array.isArray(decision[key])) allCandidateStrings.push(...decision[key]);
    }
  }
  if (Array.isArray(strategy?.remediation_roadmap)) {
    for (const phase of strategy.remediation_roadmap) {
      if (typeof phase?.why === 'string') allCandidateStrings.push(...splitSentences(phase.why));
      if (typeof phase?.what === 'string') allCandidateStrings.push(...splitSentences(phase.what));
      for (const key of ['deliverables', 'actions', 'assumptions'] as const) {
        if (Array.isArray(phase?.[key])) allCandidateStrings.push(...phase[key]);
      }
    }
  }
  for (const candidate of allCandidateStrings) {
    if (directlyOverlapsPremise(candidate)) {
      for (const key of extractCriterionKeys(candidate)) affectedCriteria.add(key);
    }
  }

  const isAffectedByQuarantine = (value: string): boolean => {
    const normalized = normalizeStatement(value).toLowerCase();
    if (preservedActions.has(normalized)) return false;
    if (directlyOverlapsPremise(value)) return true;
    return extractCriterionKeys(value).some(key => affectedCriteria.has(key));
  };

  const supported = (text: string, location: 'planning_decision' | 'roadmap', evidenceRequest: boolean) => {
    const normalizedText = normalizeStatement(text);
    const collectionAllowed = isPureEvidenceCollectionStatement(text, evidenceRequest);
    const mentionedKeys = extractCriterionKeys(text);

    const hasExplicitVerdict = review.verifiedClaims.some(verdict => {
      if (verdict.source_location !== location || normalizeStatement(verdict.claim) !== normalizedText
        || !['supported_by_audit', 'supported_by_source'].includes(verdict.classification)) return false;
      const references = [...verdict.rationale.matchAll(/\b((?:maturity|antipattern)\.[A-F][1-5])\s+"([^"\n]+)"/g)];
      if (!references.length) return false;
      const cited = new Set(references.map(match => match[1]));
      for (const key of mentionedKeys) {
        if (!cited.has(key)) return false;
      }
      return references.every(([, key, excerpt]) => {
        const basis = review.basisByCriterion.get(key);
        if (!basis) return false;
        if (basis.unknownStatus) return collectionAllowed && compact(excerpt) === compact(basis.unknownStatus);
        const normalizedExcerpt = compact(excerpt).toLowerCase();
        return /\s/.test(excerpt.trim()) && basis.details.some(detail => compact(detail).toLowerCase().includes(normalizedExcerpt));
      });
    });
    if (hasExplicitVerdict) return true;

    // Pure bounded evidence-collection items whose cited criteria are all genuinely
    // UNKNOWN in Phase 2 need not repeat the unknownStatus string N times in rationale.
    if (collectionAllowed && mentionedKeys.length > 0 && mentionedKeys.every(key => Boolean(review.basisByCriterion.get(key)?.unknownStatus))) {
      return true;
    }
    return false;
  };

  const keep = (value: string, location: 'roadmap' | 'planning_decision', evidenceRequest = false) => {
    if (!value) return true;
    const normalizedValue = normalizeStatement(value).toLowerCase();
    const containsExcluded = review.excludedPremises.some(premise => {
      const normalizedPremise = normalizeStatement(premise).toLowerCase();
      return normalizedPremise.length > 0 && normalizedValue.includes(normalizedPremise);
    });
    if (containsExcluded) {
      sanitized.push({ action: 'removed', claim: value, source_location: location,
        rationale: 'No independent full-statement verification within the surviving customer evidence after premise quarantine.' });
      return false;
    }
    if (!isAffectedByQuarantine(value)) return true;
    if (supported(value, location, evidenceRequest || value.trim().endsWith('?'))) return true;
    sanitized.push({ action: 'removed', claim: value, source_location: location,
      rationale: 'No independent full-statement verification within the surviving customer evidence after premise quarantine.' });
    return false;
  };
  const keepParagraph = (value: string, location: 'roadmap' | 'planning_decision'): string => {
    if (!value) return value;
    const sentences = splitSentences(value);
    if (sentences.length <= 1) return keep(value, location) ? value : '';
    if (supported(value, location, false)) return value;
    return sentences.filter(sentence => keep(sentence, location)).join(' ').trim();
  };

  if (decision) {
    if (typeof decision.rationale === 'string') decision.rationale = keepParagraph(decision.rationale, 'planning_decision');
    for (const key of ['safe_to_act_on', 'evidence_needed_before_action']) {
      if (Array.isArray(decision[key])) decision[key] = decision[key].filter((s: string) => keep(s, 'planning_decision', key === 'evidence_needed_before_action'));
    }
  }
  if (Array.isArray(strategy?.remediation_roadmap)) {
    for (const phase of strategy.remediation_roadmap) {
      for (const key of ['why', 'what']) {
        if (typeof phase[key] === 'string') phase[key] = keepParagraph(phase[key], 'roadmap');
      }
      for (const key of ['deliverables', 'actions', 'assumptions']) {
        if (Array.isArray(phase[key])) phase[key] = phase[key].filter((s: string) => keep(s, 'roadmap'));
      }
    }
    strategy.remediation_roadmap = strategy.remediation_roadmap.filter((phase: any) => phase.actions?.length);
  }
};

const PERSONA_SUMMARY_LOCATIONS = new Set(['cfo', 'finops_lead', 'engineering_lead']);

const isPremise = (item: StrategySanitationItem): boolean =>
  (item.action === 'quarantined' || item.action === 'removed')
  && Boolean(item.failure_type)
  && !PERSONA_SUMMARY_LOCATIONS.has(String(item.source_location || ''))
  && item.severity !== 'WARN_TACTIC_HYGIENE'
  && !isTacticHygieneClaim({
    claim: item.claim,
    classification: 'unsupported',
    rationale: item.rationale,
    source_location: item.source_location,
    failure_type: item.failure_type,
    severity: item.severity,
  })
  && !isDomainTaxonomyHygieneClaim({
    claim: item.claim,
    classification: 'unsupported',
    rationale: item.rationale,
    source_location: item.source_location,
    failure_type: item.failure_type,
    severity: item.severity,
  });

export const sanitizeStrategyAfterFactCheck = (
  strategyData: any,
  factCheck: FactCheckResult,
  planningReview?: PlanningReview,
): { strategyData: any; factCheck: FactCheckResult; sanitized: StrategySanitationItem[] } => {
  const priorPremises = (factCheck.sanitized_claims || []).filter(isPremise);
  if (factCheck.failed || (!factCheck.unsupported_claims.length && !priorPremises.length && !planningReview?.excludedPremises.length)) {
    return { strategyData, factCheck, sanitized: [] };
  }

  let data = clone(strategyData);
  const remaining: FactCheckClaim[] = [];
  const sanitized: StrategySanitationItem[] = [];
  const preservedRoadmapActions = new Set<string>(planningReview?.preservedRoadmapActions || []);

  for (const claim of factCheck.unsupported_claims) {
    if (!isBlockingUnsupportedClaim(claim)) {
      if (isSanitizableHygieneClaim(claim)) {
        if (
          claim.source_location === 'roadmap'
          && claim.severity === 'WARN_TACTIC_HYGIENE'
          && preserveRoadmapActionWithoutRejectedTactic(data, claim, preservedRoadmapActions)
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

    // A roadmap-only recheck reuses the original summary verdict. A premise
    // already removed from that locked summary must not become a new blocker.
    if (!priorPremises.some(item => item.claim === claim.claim && item.source_location === claim.source_location)) remaining.push(claim);
  }

  const originalAssumptions = new Set<string>(
    (strategyData?.phase_3_strategy?.remediation_roadmap || [])
      .flatMap((phase: any) => Array.isArray(phase?.assumptions) ? phase.assumptions : [])
      .map((item: unknown) => normalizeStatement(String(item || '')).toLowerCase())
      .filter(Boolean)
  );
  const isAssumptionOnlyRemoval = (item: StrategySanitationItem): boolean =>
    item.source_location === 'roadmap' && originalAssumptions.has(normalizeStatement(item.claim).toLowerCase());

  if (planningReview) {
    const excludedPremises = [
      ...planningReview.excludedPremises,
      ...priorPremises.filter(p => !isAssumptionOnlyRemoval(p)).map(p => p.claim),
      ...sanitized.filter(item => isPremise(item) && !isAssumptionOnlyRemoval(item)).map(p => p.claim),
    ];
    if (excludedPremises.length) {
      reconcilePlanning(
        data.phase_3_strategy,
        { ...planningReview, excludedPremises, preservedRoadmapActions },
        sanitized,
      );
    }
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
  if ((context.evidenceDensity ?? 100) < 25) {
    if (strategy.evidence_summary && Array.isArray(strategy.evidence_summary.confirmed_gaps) && strategy.evidence_summary.confirmed_gaps.length > 0) {
      strategy.evidence_summary.scoped_observations = Array.from(new Set([
        ...(strategy.evidence_summary.scoped_observations || []),
        ...strategy.evidence_summary.confirmed_gaps.map((gap: string) => gap.replace('] Confirmed gap:', '] Scoped observation (0/3):')),
      ]));
      strategy.evidence_summary.confirmed_gaps = [];
    }
    if (strategy.diagnosis && typeof strategy.diagnosis.primary_bottleneck === 'string' && /^\[[A-F][1-5]\]/.test(strategy.diagnosis.primary_bottleneck.trim())) {
      strategy.diagnosis.primary_bottleneck = 'Not established — assessed criterion coverage is below the sufficiency floor, so no single criterion can be identified as the primary organizational bottleneck.';
      strategy.diagnosis.root_causes = ['Root-cause ranking is withheld until missing domain and criterion evidence is supplied.'];
    }
  }
  const mayReviewFindings =
    (context.evidenceDensity || 0) >= 25
    && context.evidenceCheckCompleted === true
    && !unsafeDiagnosticBlock(blockingReasons);
  const safeToActOn = mayReviewFindings
    ? [
      'Review confirmed, source-backed findings with accountable owners as diagnostic input; do not treat them as implementation authorization.',
      'Collect and validate the evidence listed under Evidence Needed Before Action.',
      'Rerun the assessment after the blocking conditions and evidence questions are resolved.',
    ]
    : [
      'Review only the verified scoped source observations below as bounded sample facts; do not extrapolate organization-wide maturity or bottlenecks.',
      'Collect and validate the missing domain and criterion evidence listed under Evidence Needed Before Action.',
      'Rerun the assessment after the blocking conditions are resolved.',
    ];
  const priorNoGoEvidence = strategy.planning_decision?.decision === 'NO_GO'
    && Array.isArray(strategy.planning_decision.evidence_needed_before_action)
    ? strategy.planning_decision.evidence_needed_before_action
    : [];
  const combinedEvidenceNeeded = Array.from(new Set([
    ...blockingReasons,
    ...priorNoGoEvidence,
    ...(context.scoreEvidenceGaps || []).slice(0, 8),
  ])).slice(0, 10);
  strategy.planning_decision = {
    decision: 'NO_GO',
    rationale: 'Required validation did not complete or the quality gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.',
    safe_to_act_on: safeToActOn,
    evidence_needed_before_action: combinedEvidenceNeeded.length > 0
      ? combinedEvidenceNeeded
      : ['Resolve the quality-gate blockers and re-run required verification.']
  };
  return data;
};

export interface DeterministicBlockedReportInput {
  auditLogs: Phase1AuditLogs;
  validationData: Phase2Validation;
  skippedDomains?: Record<string, string>;
  derivedEvidence?: DerivedAnalyticalEvidence[];
  bracketDetail: string;
}

export const buildDeterministicBlockedFindingsStrategy = ({
  auditLogs,
  validationData,
  skippedDomains = {},
  derivedEvidence = [],
  bracketDetail,
}: DeterministicBlockedReportInput): any => {
  const assessedCount = (validationData.metrics.maturity_assessed_count ?? 0) + (validationData.metrics.antipattern_assessed_count ?? 0);
  const density = Math.round(validationData.metrics.evidence_density);
  const silentDomainIds = validationData.assessment_sufficiency.silent_domain_ids || [];
  const unresolvedDomainIds = new Set((validationData.verification_unresolved || []).map(item => item.charAt(1)));
  const skippedDomainList = Object.keys(skippedDomains).sort();

  const criterionQuoteObservations: string[] = [];
  for (const [id, rawItem] of Object.entries(auditLogs.maturity || {})) {
    const item = rawItem as AuditItem;
    if (!item || item.verification_unresolved || item.assessment_status === 'not_assessed') continue;
    if (item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') continue;
    const firstQuote = (item.evidence_quotes || []).find(q => typeof q?.quote === 'string' && q.quote.trim().length > 0)?.quote.trim();
    if (!firstQuote) continue;
    const truncatedQuote = firstQuote.length > 180 ? `${firstQuote.slice(0, 177)}...` : firstQuote;
    criterionQuoteObservations.push(
      `[${id}] Scoped observation (${item.count}/3): ${item.evidence || item.reasoning} (Quote: "${truncatedQuote}")`
    );
  }
  for (const [id, rawItem] of Object.entries(auditLogs.antipattern || {})) {
    const item = rawItem as AuditItem;
    if (!item || item.verification_unresolved) continue;
    if (item.evidence_check_status === 'unsupported' || item.evidence_check_status === 'missing') continue;
    const firstQuote = (item.evidence_quotes || []).find(q => typeof q?.quote === 'string' && q.quote.trim().length > 0)?.quote.trim();
    if (!firstQuote) continue;
    const truncatedQuote = firstQuote.length > 180 ? `${firstQuote.slice(0, 177)}...` : firstQuote;
    if (item.antipattern_absence_status === 'unknown_absent' || item.assessment_status === 'not_assessed') {
      criterionQuoteObservations.push(
        `[AP-${id}] Scoped observation (anti-pattern not assessed): "${truncatedQuote}"${item.coverage_reason ? ` — ${item.coverage_reason}` : ''}`
      );
    }
  }

  const derivedSummaryObservations = derivedEvidence
    .filter(item =>
      item.mode === 'authoritative'
      && item.report_eligible
      && item.eligibility?.state === 'ELIGIBLE'
      && item.derivation?.analyzer_id !== 'crucial_item_coverage_v1'
      && Array.isArray(item.summary_lines)
      && item.summary_lines.length > 0
    )
    .flatMap(item => item.summary_lines.slice(0, 2).map(line => `[${item.evidence_id}] Deterministic table observation: ${line}`));

  const scopedObservations = Array.from(new Set([
    ...criterionQuoteObservations,
    ...(validationData.scoped_observations || []),
    ...derivedSummaryObservations,
  ])).slice(0, 10);

  const evidenceRequests: string[] = [];
  if (skippedDomainList.length > 0) {
    evidenceRequests.push(
      `Unassessed domains (${skippedDomainList.join(', ')}): no eligible customer FinOps evidence was routed; supply primary governance/budget policies, architecture decision records, operating-model/RACI artifacts, and AI consumption controls.`
    );
  }
  const activeDomains = (['A', 'B', 'C', 'D', 'E', 'F'] as DomainId[]).filter(d => !skippedDomainList.includes(d));
  const prioritizedGaps = [
    ...(validationData.score_evidence_gaps || []).filter(gap => activeDomains.some(d => gap.startsWith(`[${d}`))),
    ...(validationData.score_evidence_gaps || []).filter(gap => !activeDomains.some(d => gap.startsWith(`[${d}`))),
  ];
  evidenceRequests.push(...prioritizedGaps.slice(0, 8));

  const outcome = `The assessment completed deterministic acquisition and Phase 1 verification, resolving ${assessedCount}/60 criteria (${density}% evidence density) while ${60 - assessedCount}/60 criteria remained unassessed. Because assessed criterion coverage is below the minimum evidence floor, narrative synthesis and regeneration were skipped in favor of a deterministic findings-only report.`;
  const boundary = 'Decision: NO_GO. No organizational primary bottleneck, confirmed capability gap, or remediation roadmap is issued from below-floor coverage. Review the scoped observations and supply the requested evidence before rerunning.';

  return {
    phase_3_strategy: {
      executive_summaries: {
        finops_lead: `${outcome}\n\n${boundary}`,
        cfo: `${outcome}\n\nThe supplied extract is insufficient to establish organization-wide investment priorities or verified financial realization. ${boundary}`,
        engineering_lead: `${outcome}\n\nThe supplied extract is insufficient to prescribe organization-wide engineering controls or architectural changes. ${boundary}`,
      },
      executive_summary: `${outcome}\n\n${boundary}`,
      active_persona: 'finops_lead',
      evidence_summary: {
        headline: 'Roadmap actionability BLOCKED · maturity classification unavailable because Assessment Sufficiency did not pass',
        maturity_classification: validationData.crawl_walk_run,
        key_metrics: [
          `Adjusted FinOps Maturity: ${validationData.metrics.adjusted_maturity === null ? 'N/A' : `${Math.round(validationData.metrics.adjusted_maturity)}/100 (diagnostic only)`}`,
          `Corroborated maturity: ${validationData.metrics.corroborated_maturity === null ? 'N/A' : `${Math.round(validationData.metrics.corroborated_maturity)}%`}`,
          `Observed maturity: ${validationData.metrics.observed_maturity === null ? 'N/A' : `${Math.round(validationData.metrics.observed_maturity)}%`}`,
          `Assessment resolution: ${Math.round(validationData.metrics.assessment_resolution)}%`,
          `Assessment sufficiency: ${validationData.assessment_sufficiency.decision}`,
          `Evidence density: ${density}% (${assessedCount}/60 assessed criteria)`,
          `Delivery integrity: ${Math.round(validationData.metrics.delivery_integrity)}%`,
          `Anti-pattern coverage: ${Math.round(validationData.metrics.antipattern_coverage)}%`,
        ],
        confirmed_strengths: [],
        scoped_observations: scopedObservations,
        confirmed_gaps: [],
        confirmed_antipatterns: validationData.antipattern_findings.slice(0, 8),
        silent_or_missing_evidence: [
          ...validationData.verification_unresolved,
          ...evidenceRequests,
        ].slice(0, 8),
      },
      diagnosis: {
        executive_summary: `Verified customer evidence covered ${assessedCount} of 60 assessment criteria (${density}% density), which is below the sufficiency floor for a maturity classification or remediation roadmap. Only bounded observations from the assessed scopes are reported below; unassessed domains remain verification gaps.`,
        primary_bottleneck: `Not established — assessed criterion coverage (${assessedCount}/60, ${density}%) is below the minimum sufficiency floor, so no criterion can be identified as the primary organizational bottleneck.`,
        root_causes: [
          'Root-cause attribution is withheld until missing domain and criterion evidence is supplied.',
        ],
        domain_diagnosis: Object.fromEntries(
          Object.entries(validationData.category_scores).map(([cat, score]) => [
            cat,
            skippedDomainList.includes(cat)
              ? `Domain ${cat} was not assessed because no eligible customer FinOps evidence remained after acquisition.`
              : silentDomainIds.includes(cat as DomainId)
                ? `Domain ${cat} is silent below 10% verified criterion evidence; collect domain evidence before drawing maturity conclusions.`
                : unresolvedDomainIds.has(cat)
                  ? `Verification was unavailable in domain ${cat}; scanner candidates were excluded and no validated domain score is reported.`
                  : `Scoped domain signal ${score}/15 in domain ${cat} from partial evidence coverage; insufficient for organization-wide bottleneck attribution.`,
          ])
        ),
        confidence: 'low',
        confidence_rationale: bracketDetail,
      },
      planning_decision: {
        decision: 'NO_GO',
        rationale: 'Assessed criterion coverage is below the minimum evidence floor. Preserve the verified scoped observations, gather the missing evidence below, and rerun the assessment before prioritizing remediation.',
        safe_to_act_on: [
          'Review only the verified scoped source observations as bounded extract facts.',
          'Collect the primary domain and criterion evidence listed under Evidence Needed Before Action.',
          'Rerun the assessment once broader customer FinOps artifacts are available.',
        ],
        evidence_needed_before_action: evidenceRequests.slice(0, 8),
      },
      visual_scorecard: {
        headline: 'Insufficient Evidence — Deterministic Findings Only',
        maturity_score: `${validationData.metrics.adjusted_maturity === null ? 'N/A' : `${Math.round(validationData.metrics.adjusted_maturity)}/100 diagnostic`} — Assessment Sufficiency BLOCK`,
        burden_score: `${Math.round(validationData.metrics.antipattern_burden)}% anti-pattern burden`,
      },
      remediation_roadmap: [],
      findings_mode: {
        evidence_backed_findings: [
          ...scopedObservations,
          ...validationData.antipattern_findings.slice(0, 3),
          ...validationData.verified_antipattern_absences.slice(0, 3),
        ].slice(0, 10),
        candidate_themes: [
          ...(activeDomains.length > 0
            ? [`Expand partial extract coverage in Domain${activeDomains.length > 1 ? 's' : ''} ${activeDomains.join(', ')} with organization-wide billing, allocation, realization, and governance records before confirming capability gaps.`]
            : []),
          ...(skippedDomainList.length > 0
            ? [`Establish baseline assessment coverage across unassessed Domains ${skippedDomainList.join(', ')}.`]
            : []),
        ],
        missing_evidence: evidenceRequests.slice(0, 8),
        validation_plan: [
          'Supply multi-period billing/allocation exports and documented tagging/showback ownership to evaluate Domain A across the full organization.',
          'Supply optimization realization records with explicit time horizons, baseline/realized validation, and commitment coverage to evaluate Domain B.',
          'Attach FinOps governance/budget policies, architecture review artifacts, operating-model/RACI documentation, and AI cost controls for Domains C–F.',
        ],
      },
      confidence_bracket: 'LOW',
      effective_bracket: 'LOW',
    },
  };
};
