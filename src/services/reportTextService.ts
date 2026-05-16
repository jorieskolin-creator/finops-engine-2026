import type { QualityGateDecision } from '../types';

export const insufficientEvidenceLabel = 'Insufficient evidence';
export const sourceObservationLabel = 'Source observations outside FinOps scope';
export const confirmedStrengthsLabel = 'Confirmed strengths';

export const isInsufficientEvidenceReport = (
  maturityClassification?: string,
  evidenceDensity?: number,
  qualityGateDecision?: QualityGateDecision
): boolean => {
  if (qualityGateDecision === 'BLOCK') return true;
  if (typeof evidenceDensity === 'number' && evidenceDensity < 30) return true;
  return (maturityClassification || '').toLowerCase().includes('insufficient');
};

export const strengthsSectionTitle = (isInsufficientEvidence: boolean): string =>
  isInsufficientEvidence ? sourceObservationLabel : confirmedStrengthsLabel;

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
