import assert from 'node:assert/strict';
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

const contract = structuredOutputForPacket({ stage: 'synthesis', output_contract: OUTPUT_CONTRACT_IDS.evidenceSynthesis });
assert.equal(contract.name, OUTPUT_CONTRACT_IDS.evidenceSynthesis);
assert.equal(contract.schema.additionalProperties, false);
assert.deepEqual(contract.schema.required, ['phase_3_strategy']);

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

console.log('structured output contract tests passed');
