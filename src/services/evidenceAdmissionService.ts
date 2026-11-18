import type { SourceChunkRoutingHint, StructuredTableData } from '../types';
import aliases from '../knowledge_base/finops_term_aliases.json';
import crucialItems from '../knowledge_base/finops_crucial_items.json';
import keywords from '../knowledge_base/finops_preflight_keywords.json';

const normalize = (text: string): string => text
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const contains = (text: string, term: string): boolean => text.includes(` ${term} `);
const phrase = (text: string): string => ` ${normalize(text)} `;
const splitHeaderWords = (text: string): string => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

// These anchors establish the subject of the passage. Generic terms in the
// pre-flight and domain vocabularies still help discover and rank evidence.
const contextTerms = [
  ...keywords.categories.core_finops_vocabulary.keywords.filter(term =>
    /^(finops|cloud |cost allocation$)/.test(term)),
  'cloud', 'azure', 'aws', 'gcp', 'google cloud', 'kubernetes', 'aks',
  'saas', 'data platform', 'technology spend', 'it spend', 'billed cost', 'virtual machine',
  'virtual machines', 'vm', 'compute items', 'storage tier', 'unattached disk',
  'genai', 'generative ai', 'llm', 'openai', 'anthropic',
  'ai cost', 'ai spend', 'ai inference cost', 'ai change record', 'token spend', 'model spend',
  'pilvikustannukset', 'pilvipalvelut', 'pilven kustannukset', 'tekoalyn kustannukset',
].map(normalize);

const customerContext = /\b(?:we|our|meidan|production|nonprod|customer|tenant|subscription|invoice|billing period|billing export|cost report|review minutes|action log|billing account|configured|enabled|enforced|required|recorded|reviewed|reviews|approved|implemented|deployed|closed|awaiting owner|tuotanto|lasku|tilaus|kaytossa|seurataan|toteutettu)\b/u;
const referenceOnly = /^(?:(?:finops |cloud |ai )?(?:training material|tutorial|glossary|worked example|hypothetical example|reference material))\b/u;
const technologyCostComparison = /\b(?:architecture decision|architecture review)\b.*\b(?:eur|usd|gbp) \d.{0,15}\bmonth\b/u;
const hasTaggedControlRecord = (text: string): boolean => {
  const row = phrase(splitHeaderWords(text));
  return contains(row, 'control id') && contains(row, 'status') && /\bcost cent(?:er|re) tag\b/u.test(row);
};

const specificSingleTerms = new Set([
  'showback', 'chargeback', 'rightsizing', 'preemptible', 'tiering', 'untagged',
  'kubecost', 'infracost', 'terraform', 'pulumi', 'cloudformation',
  'autoscaling', 'kubernetes', 'serverless', 'yksikkokustannus', 'kustannuspaikka',
  'tunnistepolitiikka', 'budjettipoikkeama', 'kustannusvastuu',
]);

const specific = (term: string): boolean => term.includes(' ') || specificSingleTerms.has(term);

const termsByDomain = new Map<string, Set<string>>();
for (const criterion of crucialItems.criteria) {
  const domain = criterion.criterion_id[0];
  const terms = termsByDomain.get(domain) ?? new Set<string>();
  for (const item of criterion.items) {
    for (const alias of item.aliases) {
      const term = normalize(alias);
      if (specific(term)) terms.add(term);
    }
  }
  termsByDomain.set(domain, terms);
}

export const routingVocabulary = (domain: string, domainTerms: string[]): string[] => {
  const terms = domainTerms.map(normalize);
  const vocabulary = new Set([...terms, ...(termsByDomain.get(domain) ?? [])]);
  for (const [concept, alternatives] of Object.entries(aliases.concepts)) {
    if (!vocabulary.has(normalize(concept))) continue;
    alternatives.map(normalize).filter(specific).forEach(term => vocabulary.add(term));
  }
  return [...vocabulary];
};

export const structuredEvidenceDomain = (table: StructuredTableData): string | undefined => {
  const names = table.headers.map(header => normalize(splitHeaderWords(header)));
  const any = (pattern: RegExp): boolean => names.some(name => pattern.test(name));
  const billingSheet = /\b(?:cloud|azure|aws|gcp|finops)\b/.test(normalize(table.sheet_name ?? ''));
  const hasAmount = any(/^(?:amount|invoice amount|net amount|charge amount|total|total cost)(?: [a-z]{3})?$/);
  const hasSubscription = any(/^subscription(?: (?:id|name))?$/);
  const hasBillingDimension = any(/^(?:billing currency|billing period|charge period start|cost reporting period|subscription id|resource id|provider name)$/);
  if (any(/^(?:input|prompt) tokens$/) && any(/^(?:output|completion) tokens$/)
    && any(/^(?:model|model id|model name)$/) && hasAmount) return 'F';
  if (any(/^resource(?: id| name)?$/) && any(/^owner tag$/) && any(/^(?:scope|environment|subscription(?: id)?)$/)) return 'A';
  const hasOptimizationItem = any(/^optimization (?:item|recommendation)$/)
    || ((billingSheet || hasBillingDimension) && any(/^recommendation title$/));
  if (hasOptimizationItem && any(/^(?:estimated|potential|projected) (?:monthly |annual )?savings(?: [a-z]{3})?$/)) return 'B';
  const actionColumn = names.indexOf('action');
  if (actionColumn >= 0 && any(/^ticket(?: id)?$/) && any(/^estimated monthly [a-z]{3}$/)
    && (table.analysis_rows ?? table.rows).some(row => /\b(?:rightsize vm|unattached disk|idle vm|aks rightsizing)\b/u.test(normalize(row[actionColumn] ?? '')))) return 'B';
  const hasBillingAmount = any(/^(?:billed|amortized|billing|pretax|pre tax) cost(?: [a-z]{3})?$/);
  const hasCost = any(/^(?:effective|total|net) cost(?: [a-z]{3})?$/);
  if ((hasBillingAmount && (hasBillingDimension || any(/^(?:currency|usage date|cost center|service name)$/)))
    || (hasCost && hasBillingDimension)
    || (hasAmount && hasSubscription && any(/^invoice (?:number|id|reference)$/))
    || (billingSheet && any(/^(?:cost|spend|billed cost)$/) && any(/^(?:owner|cost center|subscription|resource|service)$/))) return 'A';
  return undefined;
};

export const classifyEvidenceRouting = (
  text: string,
  vocabulary: Record<string, string[]>,
  structuredDomain?: string,
  isTableRow = false,
): SourceChunkRoutingHint[] => {
  const localText = phrase(text);
  const context = contextTerms.filter(term => contains(localText, term));
  if (technologyCostComparison.test(localText)) context.push('priced architecture comparison');
  if (contains(localText, 'platform line') && contains(localText, 'invoice')) context.push('platform invoice line');
  const hasTaggedControl = isTableRow && hasTaggedControlRecord(text);
  const customerScoped = context.length > 0 && customerContext.test(localText) && !referenceOnly.test(localText.trimStart());
  return Object.entries(vocabulary).map(([domain, domainTerms]) => {
    if (domain === structuredDomain || (hasTaggedControl && (domain === 'A' || domain === 'C'))) {
      return { domain, score: 6, tier: 'high', reasons: ['structured_finops_record'] };
    }
    const matches = domainTerms.filter(term => contains(localText, term));
    const theme = matches.some(term => specific(term) && context.some(anchor => anchor !== term));
    if (!customerScoped || !theme) {
      return { domain, score: 0, tier: matches.length ? 'low' : 'unknown', reasons: [] };
    }
    return {
      domain,
      score: matches.length + 2,
      tier: matches.filter(specific).length > 1 ? 'high' : 'medium',
      reasons: matches.slice(0, 4),
    };
  });
};
