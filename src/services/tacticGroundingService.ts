import type { Phase2Validation, StrategicTactic } from '../types';
import { FINOPS_TACTICS_LOCAL } from '../knowledge_base';

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

interface TacticSemanticRule {
  requiredFindingKeywords?: string[];
  actionKeywords?: string[];
  replacementWhenActionMatches?: Array<{ keywords: string[]; id: string }>;
}

interface UnsupportedActionRule {
  actionKeywords: string[];
  requiredFindingKeywords: string[];
  reason: string;
}

const TACTIC_RULES: Record<string, TacticSemanticRule> = {
  'TAC-VIS-001': {
    requiredFindingKeywords: ['tag', 'allocation', 'showback', 'chargeback', 'owner tag', 'cost center']
  },
  'TAC-VIS-002': {
    requiredFindingKeywords: ['dashboard', 'visibility', 'engineering visibility', 'black box', 'cost view']
  },
  'TAC-VIS-003': {
    requiredFindingKeywords: ['multi-cloud', 'multiple providers', 'siloed cost', 'normalization']
  },
  'TAC-VIS-004': {
    requiredFindingKeywords: ['anomaly', 'alert', 'unexpected spend', 'cost spike']
  },
  'TAC-OPT-001': {
    requiredFindingKeywords: ['commitment', 'reservation', 'savings plan', 'on-demand', 'coverage', 'utilisation', 'utilization'],
    replacementWhenActionMatches: [
      { keywords: ['spot', 'preemptible', 'interruption'], id: 'TAC-OPT-004' }
    ]
  },
  'TAC-OPT-002': {
    requiredFindingKeywords: ['right-size', 'rightsizing', 'over-provision', 'underutilized', 'utilisation', 'utilization']
  },
  'TAC-OPT-003': {
    requiredFindingKeywords: ['zombie', 'orphaned', 'idle', 'unused resource', 'lifecycle']
  },
  'TAC-OPT-004': {
    requiredFindingKeywords: ['spot', 'preemptible', 'fault-tolerant', 'interruption', 'fallback']
  },
  'TAC-OPT-005': {
    requiredFindingKeywords: ['storage', 'lifecycle', 'retention', 'tiering']
  },
  'TAC-GOV-001': {
    requiredFindingKeywords: ['no cloud financial policy', 'missing policy', 'policy framework', 'spend limit', 'financial policy'],
    replacementWhenActionMatches: [
      { keywords: ['infracost', 'terraform', 'pull request', 'repository', 'pipeline', 'ci/cd'], id: 'TAC-ARCH-002' }
    ]
  },
  'TAC-GOV-002': {
    requiredFindingKeywords: ['shadow it', 'unmanaged account', 'account vending', 'rogue account']
  },
  'TAC-GOV-003': {
    requiredFindingKeywords: ['budget', 'blowout', 'overspend', 'enforcement', 'no consequence']
  },
  'TAC-GOV-004': {
    requiredFindingKeywords: ['theater', 'theatre', 'no operational outcome', 'no measurable outcome', 'vanity metric']
  },
  'TAC-ARCH-001': {
    requiredFindingKeywords: ['lift-and-shift', 'post-migration', 'legacy architecture', 'cloud-native']
  },
  'TAC-ARCH-002': {
    requiredFindingKeywords: ['architecture review', 'infracost', 'terraform', 'iac', 'cost estimation', 'cost-blind']
  },
  'TAC-ARCH-003': {
    requiredFindingKeywords: ['autoscaling', 'scaling policy', 'cost guardrail']
  },
  'TAC-CULT-001': {
    requiredFindingKeywords: ['cost accountability', 'unit economics', 'owner', 'engineering ownership']
  },
  'TAC-CULT-002': {
    requiredFindingKeywords: ['finance-engineering wall', 'cross-functional', 'collaboration gap', 'cadence']
  },
  'TAC-CULT-003': {
    requiredFindingKeywords: ['lip service', 'no investment', 'no sponsorship', 'no headcount', 'business case']
  },
  'TAC-CULT-004': {
    requiredFindingKeywords: ['blame', 'blameless', 'punitive', 'punishment', 'adversarial']
  }
};

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

const tacticById = new Map<string, StrategicTactic>(FINOPS_TACTICS_LOCAL.map(t => [t.id, t]));

const applyReplacementOrRemoval = (
  action: string,
  id: string,
  replacementId: string | undefined,
  reason: string,
  adjustments: TacticGroundingAdjustment[]
): string => {
  const before = action;
  const after = replacementId
    ? action.replace(`[${id}]`, `[${replacementId}]`)
    : action.replace(new RegExp(`\\s*\\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'g'), '');
  if (after !== before) {
    adjustments.push({
      action_before: before,
      action_after: after,
      tactic_id: id,
      replacement_id: replacementId,
      reason
    });
  }
  return after;
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
  phase2: Phase2Validation
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

  for (const phase of clonedRoadmap) {
    if (!Array.isArray(phase.actions)) continue;
    phase.actions = phase.actions.map((rawAction: unknown) => {
      let action = typeof rawAction === 'string' ? rawAction : String(rawAction ?? '');
      const groundedAction = removeUnsupportedActionIfNeeded(action, findingCorpus, adjustments);
      if (groundedAction === undefined) return '';
      action = groundedAction;
      const actionText = lower(action);
      const ids = Array.from(action.matchAll(TACTIC_RX)).map(m => m[1]);
      for (const id of ids) {
        const rule = TACTIC_RULES[id];
        const tactic = tacticById.get(id);
        if (!rule || !tactic) continue;

        const replacement = rule.replacementWhenActionMatches
          ?.find(candidate => includesAny(actionText, candidate.keywords));
        if (replacement) {
          action = applyReplacementOrRemoval(
            action,
            id,
            replacement.id,
            `${id} was replaced because the action language matches ${replacement.id}, not ${tactic.canonical_name || id}.`,
            adjustments
          );
          continue;
        }

        const matchesAction = includesAny(actionText, rule.requiredFindingKeywords);
        const matchesFinding = includesAny(findingCorpus, rule.requiredFindingKeywords);
        if (!matchesAction || !matchesFinding) {
          action = applyReplacementOrRemoval(
            action,
            id,
            undefined,
            `${id} was removed because its problem pattern was not present in both the action and the locked findings.`,
            adjustments
          );
        }
      }
      return action.trim().replace(/\s{2,}/g, ' ');
    }).filter((action: string) => action.length > 0);
  }

  const warnings = adjustments.map(a =>
    a.tactic_id === 'ACTION'
      ? `Roadmap grounding removed unsupported action: ${a.reason}`
      : a.replacement_id
      ? `Roadmap tactic grounding adjusted ${a.tactic_id} → ${a.replacement_id}: ${a.reason}`
      : `Roadmap tactic grounding removed ${a.tactic_id}: ${a.reason}`
  );

  return { strategyData: data, adjustments, warnings };
};
