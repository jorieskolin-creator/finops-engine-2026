import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  authorizeOutputContract,
  OUTPUT_CONTRACT_IDS,
  outputContractDiagnostics,
  structuredOutputForPacket,
  validateOutputContractText,
  withOneOutputRegeneration,
} from '../lib/outputContracts.js';

const evidence = {
  phase_3_strategy: {
    executive_summaries: { finops_lead: 'Lead', cfo: 'CFO', engineering_lead: 'Engineering' },
    evidence_summary: {
      headline: 'Walk', maturity_classification: 'Walk', key_metrics: [], confirmed_strengths: [],
      confirmed_gaps: [], confirmed_antipatterns: [], silent_or_missing_evidence: [],
    },
    diagnosis: {
      primary_bottleneck: 'Ownership', root_causes: [],
      domain_diagnosis: { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F' },
      confidence: 'medium', confidence_rationale: 'Evidence is mixed.',
    },
    visual_scorecard: { headline: 'Walk', maturity_score: 'Medium', burden_score: 'Medium' },
  },
};

const evidenceText = JSON.stringify(evidence);
assert.deepEqual(validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceSynthesis, evidenceText), evidence);
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceSynthesis, `${evidenceText}\n{"other":true}`), /INVALID_OUTPUT_CONTRACT/);
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceSynthesis, evidenceText.slice(0, -1)), /INVALID_OUTPUT_CONTRACT/);
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceSynthesis, JSON.stringify({ ...evidence, extra: true })), /INVALID_OUTPUT_CONTRACT/);
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceSynthesis, JSON.stringify({ phase_3_strategy: {} })), /INVALID_OUTPUT_CONTRACT/);
assert.throws(() => authorizeOutputContract('roadmap_synthesis', OUTPUT_CONTRACT_IDS.evidenceSynthesis), /INVALID_OUTPUT_CONTRACT/);

const gapQuery = {
  schema_version: 'finops_evidence_gap_query_v1',
  domain_id: 'D',
  queries: [{ criterion_id: 'maturity.D1', themes: ['autoscaling controls'], terms: ['utilization threshold'] }],
};
assert.deepEqual(validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, JSON.stringify(gapQuery)), gapQuery);
assert.doesNotThrow(() => authorizeOutputContract('evidence_gap_analysis', OUTPUT_CONTRACT_IDS.evidenceGapQuery));
assert.throws(() => authorizeOutputContract('synthesis', OUTPUT_CONTRACT_IDS.evidenceGapQuery), /INVALID_OUTPUT_CONTRACT/);
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, JSON.stringify({
  ...gapQuery,
  score: 100,
})), /INVALID_OUTPUT_CONTRACT/, 'the query planner has no scoring authority');
assert.throws(() => validateOutputContractText(OUTPUT_CONTRACT_IDS.evidenceGapQuery, JSON.stringify({
  ...gapQuery,
  queries: [{ ...gapQuery.queries[0], terms: ['x'.repeat(81)] }],
})), /INVALID_OUTPUT_CONTRACT/);

const contract = structuredOutputForPacket({ stage: 'synthesis', output_contract: OUTPUT_CONTRACT_IDS.evidenceSynthesis });
assert.equal(contract.name, OUTPUT_CONTRACT_IDS.evidenceSynthesis);
assert.equal(contract.schema.additionalProperties, false);
assert.deepEqual(contract.schema.required, ['phase_3_strategy']);

const factCheck = {
  claims: [{
    claim: 'Evidence density is 92%.',
    classification: 'supported_by_audit',
    rationale: 'The value is present in Phase 2 metrics.',
    source_location: 'diagnosis',
    failure_type: 'not_applicable',
    severity: 'SUPPORTED',
    missing_material: '',
  }],
};
assert.deepEqual(
  validateOutputContractText(OUTPUT_CONTRACT_IDS.summaryFactCheck, JSON.stringify(factCheck)),
  factCheck,
);
assert.throws(
  () => validateOutputContractText(OUTPUT_CONTRACT_IDS.summaryFactCheck, JSON.stringify({ claims: [] })),
  /INVALID_OUTPUT_CONTRACT/,
);
assert.throws(
  () => authorizeOutputContract('synthesis', OUTPUT_CONTRACT_IDS.summaryFactCheck),
  /INVALID_OUTPUT_CONTRACT/,
);
const anthropicFactCheck = structuredOutputForPacket({
  stage: 'fact_check',
  provider: 'anthropic',
  output_contract: OUTPUT_CONTRACT_IDS.summaryFactCheck,
});
assert.equal('maxItems' in anthropicFactCheck.schema.properties.claims, false);
assert.equal(anthropicFactCheck.schema.properties.claims.minItems, 1);

const diagnostics = outputContractDiagnostics(`${evidenceText}\n{"other":true}`, { code: 'INVALID_OUTPUT_CONTRACT' });
assert.equal(diagnostics.output_chars > evidenceText.length, true);
assert.equal(diagnostics.balanced_object_count, 2);
assert.equal('text' in diagnostics, false);

let attempts = 0;
let retries = 0;
const recovered = await withOneOutputRegeneration(async regenerated => {
  attempts++;
  if (!regenerated) throw Object.assign(new Error(), { code: 'SYNTHESIS_OUTPUT_INVALID' });
  return 'recovered';
}, () => { retries++; });
assert.equal(recovered, 'recovered');
assert.equal(attempts, 2);
assert.equal(retries, 1);
await assert.rejects(
  withOneOutputRegeneration(async () => { throw Object.assign(new Error(), { code: 'INVALID_OUTPUT_CONTRACT' }); }),
  error => error.code === 'SYNTHESIS_OUTPUT_INVALID' && /provider fallback/.test(error.message),
);

const forensicPrompts = await readFile(new URL('../src/prompts.ts', import.meta.url), 'utf8');
assert.match(forensicPrompts, /exactly ONE best evidence quote per assessed item/);
assert.match(forensicPrompts, /quote text at most 240 characters/);
assert.match(forensicPrompts, /evidence at most 180 characters/);
assert.match(forensicPrompts, /reasoning at most 240 characters/);
assert.match(forensicPrompts, /no recommendations or repeated definitions/);

const synthesisPrompts = await readFile(new URL('../src/constants.ts', import.meta.url), 'utf8');
assert.match(synthesisPrompts, /ASSESSMENT-STATUS FIDELITY/);
assert.match(synthesisPrompts, /unsupported, verification_unresolved, and not_assessed criteria only as evidence\/verification gaps/);

const factCheckPrompts = await readFile(new URL('../src/services/factCheckService.ts', import.meta.url), 'utf8');
assert.match(factCheckPrompts, /marks a criterion unsupported, verification_unresolved, or not_assessed/);
assert.match(factCheckPrompts, /supplied use and do-not-use conditions/);

console.log('structured output contract tests passed');
