import type { Phase1AuditLogs, Phase2Validation, StrategicTactic, StrategySanitationItem, TacticActivityPlaybookEntry } from '../types';
import { FINOPS_TACTIC_ACTIVITY_PLAYBOOK, FINOPS_TACTICS_LOCAL } from '../knowledge_base';
import { inferAntiPatternAbsenceStatus } from './antiPatternSemantics';
import { hasVerifiedSourceCoverage } from './metricsService';

export interface TacticGroundingAdjustment {
  action_before: string;
  action_after: string;
  tactic_id: string;
  replacement_id?: string;
  reason: string;
}

export interface TacticGroundingResult {
  strategyData: any;
  adjustments: TacticGroundingAdjustment[];
  warnings: string[];
}

export interface TacticSelectionCandidate {
  tactic_id: string;
  canonical_name: string;
  category: TacticActivityPlaybookEntry['category'];
  activated_by: string[];
  activity_goal: string;
  when_to_use: string[];
  when_not_to_use: string[];
  expected_artifacts: string[];
  semantic_hints: string[];
  risks_and_controls: string[];
}

export interface TacticSelectionPlan {
  required: TacticSelectionCandidate[];
  optional: TacticSelectionCandidate[];
  active_criteria: string[];
  active_categories: string[];
}

interface UnsupportedActionRule {
  actionKeywords: string[];
  requiredFindingKeywords: string[];
  reason: string;
}

const TACTIC_RX = /\[(TAC-[A-Z]+-\d+(?:-[A-Z]+)?)\]/g;

const UNSUPPORTED_ACTION_RULES: UnsupportedActionRule[] = [
  {
    actionKeywords: ['activity-based', 'outcome-based'],
    requiredFindingKeywords: ['activity-based', 'vanity metric', 'theater', 'theatre', 'no operational outcome', 'no measurable outcome'],
    reason: 'Removed outcome-tracking action because the locked findings do not say current measurement is activity-based or performative.'
  },
  {
    actionKeywords: ['product team growth'],
    requiredFindingKeywords: ['product team growth', 'team growth', 'scaling pressure', 'operating model strain'],
    reason: 'Removed operating-model growth action because the locked findings do not say product-team growth is stressing the FinOps cadence.'
  }
];

const lower = (value: unknown): string => typeof value === 'string' ? value.toLowerCase() : '';

const includesAny = (haystack: string, needles: string[] | undefined): boolean =>
  !!needles?.some((needle) => haystack.includes(needle.toLowerCase()));

const includesAll = (haystack: string, needles: string[]): boolean =>
  needles.every((needle) => haystack.includes(needle.toLowerCase()));

const buildFindingCorpus = (phase2: Phase2Validation): string => [
  ...phase2.maturity_gaps,
  ...phase2.antipattern_findings,
  ...phase2.silent_areas,
  phase2.metrics.readiness_cap_reason || ''
].join('\n').toLowerCase();

const tacticById = new Map<string, StrategicTactic>(FINOPS_TACTICS_LOCAL.map(tactic => [tactic.id, tactic]));
const tacticDomainsById = new Map(FINOPS_TACTIC_ACTIVITY_PLAYBOOK.map(entry => [
  entry.tactic_id,
  new Set([...entry.maturity_bindings, ...entry.antipattern_bindings]
    .map(binding => binding.criterion_id.replace(/^AP-/, '').charAt(0)))
]));

const confirmedCriterionFindings = (auditLogs: Phase1AuditLogs): Map<string, string> => {
  const findings = new Map<string, string>();
  for (const [criterionId, item] of Object.entries(auditLogs.maturity)) {
    if (
      item.count >= 0
      && item.count < 3
      && item.assessment_status !== 'not_assessed'
      && hasVerifiedSourceCoverage(item, 'maturity')
    ) {
      findings.set(criterionId, item.reasoning || item.evidence);
    }
  }
  for (const [rawCriterionId, item] of Object.entries(auditLogs.antipattern)) {
    if (
      item.assessment_status !== 'not_assessed'
      && hasVerifiedSourceCoverage(item, 'antipattern')
      && ['confirmed_present', 'partially_present'].includes(inferAntiPatternAbsenceStatus(item))
    ) {
      findings.set(`AP-${rawCriterionId.replace(/^AP-/, '')}`, item.reasoning || item.evidence);
    }
  }
  return findings;
};

const candidateFor = (
  entry: TacticActivityPlaybookEntry,
  activatedBy: string[]
): TacticSelectionCandidate => ({
  tactic_id: entry.tactic_id,
  canonical_name: tacticById.get(entry.tactic_id)?.canonical_name || entry.tactic_id,
  category: entry.category,
  activated_by: activatedBy,
  activity_goal: entry.activity_goal,
  when_to_use: entry.when_to_use,
  when_not_to_use: entry.when_not_to_use,
  expected_artifacts: entry.expected_artifacts,
  semantic_hints: entry.semantic_hints,
  risks_and_controls: entry.risks_and_controls,
});

export const buildTacticSelectionPlan = (
  auditLogs: Phase1AuditLogs,
  weakDomains: string[] = []
): TacticSelectionPlan => {
  const findingByCriterion = confirmedCriterionFindings(auditLogs);
  const weakDomainSet = new Set(weakDomains);
  const activeCriteria = Array.from(findingByCriterion.keys())
    .filter(criterion => !weakDomainSet.has(criterion.replace(/^AP-/, '').charAt(0)));
  const activeCriterionSet = new Set(activeCriteria);
  const activeCategories = new Set(activeCriteria.map(criterion => criterion.replace(/^AP-/, '').charAt(0)));

  const required = FINOPS_TACTIC_ACTIVITY_PLAYBOOK.flatMap(entry => {
    const activatedBy = [...entry.maturity_bindings, ...entry.antipattern_bindings]
      .filter(binding => binding.relationship === 'PRIMARY' && activeCriterionSet.has(binding.criterion_id))
      .map(binding => binding.criterion_id);
    return activatedBy.length > 0 ? [candidateFor(entry, activatedBy)] : [];
  });
  const requiredIds = new Set(required.map(candidate => candidate.tactic_id));
  const optional = FINOPS_TACTIC_ACTIVITY_PLAYBOOK.flatMap(entry => {
    if (requiredIds.has(entry.tactic_id)) return [];
    const activatedBy = [...entry.maturity_bindings, ...entry.antipattern_bindings]
      .filter(binding => activeCriterionSet.has(binding.criterion_id))
      .map(binding => binding.criterion_id);
    if (activatedBy.length === 0 && !activeCategories.has(entry.category)) return [];
    return [candidateFor(entry, activatedBy)];
  });

  return {
    required,
    optional,
    active_criteria: activeCriteria,
    active_categories: Array.from(activeCategories).sort(),
  };
};

const compactCandidate = (candidate: TacticSelectionCandidate, required: boolean): string => {
  const identity = [
    `${required ? 'REQUIRED' : 'OPTIONAL'} [${candidate.tactic_id}] ${candidate.canonical_name}`,
    candidate.activated_by.length > 0 ? `Activated/matched criteria: ${candidate.activated_by.join(', ')}` : `Home category candidate: ${candidate.category}`,
  ];
  if (!required) {
    return [...identity, `Semantic hints: ${candidate.semantic_hints.join(', ')}`].join('\n');
  }
  return [
    ...identity,
    `Goal: ${candidate.activity_goal}`,
    `Use when: ${candidate.when_to_use.join('; ')}`,
    `Do not use when: ${candidate.when_not_to_use.join('; ')}`,
    `Expected artifacts (hints, not activation proof): ${candidate.expected_artifacts.join('; ')}`,
    `Risk-control guidance (adapt; do not copy mechanically): ${candidate.risks_and_controls.join('; ')}`,
  ].join('\n');
};

export const buildTacticSelectionContext = (plan: TacticSelectionPlan): string => [
  '### GOVERNED TACTIC SELECTION PLAN',
  'Step 1 — Direct Playbook grounding:',
  plan.required.length > 0
    ? plan.required.map(candidate => compactCandidate(candidate, true)).join('\n\n')
    : 'No PRIMARY tactic was activated by a verified actionable finding.',
  '',
  'Every REQUIRED tactic must be evaluated and initially appear in at least one roadmap action with its exact bracketed ID. If prerequisites are not established, use a bounded validation/preparation action; do not invent current-state facts. If locked findings establish a supplied do-not-use condition, expose that conflict for independent Quality Checker review rather than disguising it.',
  '',
  `Step 2 — Category and semantic candidates (${plan.active_categories.join(', ') || 'none'}):`,
  plan.optional.length > 0
    ? plan.optional.map(candidate => compactCandidate(candidate, false)).join('\n\n')
    : 'No optional same-category candidate is available.',
  '',
  'Evaluate OPTIONAL tactics using the locked findings, use/do-not-use rules, semantic hints, expected artifacts, and risk controls. Select only semantically justified tactics. You may evaluate a cross-category approved tactic when the locked finding genuinely spans domains.',
  '',
  'Step 3 — Supplemental actions:',
  'If the approved catalog does not fully address a verified finding, add a grounded action without a tactic ID. Do not invent a TAC-* ID. Make its owner, artifact, acceptance condition, and adapted risk control explicit. Prefer an approved tactic whenever it genuinely implements the action.',
].join('\n');

export const findMissingRequiredTacticIds = (strategyData: any, plan: TacticSelectionPlan): string[] => {
  const text: string = (strategyData?.phase_3_strategy?.remediation_roadmap || [])
    .flatMap((phase: any) => Array.isArray(phase?.actions) ? phase.actions : [])
    .join('\n');
  const present = new Set<string>(Array.from(text.matchAll(TACTIC_RX), match => match[1]));
  return plan.required.map(candidate => candidate.tactic_id).filter(id => !present.has(id));
};

export const classifyFinalRequiredTactics = (
  strategyData: any,
  plan: TacticSelectionPlan,
  sanitizedClaims: StrategySanitationItem[] = []
): { contraindicated: string[]; missing: string[] } => {
  const absent = findMissingRequiredTacticIds(strategyData, plan);
  const reviewedContraindications = new Set(sanitizedClaims
    .filter(claim => claim.source_location === 'roadmap'
      && claim.severity === 'WARN_TACTIC_HYGIENE'
      && ['quarantined', 'removed'].includes(claim.action))
    .flatMap(claim => Array.from(claim.claim.matchAll(TACTIC_RX), match => match[1])));
  return {
    contraindicated: absent.filter(id => reviewedContraindications.has(id)),
    missing: absent.filter(id => !reviewedContraindications.has(id)),
  };
};

export const buildMissingRequiredTacticAppendix = (
  missingIds: string[],
  plan: TacticSelectionPlan
): string => {
  const missing = plan.required.filter(candidate => missingIds.includes(candidate.tactic_id));
  return [
    '### REQUIRED TACTIC CONTRACT CORRECTION',
    `The previous roadmap omitted required direct Playbook tactic IDs: ${missingIds.join(', ')}.`,
    'Regenerate the roadmap and include each exact bracketed ID in a grounded action. Preserve the locked findings. If implementation prerequisites are absent, prescribe a bounded validation/preparation action rather than omitting the required tactic or inventing evidence.',
    ...missing.map(candidate => compactCandidate(candidate, true)),
  ].join('\n\n');
};

const removeUnsupportedActionIfNeeded = (
  action: string,
  findingCorpus: string,
  adjustments: TacticGroundingAdjustment[]
): string | undefined => {
  const actionText = lower(action);
  const rule = UNSUPPORTED_ACTION_RULES.find(candidate =>
    includesAll(actionText, candidate.actionKeywords) &&
    !includesAny(findingCorpus, candidate.requiredFindingKeywords)
  );
  if (!rule) return action;
  adjustments.push({
    action_before: action,
    action_after: '',
    tactic_id: 'ACTION',
    reason: rule.reason
  });
  return undefined;
};

export const sanitizeRoadmapTacticGrounding = (
  strategyData: any,
  phase2: Phase2Validation,
  weakDomains: string[] = []
): TacticGroundingResult => {
  const strategy = strategyData?.phase_3_strategy;
  const roadmap = strategy?.remediation_roadmap;
  if (!strategy || !Array.isArray(roadmap)) {
    return { strategyData, adjustments: [], warnings: [] };
  }

  const data = JSON.parse(JSON.stringify(strategyData));
  const clonedRoadmap = data.phase_3_strategy.remediation_roadmap;
  const findingCorpus = buildFindingCorpus(phase2);
  const adjustments: TacticGroundingAdjustment[] = [];
  const weakDomainSet = new Set(weakDomains);
  const weakOnlyTacticFor = (action: string): string | undefined =>
    Array.from(action.matchAll(TACTIC_RX)).map(match => match[1]).find(id => {
      const domains = tacticDomainsById.get(id);
      return domains && domains.size > 0 && Array.from(domains).every(domain => weakDomainSet.has(domain));
    });

  for (const phase of clonedRoadmap) {
    if (!Array.isArray(phase.actions)) continue;
    phase.actions = phase.actions.map((rawAction: unknown) => {
      const action = typeof rawAction === 'string' ? rawAction : String(rawAction ?? '');
      const groundedAction = removeUnsupportedActionIfNeeded(action, findingCorpus, adjustments);
      if (groundedAction === undefined) return '';
      const weakOnlyTactic = weakOnlyTacticFor(groundedAction);
      if (!weakOnlyTactic) return groundedAction.trim().replace(/\s{2,}/g, ' ');
      adjustments.push({
        action_before: groundedAction,
        action_after: '',
        tactic_id: weakOnlyTactic,
        reason: `${weakOnlyTactic} was withheld because all mapped domains have incomplete source coverage. Collect domain evidence before prescribing remediation.`,
      });
      return '';
    }).filter((action: string) => action.length > 0);
  }
  data.phase_3_strategy.remediation_roadmap = clonedRoadmap.filter((phase: any) =>
    Array.isArray(phase.actions) && phase.actions.length > 0
  );

  const safeToActOn = data.phase_3_strategy.planning_decision?.safe_to_act_on;
  if (Array.isArray(safeToActOn)) {
    data.phase_3_strategy.planning_decision.safe_to_act_on = safeToActOn.filter((rawAction: unknown) => {
      const action = typeof rawAction === 'string' ? rawAction : String(rawAction ?? '');
      const weakOnlyTactic = weakOnlyTacticFor(action);
      if (!weakOnlyTactic) return true;
      adjustments.push({
        action_before: action,
        action_after: '',
        tactic_id: weakOnlyTactic,
        reason: `${weakOnlyTactic} was withheld from Safe To Act On because all mapped domains have incomplete source coverage.`,
      });
      return false;
    });
  }

  const warnings = adjustments.map(adjustment =>
    adjustment.tactic_id === 'ACTION'
      ? `Roadmap grounding removed unsupported action: ${adjustment.reason}`
      : `Roadmap tactic grounding removed ${adjustment.tactic_id}: ${adjustment.reason}`
  );
  return { strategyData: data, adjustments, warnings };
};
