
import { ScanResult } from '../types';
import { FINOPS_KEYWORDS } from '../knowledge_base';

export const sanitizeInput = (text: string): string => {
  let clean = text;
  clean = clean.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');
  clean = clean.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP_REDACTED]');
  clean = clean.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[PHONE_REDACTED]');
  clean = clean.replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]');
  clean = clean.replace(/(?:sk-|pk_)[a-zA-Z0-9]{20,}/g, '[API_KEY_REDACTED]');
  return clean;
};

export const scanInputText = (text: string): ScanResult => {
  const cleanText = text.trim();
  const wordCount = cleanText.split(/\s+/).length;

  if (wordCount === 0) {
    return { score: 0, status: 'Insufficient', message: "Waiting for input...", details: [], canRun: false };
  }

  if (wordCount < 50) {
    return { score: 10, status: 'Insufficient', message: "Input too short", details: [`Word count: ${wordCount} (Min: 50).`], canRun: false };
  }

  const lowerText = cleanText.toLowerCase();
  const uniqueKeywords = new Set<string>();
  let weightedScore = 0;

  const categories = FINOPS_KEYWORDS.categories;

  for (const keyword of categories.core_finops_vocabulary.keywords) {
    if (lowerText.includes(keyword)) {
      uniqueKeywords.add(keyword);
      weightedScore += categories.core_finops_vocabulary.weight;
    }
  }

  for (const keyword of categories.standards_frameworks.keywords) {
    if (lowerText.includes(keyword)) {
      uniqueKeywords.add(keyword);
      weightedScore += categories.standards_frameworks.weight;
    }
  }

  for (const keyword of categories.emerging_scope.keywords) {
    if (lowerText.includes(keyword)) {
      uniqueKeywords.add(keyword);
      weightedScore += categories.emerging_scope.weight;
    }
  }

  let structureBonus = 0;
  const foundHeaders: string[] = [];
  for (const header of FINOPS_KEYWORDS.structural_headers) {
    if (lowerText.includes(header)) {
      structureBonus += 5;
      foundHeaders.push(header);
    }
  }
  structureBonus = Math.min(structureBonus, 20);

  let score = 0;
  const details: string[] = [];

  if (wordCount > 100) score += 10;
  if (wordCount > 500) score += 10;

  const keywordScore = Math.min(weightedScore, 60);
  score += keywordScore;
  score += structureBonus;
  score = Math.min(score, 100);

  const coreCount = categories.core_finops_vocabulary.keywords.filter(k => lowerText.includes(k)).length;
  const hasCoreTerm = coreCount > 0;

  let status: ScanResult['status'] = 'Insufficient';
  let message = "Irrelevant Content";
  let canRun = false;
  let confidence_warning: string | undefined;

  if (score >= 60 && hasCoreTerm) {
    status = 'Ready';
    message = "High Quality FinOps Signal";
    details.push(`Detected ${uniqueKeywords.size} FinOps-relevant topics (${coreCount} core terms)`);
    if (foundHeaders.length > 0) details.push(`Identified document structure (${foundHeaders.length} headers)`);
    canRun = true;
  } else if (score >= 30) {
    status = hasCoreTerm ? 'Weak' : 'PassWithWarning';
    message = hasCoreTerm ? "Weak FinOps Signal" : "Partial Relevance Detected";
    details.push("Some relevant keywords found, but FinOps-specific context may be thin.");
    if (!hasCoreTerm) {
      confidence_warning = "No core FinOps terms detected. Document may be tangentially relevant (cloud strategy, IT governance) but not a FinOps artifact.";
      details.push(confidence_warning);
    }
    canRun = true;
  } else {
    status = 'Insufficient';
    message = "Noise Detected";
    details.push("Document appears irrelevant to FinOps (e.g., unrelated business content, personal data, or generic text).");
    canRun = false;
  }

  return { score, status, message, details, canRun, confidence_warning };
};
