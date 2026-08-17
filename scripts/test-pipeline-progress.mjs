import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const component = await readFile(new URL('../src/components/DashboardComponents.tsx', import.meta.url), 'utf8');
const analysis = await readFile(new URL('../src/services/analysisService.ts', import.meta.url), 'utf8');
const orchestrator = await readFile(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const report = await readFile(new URL('../src/components/ReportView.tsx', import.meta.url), 'utf8');
const exportedReport = await readFile(new URL('../src/services/exportService.ts', import.meta.url), 'utf8');
const loadingComponent = component.slice(component.indexOf('const PIPELINE_STEPS'), component.indexOf('export const TransferProtocol'));

const orderedStages = ['extraction','packetization','privacy','knowledge','analysis','evidence','calculation','synthesis','verification','finalization'];
let previous = -1;
for (const stage of orderedStages) {
  const position = loadingComponent.indexOf(`id: '${stage}'`);
  assert.ok(position > previous, `${stage} must appear in governed pipeline order`);
  previous = position;
}
for (const domain of ['A','B','C','D','E','F']) assert.match(loadingComponent, new RegExp(`id: '${domain}'`));
assert.match(loadingComponent, /Six domains execute in parallel/);
assert.doesNotMatch(loadingComponent, /Claude|GPT|Sonnet|Opus|model/i);
assert.doesNotMatch(app, /Claude|GPT|Sonnet|Opus/);
assert.doesNotMatch(app, /Assessment Suite v1\.0/);
assert.equal((app.match(/FinOps Engine v\.2\.0\.0/g) || []).length, 2, 'header and footer should use the current product version');
assert.match(app, /href="https:\/\/evidence-driven-finops-assessment\.vercel\.app\/"/, 'engine explanation button should use the current public URL');
assert.doesNotMatch(report, /Model routing mode:|Models:/);
assert.doesNotMatch(exportedReport, /Model routing mode:|Models:|Model mode /);
assert.match(orchestrator, /onProgress\(0, totalBatches\)/, 'parallel domain work must be announced before batches settle');
assert.match(orchestrator, /onProgress\(completedCount, totalBatches, batchId\)/, 'domain completion must use actual settled batches');
assert.match(orchestrator, /unavailableEvidenceCheck\(batchId, errorCode\)/, 'failed domains must produce explicit unavailable evidence decisions');
assert.match(orchestrator, /catch \(error\) \{[\s\S]*?'targeted_rescan_unavailable'[\s\S]*?fallback: 'verified_downgrades'/, 'an unavailable targeted rescan must retain conservative verifier downgrades instead of failing the domain');
const integrityGatePosition = analysis.indexOf('validatePreSynthesisIntegrity(');
const calculationPosition = analysis.indexOf('const validationData = calculateMetrics');
const synthesisPosition = analysis.indexOf("emitProgress({ stage: 'synthesis', status: 'in_progress' })");
assert.ok(integrityGatePosition > 0 && integrityGatePosition < calculationPosition && calculationPosition < synthesisPosition, 'technical domain failures must stop before calculation and synthesis');
assert.match(analysis, /throw new PipelineIntegrityError\('ANALYSIS_OUTPUT_INCOMPLETE', 'pre_synthesis'\)/, 'invalid Phase 1 output must terminate before synthesis');
assert.match(analysis, /safeItem\.antipattern_absence_status = item\.antipattern_absence_status/, 'sanitization must preserve validated evidence semantics');
for (const stage of orderedStages) assert.match(analysis, new RegExp(`stage: '${stage}'`));
assert.match(analysis, /checkpoint\('final_report'[\s\S]*readyRun\([\s\S]*emitProgress\(\{ stage: 'finalization', status: 'completed' \}\)/, 'finalization must complete only after the recoverable report is stored and marked ready for delivery');
assert.ok(
  analysis.indexOf('await readyRun(') < analysis.indexOf("serverLog(runId, 'info', 'pipeline_complete'"),
  'pipeline_complete must be emitted only after durable delivery readiness succeeds'
);

console.log('pipeline progress presentation tests passed');
