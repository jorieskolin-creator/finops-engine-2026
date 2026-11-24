import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let functionalChecksRan = false;
try {
  const ts = await import('../node_modules/typescript/lib/typescript.js');
  const sourcePath = new URL('../src/services/reportTextService.ts', import.meta.url);
  const source = await readFile(sourcePath, 'utf8');
  const compiled = ts.default.transpileModule(source, {
    compilerOptions: {
      module: ts.default.ModuleKind.ES2022,
      target: ts.default.ScriptTarget.ES2020,
      importsNotUsedAsValues: ts.default.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;

  const dir = await mkdtemp(join(tmpdir(), 'finops-report-rendering-'));
  const modulePath = join(dir, 'reportTextService.mjs');
  await writeFile(modulePath, compiled, 'utf8');
  const svgSource = (await readFile(new URL('../src/services/svgChartService.ts', import.meta.url), 'utf8'))
    .replace("import { BATCH_TITLES } from '../knowledge_base';", "const BATCH_TITLES = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F' };");
  await writeFile(join(dir, 'svgChartService.mjs'), ts.default.transpileModule(svgSource, {
    compilerOptions: {
      module: ts.default.ModuleKind.ES2022,
      target: ts.default.ScriptTarget.ES2020,
      importsNotUsedAsValues: ts.default.ImportsNotUsedAsValues.Remove,
    },
  }).outputText, 'utf8');

  const {
    isInsufficientEvidenceReport,
    displayPlanningDecisionRationale,
    displaySourceCoverageWarning,
    renderInlineMarkdownHtml,
    renderMarkdownSummaryHtml,
    strengthsSectionTitle,
  } = await import(`file://${modulePath}`);
  const { svgGaugeCard } = await import(`file://${join(dir, 'svgChartService.mjs')}`);

  assert.equal(strengthsSectionTitle(false), 'Confirmed strengths');
  assert.equal(strengthsSectionTitle(true), 'Source observations outside FinOps scope');
  assert.equal(isInsufficientEvidenceReport('Insufficient evidence', 0, 'BLOCK'), true);
  assert.equal(isInsufficientEvidenceReport('Run', 90, 'GO'), false);
  assert.equal(
    displaySourceCoverageWarning('Source packet F has incomplete deterministic routing coverage (4/4 relevant chunks); no broad-source fallback was used.'),
    'Source packet F included 4/4 routed candidate chunks. Domain coverage is limited. Individually assessed criteria retain their verified scope.'
  );
  assert.equal(
    displayPlanningDecisionRationale(
      'Required validation did not complete or the quality gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.',
      'BLOCK',
      false
    ),
    'Validation completed, but the Quality Gate blocked actionability. Preserve the diagnostic findings, but do not execute recommendations until the blocking reasons are resolved.'
  );
  assert.equal(renderInlineMarkdownHtml('Tracked in *My Projects*'), 'Tracked in <em>My Projects</em>');

  const html = renderMarkdownSummaryHtml([
    '**1. What the audit found:** The source contains *project cost* but no FinOps signal.',
    '',
    '**2. What is missing:** No cloud bill data.',
    '',
    '**3. What is needed:** More source material.',
  ].join('\n'));

  assert.ok(html.includes('<strong>1. What the audit found:</strong>'), 'bold markdown should become strong tags');
  assert.ok(html.includes('<em>project cost</em>'), 'italic markdown should become em tags');
  assert.ok(html.includes('class="summary-paragraph"'), 'summary should render as paragraph blocks');
  assert.equal(html.includes('**'), false, 'raw bold markdown should not leak into exported HTML');
  assert.equal(html.includes('*project cost*'), false, 'raw italic markdown should not leak into exported HTML');
  const unavailableGauge = svgGaugeCard({ value: null, label: 'Corroborated Maturity', color: '#000', description: 'Unavailable fixture.', trend: 'positive' });
  assert.match(unavailableGauge, />N\/A</, 'an unavailable maturity value must render as N/A');
  assert.doesNotMatch(unavailableGauge, />0<tspan/, 'an unavailable maturity value must never render as 0%');
  functionalChecksRan = true;
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const reportViewSource = await readFile(new URL('../src/components/ReportView.tsx', import.meta.url), 'utf8');
assert.match(reportViewSource, />Why</, 'React report should render roadmap WHY context');
assert.match(reportViewSource, />What</, 'React report should render roadmap WHAT context');
assert.match(reportViewSource, />How</, 'React report should preserve action bullets as HOW');
assert.match(reportViewSource, /DomainSignalOverview/, 'React report should render the domain signal overview');
assert.match(reportViewSource, /Maturity signal/, 'React report should label maturity traffic lights');
assert.match(reportViewSource, /Anti-pattern finding rate/, 'React report should label anti-pattern traffic lights');
assert.doesNotMatch(reportViewSource, /FinOps Maturity Score/, 'React summary should not duplicate the score-detail panel');
assert.doesNotMatch(reportViewSource, /Capability Attainment/, 'React summary should not duplicate calculated score components');
assert.match(reportViewSource, /Download JSON/, 'React report should offer an explicit JSON download now that HTML is display-only');

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /display_only_report/, 'HTML upload should refuse display-only generated reports instead of restoring them');
assert.match(appSource, /downloadAssessmentJson/, 'the report view should download restore JSON from the dedicated exporter');

const dashboardSource = await readFile(new URL('../src/components/DashboardComponents.tsx', import.meta.url), 'utf8');
assert.match(dashboardSource, />Why</, 'Dashboard roadmap should render WHY context');
assert.match(dashboardSource, />What</, 'Dashboard roadmap should render WHAT context');
assert.match(dashboardSource, />How</, 'Dashboard roadmap should preserve HOW action list');

const exportSource = await readFile(new URL('../src/services/exportService.ts', import.meta.url), 'utf8');
const summaryExportSource = exportSource.slice(
  exportSource.indexOf('export const generateSummaryReportHtml'),
  exportSource.indexOf('export const generateReportHtml'),
);
const masterDataExportSource = exportSource.slice(exportSource.indexOf('export const generateReportHtml'));
assert.match(exportSource, /roadmap-context-label">Why/, 'HTML export should render roadmap WHY context');
assert.match(exportSource, /roadmap-context-label">What/, 'HTML export should render roadmap WHAT context');
assert.match(exportSource, /roadmap-how-label">How/, 'HTML export should label action bullets as HOW');
assert.match(exportSource, /renderDomainSignalOverview/, 'HTML exports should render the domain signal overview');
assert.match(exportSource, /renderAssessmentHeatmapSummary\(result\)/, 'HTML exports should render the shared criterion heatmap');
assert.doesNotMatch(summaryExportSource, /Evidence-Backed Findings|renderEvidenceBackedFindings/, 'Summary Report should remain concise and leave detailed evidence-backed findings to Master Data');
assert.match(masterDataExportSource, /<h2>Evidence-Backed Findings<\/h2>[\s\S]*renderEvidenceBackedFindings\(result\)/, 'Master Data should retain the governed evidence findings section');
assert.doesNotMatch(exportSource, /<h2>Executive Summary<\/h2>/, 'HTML exports should not render the legacy Executive Summary');
assert.doesNotMatch(exportSource, /Evidence summary for the/, 'HTML exports should not render repetitive persona summaries');
assert.match(exportSource, /Candidate inclusion measures/, 'Master Data should distinguish retrieval candidate inclusion from evidence sufficiency');
assert.doesNotMatch(exportSource, /How the maturity score is measured/, 'HTML exports should rely on the concise explanation attached to each gauge');
assert.match(exportSource, /Roadmap actionability BLOCKED/, 'HTML exports should distinguish blocked actionability from maturity classification');
assert.match(exportSource, /FinOps Engine v\.\$\{escapeHtml\(result\.meta\.engine_version\)\}/, 'HTML exports should render the current FinOps Engine product version');
assert.doesNotMatch(exportSource, /Engine \$\{escapeHtml\(result\.meta\.engine_version\)\}/, 'HTML exports should not expose the internal version value without the product label');
assert.equal((exportSource.match(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/g) || []).length, 2, 'both HTML reports should keep all three active gauges on one desktop row');
assert.doesNotMatch(exportSource, /Anti-pattern disposition|renderAntiPatternDisposition/, 'HTML reports should omit the redundant anti-pattern disposition card');
assert.doesNotMatch(summaryExportSource, /renderScoreEvidenceGaps/, 'Summary Report should leave detailed evidence questions to Master Data');
assert.match(exportSource, /renderScoreEvidenceGaps\(result\)/, 'Master Data should show all deterministic evidence questions');
for (const sharedSelector of ['.summary-card', '.diagnosis-lead', '.decision-card', '.summary-roadmap-phase', '.roadmap-list', '.two-col', '.evidence-basis']) {
  assert.ok(masterDataExportSource.includes(sharedSelector), `Master Data stylesheet must include ${sharedSelector} so Diagnosis, Planning Decision, and Remediation Roadmap match Summary Report readability`);
}
assert.doesNotMatch(masterDataExportSource, /\.roadmap-phase\s+li\s*\{\s*display:\s*flex/, 'Master Data must not apply display:flex to roadmap <li> items, which squishes Evidence basis next to action text');
assert.ok(
  masterDataExportSource.indexOf('renderRunTraceAppendix(result)') < masterDataExportSource.indexOf('renderScoreEvidenceGaps(result)'),
  'Master Data must render Evidence needed to interpret maturity as the final section after RunTrace Provenance',
);
assert.match(exportSource, /Evidence sufficiency/, 'context packet tables should distinguish evidence sufficiency from candidate inclusion');
assert.doesNotMatch(exportSource, /source\.source_name/, 'HTML exports must not render source filenames');
assert.match(exportSource, /stripSourceFilenameMetadata\(unsafeResult\)/, 'both HTML generators must remove legacy filename metadata at the export boundary');
assert.doesNotMatch(summaryExportSource, /finops-data|serializeDiagnosticResultForHtml/, 'Summary Report HTML must not embed a hidden diagnostic JSON payload');
assert.doesNotMatch(summaryExportSource, /<script/i, 'Summary Report HTML must not include script tags that could hide a payload');
assert.doesNotMatch(summaryExportSource, /type="application\/json"/, 'Summary Report HTML must not include hidden JSON content types');
assert.doesNotMatch(masterDataExportSource, /finops-data|serializeDiagnosticResultForHtml/, 'Master Data HTML must not embed a hidden diagnostic JSON payload');
assert.doesNotMatch(masterDataExportSource, /<script/i, 'Master Data HTML must not include script tags that could hide a payload');
assert.doesNotMatch(masterDataExportSource, /type="application\/json"/, 'Master Data HTML must not include hidden JSON content types');
assert.doesNotMatch(exportSource, /finops-data|serializeDiagnosticResultForHtml/, 'neither HTML generator may serialize a hidden diagnostic payload');
assert.match(exportSource, /Domain Signal Overview/, 'HTML exports should include the domain signal title');
assert.match(exportSource, /Anti-pattern finding rate/, 'HTML exports should label anti-pattern traffic lights');
assert.match(exportSource, /Acquisition Quality &amp; Readiness/, 'Master Data should visibly render acquisition quality');
assert.match(exportSource, /Evidence density \(assessed criteria\) measures how much of the 60-criterion assessment surface was assessed/, 'Master Data should define evidence density strictly as assessed criterion coverage');
assert.match(exportSource, /Acquisition quality composite \(covered items\)/, 'Master Data should label the 60/20/20 composite separately from evidence density');
assert.doesNotMatch(exportSource, /\['Evidence density',\s*`\$\{density\.overall\}%`\]/, 'Master Data must never label the acquisition quality composite as Evidence density');
assert.match(exportSource, /Scoped observation \(criterion not assessed\)/, 'Master Data should retain quotes on unassessed criteria as scoped observations');
assert.match(reportViewSource, /Scoped observation \(criterion not assessed\)/, 'React report should retain quotes on unassessed criteria as scoped observations');
assert.match(exportSource, /Scoped source observations/, 'Master Data should render scoped source observations separately from confirmed gaps');
assert.match(reportViewSource, /Scoped source observations/, 'React report should render scoped source observations separately from confirmed gaps');
assert.match(exportSource, /deterministic findings-only · narrative skipped/, 'Master Data should disclose when below-floor BLOCK skipped narrative synthesis and fact-check');
assert.match(exportSource, /only roadmap publication is blocked by the Phase 3 required-tactic contract/, 'Master Data should distinguish roadmap-contract BLOCK from evidence/analysis BLOCK');
assert.match(reportViewSource, /only roadmap publication is blocked by the Phase 3 required-tactic contract/, 'React report should distinguish roadmap-contract BLOCK from evidence/analysis BLOCK');
assert.match(exportSource, /observability-only in this milestone/, 'Master Data should disclose that acquisition readiness does not alter the Quality Gate');
assert.match(exportSource, /renderAcquisitionQuality\(result\)/, 'Master Data generation should include the acquisition quality section');
assert.match(exportSource, /Shadow deterministic A1\/AP-A1 observations/, 'Master Data should visibly label derived evidence as shadow-only');
assert.match(exportSource, /raw values exposed/, 'Master Data should disclose the derived-evidence privacy boundary');
assert.match(exportSource, /ASSESSMENT_METHOD_DISCLAIMER/, 'HTML exports should share one assessment-method disclaimer');
assert.match(summaryExportSource, /renderAssessmentMethodDisclaimer\(\)/, 'Summary Report footer should include the assessment-method disclaimer');
assert.match(masterDataExportSource, /renderAssessmentMethodDisclaimer\(\)/, 'Master Data footer should include the assessment-method disclaimer');
assert.match(exportSource, /raw customer evidence is not supplied directly to generative reasoning models/, 'HTML exports should disclose that raw customer evidence is not sent to generative models');
assert.match(exportSource, /final GO\/WARN\/BLOCK decisions are controlled by deterministic system logic/, 'HTML exports should disclose that GO/WARN/BLOCK remains deterministic');
assert.doesNotMatch(exportSource, /This report is generated deterministically from the validated assessment output/, 'HTML exports should not overstate that the whole report is generated without generative processing');

const reportViewModelSource = await readFile(new URL('../src/services/reportViewModel.ts', import.meta.url), 'utf8');
assert.match(reportViewModelSource, /label: 'Adjusted FinOps Maturity'/, 'report gauges should expose resolution-adjusted maturity');
assert.match(reportViewModelSource, /label: 'Criterion Evidence Density'/, 'report gauges should expose criterion evidence density');
assert.match(reportViewModelSource, /label: 'Overall Assessment Resolution'/, 'report gauges should expose overall assessment resolution');
assert.match(reportViewModelSource, /Assessment Sufficiency/, 'active gauge explanation should disclose the publication gate');
assert.doesNotMatch(reportViewModelSource, /label: 'Observed Friction'/, 'Observed Friction should no longer occupy a primary report gauge');

const gaugeComponentSource = await readFile(new URL('../src/components/DashboardComponents.tsx', import.meta.url), 'utf8');
const svgGaugeSource = await readFile(new URL('../src/services/svgChartService.ts', import.meta.url), 'utf8');
assert.match(gaugeComponentSource, /High = Good/, 'interactive gauges should state score direction');
assert.match(svgGaugeSource, /High = Good/, 'exported gauges should state score direction');

console.log(functionalChecksRan
  ? 'report rendering unit tests passed'
  : 'report rendering textual tests passed (TypeScript compiler unavailable)');

const { build } = await import('esbuild');
const bundle = await build({ entryPoints: ['src/services/reportNarrativeService.ts'], bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}' } });
const { createReportNarrative } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const format = createReportNarrative({
  phase_2_validation: { resolution_maturity: { criterion_resolutions: [
    { stream: 'maturity', criterion_id: 'A3', state: 'RESOLVED', score_count: 1 },
    { stream: 'antipattern', criterion_id: 'E2', state: 'UNKNOWN' }
  ] } },
  phase_1_audit_logs: { maturity: { A3: { evidence_quotes: [{ quote: 'Sample', source_id: 'src-1', chunk_id: 'c3' }] } } },
});
assert.deepEqual(format('Review [A3].'), { text: 'Review cost anomaly detection and alerting.', basis: ['Assessment criterion A3 · assessed 1/3','Customer evidence src-1/c3'] });
const topic = 'cost anomaly detection and alerting';
for (const prefix of ['Prioritize', 'Improve', 'In the next cycle, prioritize', 'Ask the service owner to improve']) {
  assert.equal(format(`${prefix} [A3].`).text, `${prefix} ${topic}.`);
  assert.equal(format(`${prefix} [A3] and verify the alert route.`).text, `${prefix} ${topic} and verify the alert route.`);
}
assert.deepEqual(format('Improve cost anomaly detection and alerting [A3].'), format('Improve [A3].'));
assert.equal(format('Review cost anomaly detection and alerting, then prioritize [A3].').text,
  `Review ${topic}, then prioritize ${topic}.`);
assert.match(format('Check AP-E2.').text, /whether cost overruns trigger blame/);
assert.match(format('Check AP-E2.').basis[0], /not assessed/);
assert.equal(format('[A1–A3, AP-E2]').basis.filter(s => s.startsWith('Assessment criterion')).length, 4);
assert.equal(format('Model A3 on src-A3 uses 75%.').text, 'Model A3 on src-A3 uses 75%.');
assert.equal(format('[A3-F5]').text, '[A3-F5]');

// Trailing provenance tag clusters on roadmap actions move cleanly into Evidence basis
// without splicing concatenated titles or "the playbook tactic" into the sentence body.
const cleanTrailingAction = format('FinOps lead models conservative commitment scenarios and records the exchange decision [A3] [TAC-OPT-001]; artifact: approved decision record.');
assert.equal(
  cleanTrailingAction.text,
  'FinOps lead models conservative commitment scenarios and records the exchange decision; artifact: approved decision record.',
);
assert.ok(cleanTrailingAction.basis.includes('Assessment criterion A3 · assessed 1/3'));
assert.ok(cleanTrailingAction.basis.includes('Playbook tactic [TAC-OPT-001]'));
assert.equal(
  format('FinOps lead applies [TAC-OPT-001] to [A3].').text,
  'FinOps lead applies the playbook tactic to cost anomaly detection and alerting.',
);

// Exercise the actual report component and both download entry points on one serialized result.
const surfaces = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    export { ReportView } from './src/components/ReportView';
    export { calculateMetrics } from './src/services/metricsService';
    export { generateReportHtml, generateSummaryReportHtml } from './src/services/exportService';
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  define: { 'import.meta.env': '{}' },
});
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const compiledReport = { exports: {} };
new Function('module','exports','require', surfaces.outputFiles[0].text)(compiledReport, compiledReport.exports, require);
const { ReportView, calculateMetrics, generateReportHtml, generateSummaryReportHtml } = compiledReport.exports;
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const logs = { maturity: { A3: { count: 1, status: 'Partial', assessment_status: 'assessed', evidence_check_status: 'supported', evidence: 'Sample alert', evidence_quotes: [{ quote: 'Sample alert', source_id: 'src-001', chunk_id: 'c3' }] } }, antipattern: {} };
const saved = {
  meta: { engine_version: 'test', timestamp: 'fixture', model_config: {} },
  phase_1_audit_logs: logs, phase_2_validation: { ...calculateMetrics(logs), score_evidence_gaps: ['[A1] Not demonstrated by the supplied material.'] },
  phase_3_strategy: { confidence_bracket: 'MEDIUM', diagnosis: { executive_summary: 'Cross-lens executive overview of assessed FinOps controls and evidence boundaries.', primary_bottleneck: 'Limited assessment resolution outside cost visibility.', domain_diagnosis: { A: 'The sampled alert reached an owner. Review cost anomaly detection and alerting [A3].', E: '' }, root_causes: [], confidence: 'medium' },
    planning_decision: { decision: 'CONDITIONAL_GO', rationale: 'Review [A3].', safe_to_act_on: [], evidence_needed_before_action: ['Check AP-E2.'] },
    remediation_roadmap: [{ phase: 'Review', why: 'Validate the sample.', what: 'A reviewed alert.', deliverables: ['Severity-based anomaly escalation matrix with named recipients.'], actions: ['Ask the service owner to improve [A3].'], confidence: 'medium', assumptions: ['Owner confirms <scope>.'] }] },
  quality_gate: { decision: 'WARN', blocking_reasons: [], warnings: [], notes: [], thresholds: {} },
};
const renderAll = result => {
  const restored = JSON.parse(JSON.stringify(result));
  return [renderToStaticMarkup(createElement(ReportView, { result: restored })), generateSummaryReportHtml(restored), generateReportHtml(restored)];
};
const renderedSurfaces = renderAll(saved);
for (const html of renderedSurfaces) {
  for (const phrase of ['Cross-lens executive overview of assessed FinOps controls and evidence boundaries.', 'Executive summary', 'Deliverables', 'Severity-based anomaly escalation matrix with named recipients.', 'The sampled alert reached an owner.', 'Assessment criterion A3 · assessed 1/3', 'Customer evidence src-001/c3',
    'whether cost overruns trigger blame', 'AP-E2 · not assessed', 'Owner confirms &lt;scope&gt;.', 'Ask the service owner to improve cost anomaly detection and alerting.']) assert.ok(html.includes(phrase), phrase);
}
for (const [label, html] of [['ReportView', renderedSurfaces[0]], ['Master Data HTML', renderedSurfaces[2]]]) {
  const roadmapIdx = html.indexOf('Remediation Roadmap');
  const forensicIdx = html.indexOf('Forensic Audit: Anti-Patterns');
  const evidenceNeededIdx = html.indexOf('Evidence needed to interpret maturity');
  assert.ok(roadmapIdx > 0 && forensicIdx > roadmapIdx && evidenceNeededIdx > forensicIdx, `${label} must place Evidence needed to interpret maturity as the last section after Roadmap and Forensic Audit`);
}
for (const [decision, bracket] of [['BLOCK', 'MEDIUM'], ['WARN', 'LOW']]) {
  const control = structuredClone(saved);
  control.quality_gate.decision = decision;
  control.phase_3_strategy.effective_bracket = bracket;
  for (const html of renderAll(control)) assert.doesNotMatch(html, /Ask the service owner to improve/);
}
const legacy = structuredClone(saved);
delete legacy.phase_3_strategy.diagnosis.domain_diagnosis;
for (const html of renderAll(legacy)) assert.doesNotMatch(html, /The sampled alert reached an owner/);
