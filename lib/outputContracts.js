export const OUTPUT_CONTRACT_IDS = Object.freeze({
  evidenceGapQuery: 'finops_evidence_gap_query_v1',
  evidenceSynthesis: 'finops_evidence_synthesis_v1',
  roadmapSynthesis: 'finops_roadmap_synthesis_v1',
  findingsSynthesis: 'finops_findings_synthesis_v1',
  summaryFactCheck: 'finops_summary_fact_check_v1',
  roadmapFactCheck: 'finops_roadmap_fact_check_v2',
});

const string = (extra = {}) => ({ type: 'string', ...extra });
const stringArray = (extra = {}) => ({ type: 'array', items: string(), ...extra });
const boundedQueryTextArray = (extra = {}) => ({
  type: 'array',
  items: string({ minLength: 2, maxLength: 80 }),
  ...extra,
});
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const executiveSummaries = object({
  finops_lead: string(),
  cfo: string(),
  engineering_lead: string(),
});
const evidenceSummary = object({
  headline: string(),
  maturity_classification: string({ enum: ['Insufficient evidence', 'Crawl', 'Walk', 'Walk with significant friction', 'Run'] }),
  key_metrics: stringArray(),
  confirmed_strengths: stringArray(),
  confirmed_gaps: stringArray(),
  confirmed_antipatterns: stringArray(),
  silent_or_missing_evidence: stringArray(),
});
const diagnosis = object({
  primary_bottleneck: string(),
  root_causes: stringArray(),
  domain_diagnosis: object({ A: string(), B: string(), C: string(), D: string(), E: string(), F: string() }),
  confidence: string({ enum: ['high', 'medium', 'low'] }),
  confidence_rationale: string(),
});
const visualScorecard = object({
  headline: string(),
  maturity_score: string(),
  burden_score: string(),
});
const planningDecision = object({
  decision: string({ enum: ['GO', 'CONDITIONAL_GO', 'NO_GO'] }),
  rationale: string(),
  safe_to_act_on: stringArray(),
  evidence_needed_before_action: stringArray(),
});

const evidenceGapQuerySchema = object({
  schema_version: string({ enum: ['finops_evidence_gap_query_v1'] }),
  domain_id: string({ minLength: 1, maxLength: 1 }),
  queries: {
    type: 'array',
    minItems: 1,
    maxItems: 10,
    items: object({
      criterion_id: string({ minLength: 2, maxLength: 24 }),
      themes: boundedQueryTextArray({ minItems: 1, maxItems: 4 }),
      terms: boundedQueryTextArray({ minItems: 1, maxItems: 8 }),
    }),
  },
});

const evidenceSchema = object({
  phase_3_strategy: object({
    executive_summaries: executiveSummaries,
    evidence_summary: evidenceSummary,
    diagnosis,
    visual_scorecard: visualScorecard,
  }),
});

const roadmapItem = object({
  phase: string(),
  why: string(),
  what: string(),
  actions: stringArray(),
  confidence: string({ enum: ['high', 'medium', 'low'] }),
  assumptions: stringArray({ maxItems: 4 }),
});
const roadmapSchema = object({
  phase_3_strategy: object({
    planning_decision: planningDecision,
    remediation_roadmap: { type: 'array', items: roadmapItem },
  }),
});

const findingsSchema = object({
  phase_3_strategy: object({
    executive_summaries: executiveSummaries,
    evidence_summary: evidenceSummary,
    diagnosis,
    planning_decision: planningDecision,
    visual_scorecard: visualScorecard,
    remediation_roadmap: { type: 'array', items: roadmapItem, maxItems: 0 },
    findings_mode: object({
      evidence_backed_findings: stringArray({ minItems: 4, maxItems: 8 }),
      candidate_themes: stringArray({ minItems: 3, maxItems: 6 }),
      missing_evidence: stringArray({ minItems: 4, maxItems: 8 }),
      validation_plan: stringArray({ minItems: 3, maxItems: 6 }),
    }),
  }),
});

const factCheckSchema = (classifications, sourceLocations, unsupportedSeverities, includeTacticDisposition = false) => object({
  claims: {
    type: 'array',
    minItems: 1,
    maxItems: 15,
    items: object({
      claim: string(),
      classification: string({ enum: classifications }),
      rationale: string(),
      source_location: string({ enum: sourceLocations }),
      failure_type: string({ enum: ['fabricated_number', 'unverifiable_entity', 'unsupported_org_claim', 'out_of_scope', 'other', 'not_applicable'] }),
      severity: string({ enum: [...unsupportedSeverities, 'SUPPORTED'] }),
      ...(includeTacticDisposition ? {
        tactic_disposition: string({ enum: ['not_applicable', 'contraindicated', 'citation_rejected'] }),
      } : {}),
      missing_material: string(),
    }),
  },
});

const summaryFactCheckSchema = factCheckSchema(
  ['supported_by_source', 'supported_by_audit', 'unsupported'],
  ['finops_lead', 'cfo', 'engineering_lead', 'diagnosis'],
  ['BLOCKING_UNSUPPORTED_FACT', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE'],
);
const roadmapFactCheckSchema = factCheckSchema(
  ['supported_by_source', 'supported_by_audit', 'supported_by_tactics_db', 'unsupported'],
  ['planning_decision', 'roadmap'],
  ['BLOCKING_UNSUPPORTED_FACT', 'BLOCKING_UNSAFE_ROADMAP', 'WARN_MISCLASSIFIED_BUT_REAL', 'WARN_TACTIC_HYGIENE'],
  true,
);

const CONTRACTS = Object.freeze({
  [OUTPUT_CONTRACT_IDS.evidenceGapQuery]: Object.freeze({
    stages: Object.freeze(['evidence_gap_analysis']),
    schema: evidenceGapQuerySchema,
  }),
  [OUTPUT_CONTRACT_IDS.evidenceSynthesis]: Object.freeze({
    stages: Object.freeze(['synthesis', 'synthesis_escalation']),
    schema: evidenceSchema,
  }),
  [OUTPUT_CONTRACT_IDS.roadmapSynthesis]: Object.freeze({
    stages: Object.freeze(['roadmap_synthesis']),
    schema: roadmapSchema,
  }),
  [OUTPUT_CONTRACT_IDS.findingsSynthesis]: Object.freeze({
    stages: Object.freeze(['synthesis', 'synthesis_escalation']),
    schema: findingsSchema,
  }),
  [OUTPUT_CONTRACT_IDS.summaryFactCheck]: Object.freeze({
    stages: Object.freeze(['fact_check', 'fact_check_high']),
    schema: summaryFactCheckSchema,
  }),
  [OUTPUT_CONTRACT_IDS.roadmapFactCheck]: Object.freeze({
    stages: Object.freeze(['fact_check', 'fact_check_high']),
    schema: roadmapFactCheckSchema,
  }),
});

export class OutputContractError extends Error {
  constructor(category) {
    super('INVALID_OUTPUT_CONTRACT');
    this.name = 'OutputContractError';
    this.code = 'INVALID_OUTPUT_CONTRACT';
    this.category = category;
  }
}

export class SynthesisOutputExhaustedError extends Error {
  constructor() {
    super('The synthesis models returned invalid structured output after a safe retry and provider fallback. No assessment was finalized. Start a new analysis.');
    this.name = 'SynthesisOutputExhaustedError';
    this.code = 'SYNTHESIS_OUTPUT_INVALID';
  }
}

const isRetryableOutputError = error => error?.code === 'SYNTHESIS_OUTPUT_INVALID'
  || error?.code === 'INVALID_OUTPUT_CONTRACT'
  || error?.message === 'AI response was malformed and could not be repaired safely.';

export async function withOneOutputRegeneration(execute, onRetry = () => undefined) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await execute(attempt > 0); }
    catch (error) {
      if (!isRetryableOutputError(error)) throw error;
      if (attempt >= 1) throw new SynthesisOutputExhaustedError();
      await onRetry();
    }
  }
  throw new SynthesisOutputExhaustedError();
}

export function getOutputContract(id) {
  return typeof id === 'string' ? CONTRACTS[id] : undefined;
}

export function authorizeOutputContract(stage, id) {
  if (id === undefined) return true;
  const contract = getOutputContract(id);
  if (!contract || !contract.stages.includes(stage)) throw new OutputContractError('unauthorized_contract');
  return true;
}

const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const validateValue = (value, schema) => {
  if (schema.type === 'string') {
    if (typeof value !== 'string'
      || (schema.enum && !schema.enum.includes(value))
      || (schema.minLength !== undefined && value.length < schema.minLength)
      || (schema.maxLength !== undefined && value.length > schema.maxLength)) return false;
    return true;
  }
  if (schema.type === 'array') {
    return Array.isArray(value)
      && (schema.minItems === undefined || value.length >= schema.minItems)
      && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && value.every(item => validateValue(item, schema.items));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.some(key => dangerousKeys.has(key))) return false;
    if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && keys.some(key => !Object.hasOwn(schema.properties, key))) return false;
    return keys.every(key => !schema.properties[key] || validateValue(value[key], schema.properties[key]));
  }
  return false;
};

export function validateOutputContractValue(id, value) {
  const contract = getOutputContract(id);
  if (!contract) throw new OutputContractError('unknown_contract');
  if (!validateValue(value, contract.schema)) throw new OutputContractError('schema_mismatch');
  return value;
}

export function validateOutputContractText(id, text) {
  if (typeof text !== 'string' || !text.trim()) throw new OutputContractError('empty_output');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new OutputContractError('json_syntax'); }
  return validateOutputContractValue(id, parsed);
}

export function outputContractDiagnostics(text, error) {
  let objectCount = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of typeof text === 'string' ? text : '') {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && depth > 0 && --depth === 0) objectCount++;
  }
  return {
    output_chars: typeof text === 'string' ? text.length : 0,
    balanced_object_count: depth === 0 && !inString ? objectCount : 0,
    failure_category: error instanceof OutputContractError ? error.category : 'validation_error',
  };
}

const anthropicUnsupportedConstraints = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
]);

const schemaForProvider = (schema, provider) => {
  if (provider !== 'anthropic' || !schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(value => schemaForProvider(value, provider));
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    // Anthropic's REST API rejects these otherwise-valid JSON Schema
    // constraints. The full contract remains enforced by the worker.
    if (anthropicUnsupportedConstraints.has(key)) return [];
    if (key === 'minItems' && value !== 0 && value !== 1) return [];
    return [[key, schemaForProvider(value, provider)]];
  }));
};

export function structuredOutputForPacket(packet) {
  if (!packet.output_contract) return undefined;
  authorizeOutputContract(packet.stage, packet.output_contract);
  const contract = getOutputContract(packet.output_contract);
  return { name: packet.output_contract, schema: schemaForProvider(contract.schema, packet.provider) };
}
