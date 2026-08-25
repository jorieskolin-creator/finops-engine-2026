import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../src/services/reportImportService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-report-import-'));
const modulePath = join(dir, 'reportImportService.mjs');
await writeFile(modulePath, compiled, 'utf8');

const {
  extractDiagnosticResultFromHtmlReport,
  parseDiagnosticResultJson,
  serializeDiagnosticResultForHtml,
} = await import(`file://${modulePath}`);

const payload = {
  meta: { engine_version: 'test', timestamp: '2026-05-22', model_config: {} },
  phase_1_audit_logs: { maturity: {}, antipattern: {} },
  evidence_check: { batch_id: 'all', items: [], adjustments: [] },
  phase_2_validation: {
    metrics: { assessment_resolution: 100 },
    resolution_maturity: { mode: 'ACTIVE' },
    assessment_sufficiency: { scoring_authority: true, decision: 'PASS' },
    crawl_walk_run: 'Run',
  },
  phase_3_strategy: { executive_summary: 'safe </script> text', remediation_roadmap: [] },
  quality_gate: { decision: 'GO', blocking_reasons: [], warnings: [], notes: [], thresholds: {} },
};

const serialized = serializeDiagnosticResultForHtml(payload);
assert.equal(serialized.includes('</script>'), false, 'embedded report JSON must not close its own script tag');

const html = `<!doctype html><script id="finops-data" type="application/json">${serialized}</script>`;
const imported = extractDiagnosticResultFromHtmlReport(html);
assert.equal(imported.kind, 'report');
assert.equal(imported.result.phase_3_strategy.executive_summary, 'safe </script> text');

const ordinaryHtml = '<!doctype html><main><h1>Source material</h1></main>';
assert.deepEqual(extractDiagnosticResultFromHtmlReport(ordinaryHtml), { kind: 'not_report' });

const brokenHtml = '<script id="finops-data" type="application/json">{not json</script>';
const broken = extractDiagnosticResultFromHtmlReport(brokenHtml);
assert.equal(broken.kind, 'invalid_report');

const incomplete = parseDiagnosticResultJson(JSON.stringify({ phase_1_audit_logs: {} }));
assert.equal(incomplete.kind, 'invalid_report');

console.log('report import unit tests passed');
