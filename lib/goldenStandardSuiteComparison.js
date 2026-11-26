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

export function compareSuiteCase(caseId, card, sha256, observation, { serverVerified } = {}) {
  const check = (label, expected, observed) => ({
    label, expected, observed,
    matches: expected === null || observed === null ? null : expected === observed,
  });
  const decisions = card.proposed_decisions ?? {};
  const checks = caseId === 'clear-block' ? compareClearBlock(card, observation).checks : [
    check('Assessment Sufficiency', decisions.evidence_sufficiency ?? null, observation.evidenceSufficiency),
    check('Quality Gate', decisions.quality_gate ?? null, observation.qualityGate),
    check('Planning decision', decisions.planning_decision ?? null, observation.planningDecision),
    check('Frozen inputs in RunTrace', true, observation.loadedInputsInTrace),
    check('Unrelated PDF excluded from evidence packets', true, observation.excludedDocument),
    ...(observation.qualityGate === 'BLOCK' ? [check('Directive roadmap withheld in Summary', true, observation.directiveRoadmapWithheld)] : []),
    ...(observation.evidenceSufficiency === 'BLOCK' ? [check('Maturity classification withheld in Summary', true, observation.maturityClassificationWithheld)] : []),
    ...numericChecks[caseId].map(([fact, value, label], index) => {
      const expected = card.facts.find(entry => entry.id === fact).local_numeric_expectation[value];
      return check(label, Number(expected), observation.numbers[index]);
    }),
  ];
  if (observation.monitoring && Number.isInteger(observation.monitoring.expectedCustomerSources)
    && observation.monitoring.expectedCustomerSources > 0) {
    checks.push(check(
      'Required customer inputs admitted to domain packets',
      observation.monitoring.expectedCustomerSources,
      observation.monitoring.admittedCustomerSources,
    ));
  }
  const expectedGate = decisions.quality_gate ?? decisions.intended_calibration_gate ?? null;
  const expectsBlock = decisions.quality_gate === 'BLOCK' || decisions.evidence_sufficiency === 'BLOCK';
  const falseGoOnExpectedBlock = Boolean(
    expectsBlock && (observation.qualityGate === 'GO' || observation.planningDecision === 'GO'),
  );
  const comparison = comparisonForCard(card, sha256, checks);
  return {
    reviewCard: comparison,
    compact: {
      referenceVersion: comparison.referenceVersion,
      referenceSha256: sha256,
      referenceApproved: comparison.referenceApproved,
      checkIds: comparison.narrativeChecks.map(entry => entry.id),
      // Labels below are application-owned constants. Private reference card prose never enters the database.
      checks,
      kbHash: observation.kbHash,
      assessed: observation.assessed,
      expectedDecisions: {
        evidenceSufficiency: decisions.evidence_sufficiency ?? null,
        qualityGate: expectedGate,
        planningDecision: decisions.planning_decision ?? null,
      },
      observedDecisions: {
        evidenceSufficiency: observation.evidenceSufficiency,
        qualityGate: observation.qualityGate,
        planningDecision: observation.planningDecision,
        crawlWalkRun: observation.monitoring?.crawlWalkRun ?? null,
      },
      falseGoOnExpectedBlock,
      ...(observation.monitoring ? { monitoring: observation.monitoring } : {}),
      ...(typeof serverVerified === 'boolean' ? { serverVerified } : {}),
    },
  };
}
