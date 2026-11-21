import type { QualityGateDecision } from '../types';

export const insufficientEvidenceLabel = 'Insufficient evidence';
export const sourceObservationLabel = 'Source observations outside FinOps scope';
export const confirmedStrengthsLabel = 'Confirmed strengths';

export const isInsufficientEvidenceReport = (
  maturityClassification?: string,
  evidenceDensity?: number,
  _qualityGateDecision?: QualityGateDecision
): boolean => {
  if (typeof evidenceDensity === 'number' && evidenceDensity < 30) return true;
  return (maturityClassification || '').toLowerCase().includes('insufficient');
};

export const strengthsSectionTitle = (isInsufficientEvidence: boolean): string =>
  isInsufficientEvidence ? sourceObservationLabel : confirmedStrengthsLabel;

export const displaySourceCoverageWarning = (warning: string): string => {
  const match = warning.match(
    /^Source packet ([A-F]) has incomplete deterministic routing coverage \((\d+)\/(\d+) relevant chunks\); no broad-source fallback was used\.$/
  );
  if (!match) return warning;
  const [, domain, included, candidates] = match;
  return `Source packet ${domain} included ${included}/${candidates} routed candidate chunks. Domain coverage is limited. Individually assessed criteria retain their verified scope.`;
};

export const displayPlanningDecisionRationale = (
  rationale: string,
  qualityGateDecision?: QualityGateDecision,
  evidenceCheckFailed?: boolean
): string => {
  if (
    qualityGateDecision === 'BLOCK'
    && evidenceCheckFailed === false
    && rationale === 'Required validation did not complete or the quality gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.'
  ) {
    return 'Validation completed, but the Quality Gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.';
  }
  return rationale;
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stripMarkdownLinks = (text: string): string =>
  text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

export const renderInlineMarkdownHtml = (text: string): string => {
  const escaped = escapeHtml(stripMarkdownLinks(text));
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
};

export const renderMarkdownSummaryHtml = (content: string): string => {
  if (!content.trim()) return '';
  return content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      const body = lines.map(renderInlineMarkdownHtml).join('<br>');
      return `<p class="summary-paragraph">${body}</p>`;
    })
    .join('');
};

export interface ReaderCriterion {
  title: string;
  status?: string;
  locators: string[];
}

export interface ReaderParagraph {
  text: string;
  basis: string[];
}

const criterionToken = '(?:AP-)?[A-F][1-5]';
const criterionGroup = new RegExp(`^(${criterionToken})(?:\\s*[-–]\\s*((?:AP-)?[A-F]?[1-5]))?$`);

// Expand only unambiguous ranges within one stream and domain.
function criterionIds(group: string): string[] {
  const ids: string[] = [];
  for (const part of group.split(/\s*(?:,|;|\band\b)\s*/)) {
    const match = criterionGroup.exec(part.trim());
    if (!match) return [];
    const [, first, end] = match;
    const prefix = first.slice(0, -1);
    const endPrefix = end?.slice(0, -1);
    if (endPrefix && endPrefix !== prefix && endPrefix !== prefix.replace('AP-', '')) return [];
    const last = Number((end || first).slice(-1));
    if (last < Number(first.slice(-1))) return [];
    for (let n = Number(first.slice(-1)); n <= last; n++) ids.push(prefix + n);
  }
  return ids;
}

export function formatReaderParagraph(value: string, criteria: Map<string, ReaderCriterion>, tactics: Set<string>): ReaderParagraph {
  const basis = new Set<string>();
  const phrase = (id: string, entry: ReaderCriterion) => {
    if (id === 'AP-E2' && entry.status === 'not assessed') return 'whether cost overruns trigger blame';
    const name = entry.title.replace(/ & /g, ' and ').replace(/\b[A-Z][a-z]+\b/g, word => word.toLowerCase());
    return id.startsWith('AP-') && entry.status === 'not assessed' ? `whether the pattern “${name}” occurs` : name;
  };
  const text = value.replace(/\[[^\]\n]+\](?!\()|(?<![\w./-])(?:AP-[A-F][1-5]|[A-F][1-5]|TAC-[A-Z]+-\d{3}(?:-[A-Z]+)?)(?![\w/-]|\.\w)/g,
    (token, offset: number) => {
      const bracket = token.startsWith('[');
      const key = bracket ? token.slice(1, -1) : token;
      if (tactics.has(key)) {
        basis.add(`Playbook tactic [${key}]`);
        return 'the playbook tactic';
      }
      const before = value.slice(0, offset);
      if (!bracket && !key.startsWith('AP-') && !/\b(?:criterion|criteria|capability|finding)\s+$/i.test(before)) return token;
      const ids = criterionIds(key);
      if (!ids.length || ids.some(id => !criteria.has(id))) return token;
      const names = ids.map(id => {
        const entry = criteria.get(id)!;
        basis.add(`Assessment criterion ${id}${entry.status ? ' · ' + entry.status : ''}`);
        for (const locator of entry.locators) basis.add(`Customer evidence ${locator}`);
        return phrase(id, entry);
      });
      const suffix = value.slice(offset + token.length);
      if (bracket && /\w\s+$/.test(before) && /^\s*(?:[.;,]|$)/.test(suffix)
        && !/\b(?:assess|review|verify|validate|check|for|of|and|criterion|criteria|on|address)\s+$/i.test(before)) return '';
      const words = names.join(' and ');
      return offset === 0 ? words.charAt(0).toUpperCase() + words.slice(1) : words;
    }).replace(/ +([.,;])/g, '$1').replace(/ {2,}/g, ' ').trim();
  return { text, basis: Array.from(basis) };
}
