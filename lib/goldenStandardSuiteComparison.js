import { compareClearBlock, comparisonForCard } from './goldenStandardClearBlock.js';

export const numericChecks = {
  'clear-block': [],
  'near-block-conditional-go': [
    ['scoped-budget-exception', 'exception', 'Budget exception (EUR)'],
    ['completed-and-open-actions', 'comparable_week_delta', 'Comparable-week reduction (EUR)'],
    ['completed-and-open-actions', 'reservation_utilization_percent', 'Sampled reservation utilization (%)'],
  ],
  'clear-warn': [
    ['weekly-rightsizing', 'delta', 'Comparable-week reduction (EUR)'],
    ['open-reservation', 'observed_percent', 'Sampled reservation utilization (%)'],
    ['open-reservation', 'threshold_percent', 'Sampled group utilization threshold (%)'],
  ],
  'near-warn-conditional-go': [
    ['sampled-terraform-control', 'approved_monthly', 'Revised monthly Terraform plan (EUR)'],
    ['scoped-ai-unit-cost', 'total', 'Reconciled workflow charges (EUR)'],
    ['scoped-ai-unit-cost', 'per_completed_task', 'Workflow cost per completed task (EUR)'],
  ],
  'clear-go': [
    ['sampled-terraform-control', 'approved_monthly', 'Revised monthly Terraform plan (EUR)'],
    ['scoped-ai-unit-cost', 'total', 'Reconciled workflow charges (EUR)'],
    ['scoped-ai-unit-cost', 'per_completed_task', 'Workflow cost per completed task (EUR)'],
    ['weekly-rightsizing', 'delta', 'Comparable-week reduction (EUR)'],
  ],
};

export function compareSuiteCase(caseId, card, sha256, observation) {
  const check = (label, expected, observed) => ({
    label, expected, observed,
    matches: expected === null || observed === null ? null : expected === observed,
  });
  const decisions = card.proposed_decisions;
  const checks = caseId === 'clear-block' ? compareClearBlock(card, observation).checks : [
    check('Assessment Sufficiency', decisions.evidence_sufficiency, observation.evidenceSufficiency),
    check('Quality Gate', decisions.quality_gate, observation.qualityGate),
    check('Planning decision', decisions.planning_decision, observation.planningDecision),
    check('Frozen inputs in RunTrace', true, observation.loadedInputsInTrace),
    check('Unrelated PDF excluded from evidence packets', true, observation.excludedDocument),
    ...(observation.qualityGate === 'BLOCK' ? [check('Directive roadmap withheld in Summary', true, observation.directiveRoadmapWithheld)] : []),
    ...(observation.evidenceSufficiency === 'BLOCK' ? [check('Maturity classification withheld in Summary', true, observation.maturityClassificationWithheld)] : []),
    ...numericChecks[caseId].map(([fact, value, label], index) => {
      const expected = card.facts.find(entry => entry.id === fact).local_numeric_expectation[value];
      return check(label, Number(expected), observation.numbers[index]);
    }),
  ];
  const comparison = comparisonForCard(card, sha256, checks);
  return {
    reviewCard: comparison,
    compact: {
      referenceVersion: comparison.referenceVersion,
      referenceSha256: sha256,
      referenceApproved: comparison.referenceApproved,
      checkIds: comparison.narrativeChecks.map(entry => entry.id),
      // Labels below are application-owned constants. The expected card prose and
      // assessment output never enter the database.
      checks,
      kbHash: observation.kbHash,
      assessed: observation.assessed,
    },
  };
}
