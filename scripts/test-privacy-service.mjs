import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../src/services/privacyService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-privacy-'));
const modulePath = join(dir, 'privacyService.mjs');
await writeFile(modulePath, compiled, 'utf8');

const {
  scrubGeneratedText,
  scrubDiagnosticResultForPrivacy,
  findGeneratedReportPrivacyFindings,
} = await import(`file://${modulePath}`);

{
  const text = 'Prepared by Toni Eskolin, contact toni@example.com, +358 40 123 4567, 10.1.2.3, sk-testtokenabcdefghijklmnopqrstuvwxyz.';
  const scrubbed = scrubGeneratedText(text, { redactPersonNames: true });
  assert.match(scrubbed.text, /\[PERSON_NAME_REDACTED\]/);
  assert.match(scrubbed.text, /\[EMAIL_REDACTED\]/);
  assert.match(scrubbed.text, /\[PHONE_REDACTED\]/);
  assert.match(scrubbed.text, /\[IP_REDACTED\]/);
  assert.match(scrubbed.text, /\[TOKEN_REDACTED\]/);
}

{
  const text = 'FinOps Lead reviewed Google Cloud, Power BI, and Engineering Team evidence.';
  const scrubbed = scrubGeneratedText(text, { redactPersonNames: true });
  assert.equal(scrubbed.text, text, 'FinOps terms, cloud tools, and team/function labels should be preserved');
}

{
  const scrubbed = scrubGeneratedText('HUS has a FinOps process. HUS needs evidence.', {
    redactOrganizationName: 'HUS',
    redactPersonNames: false,
  });
  assert.equal(scrubbed.text, '[ORGANIZATION_REDACTED] has a FinOps process. [ORGANIZATION_REDACTED] needs evidence.');
}

const result = {
  meta: { engine_version: 'test', timestamp: '2026-05-22', document_analyzed: 'HUS report', model_config: {} },
  phase_1_audit_logs: {
    maturity: {
      A1: {
        count: 0,
        status: 'NOK',
        evidence: 'Raw quote by Toni Eskolin should remain in audit evidence.',
        evidence_quotes: [{ quote: 'Raw quote by Toni Eskolin should remain in audit evidence.' }]
      }
    },
    antipattern: {}
  },
  evidence_check: { total_items: 0, supported_count: 0, weak_count: 0, unsupported_count: 0, missing_count: 0, downgraded_count: 0, rescan_count: 0, items: [], adjustments: [] },
  phase_2_validation: { metrics: {}, raw_counts: {}, maturity_gaps: [], antipattern_findings: [], verified_antipattern_absences: [], unknown_antipattern_absences: [], silent_areas: [], category_scores: {}, crawl_walk_run: 'Crawl' },
  phase_3_strategy: {
    executive_summary: 'Prepared by Toni Eskolin. HUS has contact toni@example.com.',
    executive_summaries: { finops_lead: 'Prepared by Toni Eskolin.' },
    diagnosis: { primary_bottleneck: 'Owner: Toni Eskolin', root_causes: [], domain_diagnosis: {}, confidence: 'medium', confidence_rationale: '' },
    planning_decision: { decision: 'NO_GO', rationale: 'HUS needs more evidence.', safe_to_act_on: [], evidence_needed_before_action: [] },
    visual_scorecard: { headline: 'HUS scorecard', maturity_score: '', burden_score: '' },
    remediation_roadmap: []
  },
  quality_gate: { decision: 'WARN', blocking_reasons: [], warnings: ['Reviewer: Toni Eskolin'], notes: [], thresholds: {} },
};

const scrubbed = scrubDiagnosticResultForPrivacy(result, {
  redactPersonNames: true,
  redactOrganizationName: 'HUS'
});

assert.notEqual(scrubbed.result.phase_3_strategy.executive_summary, result.phase_3_strategy.executive_summary);
assert.match(scrubbed.result.phase_3_strategy.executive_summary, /\[PERSON_NAME_REDACTED\]/);
assert.match(scrubbed.result.phase_3_strategy.executive_summary, /\[ORGANIZATION_REDACTED\]/);
assert.match(scrubbed.result.quality_gate.warnings[0], /\[PERSON_NAME_REDACTED\]/);
assert.equal(
  scrubbed.result.phase_1_audit_logs.maturity.A1.evidence_quotes[0].quote,
  result.phase_1_audit_logs.maturity.A1.evidence_quotes[0].quote,
  'raw Phase 1 audit evidence must remain unchanged'
);
assert.ok(findGeneratedReportPrivacyFindings(result).includes('Toni Eskolin'));

console.log('privacy service unit tests passed');
