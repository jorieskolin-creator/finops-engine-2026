export interface NarrativeCheck {
  id: string;
  label: string;
  expected: string[];
  sources?: Array<{ file: string; locator: string }>;
}

export interface Comparison {
  referenceVersion: string;
  packageVersion?: string;
  referenceSha256?: string;
  referenceApproved?: boolean;
  checks: Array<{ label: string; expected: string | number | boolean; observed: string | number | boolean; matches: boolean }>;
  narrativeChecks?: NarrativeCheck[];
}

export const dispositions = ['Supported', 'Missing', 'Contradicted', 'Needs judgment'] as const;
export type Disposition = typeof dispositions[number];
type Status = 'Pass' | 'Fail' | 'Review';

export interface NarrativeReview {
  runId: string;
  referenceIdentity: string;
  reviewer: string;
  reviewedAt: string;
  judgments: Record<string, Disposition>;
  note: string;
}

export function referenceIdentity(comparison?: Comparison): string | undefined {
  if (!comparison?.packageVersion || !comparison.referenceSha256) return;
  return [comparison.packageVersion, comparison.referenceVersion, comparison.referenceSha256].join('/');
}

export function matchingReview(runId: string, comparison: Comparison | undefined, review?: NarrativeReview) {
  const identity = referenceIdentity(comparison);
  return identity && review?.runId === runId && review.referenceIdentity === identity ? review : undefined;
}

export function narrativeStatus(comparison?: Comparison, review?: NarrativeReview): Status {
  const checks = comparison?.narrativeChecks;
  if (!review || !checks?.length) return 'Review';
  const judgments = checks.map(check => review.judgments[check.id]);
  if (judgments.some(value => value === 'Missing' || value === 'Contradicted')) return 'Fail';
  return judgments.every(value => value === 'Supported') ? 'Pass' : 'Review';
}

export function monitoringStatus(comparison?: Comparison, review?: NarrativeReview): Status | 'Incomplete' {
  if (!comparison) return 'Incomplete';
  const narrative = narrativeStatus(comparison, review);
  if (comparison.checks.some(check => !check.matches) || narrative === 'Fail') return 'Fail';
  return comparison.referenceApproved && narrative === 'Pass' ? 'Pass' : 'Review';
}

export interface RenderedNarrative {
  diagnosis: string[];
  planning: string[];
  masterData: string[];
}

export function collectRenderedNarrative(summary: Document, masterData: Document): RenderedNarrative {
  const section = (heading: string) => Array.from(summary.querySelectorAll('.summary-section > h2'))
    .find(element => element.textContent?.trim() === heading)?.parentElement;
  const lines = (root: ParentNode | undefined | null, selector: string) =>
    Array.from(root?.querySelectorAll(selector) ?? []).flatMap(element => {
      const copy = element.cloneNode(true) as Element;
      for (const basis of copy.querySelectorAll('.evidence-basis')) basis.before(' · ');
      const text = copy.textContent?.replace(/\s+/g, ' ').trim();
      return text ? [text] : [];
    });
  const findings = (heading: string) => Array.from(summary.querySelectorAll('.findings-mode .summary-sub > h3'))
    .find(element => element.textContent?.trim() === heading)?.parentElement;
  return {
    diagnosis: [
      ...lines(section('Diagnosis'), '.diagnosis-lead p, .two-col li, .confidence-line'),
      ...lines(findings('Evidence-backed findings'), 'li'),
    ],
    planning: [
      ...lines(section('Planning Decision'), '.decision-rationale, .two-col h3, .two-col li'),
      ...lines(section('Remediation Roadmap'), '.withheld-card strong, .withheld-card p, .summary-roadmap-phase h3, .summary-roadmap-phase p, .summary-roadmap-phase li'),
      ...lines(findings('Candidate remediation themes'), 'h3, li'),
      ...lines(findings('Missing evidence'), 'h3, li'),
      ...lines(findings('Validation plan'), 'h3, li'),
    ],
    masterData: lines(masterData.querySelector('.evidence-findings'), 'h3, h4, li'),
  };
}
