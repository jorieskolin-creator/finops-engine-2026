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
    'Source packet F included 4/4 routed candidate chunks, but the available material did not provide sufficient domain evidence. No broad-source fallback was used.'
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
assert.match(exportSource, /Evidence sufficiency/, 'context packet tables should distinguish evidence sufficiency from candidate inclusion');
assert.doesNotMatch(exportSource, /source\.source_name/, 'HTML exports must not render source filenames');
assert.match(exportSource, /stripSourceFilenameMetadata\(unsafeResult\)/, 'both HTML generators must remove legacy filename metadata at the export boundary');
assert.match(exportSource, /Domain Signal Overview/, 'HTML exports should include the domain signal title');
assert.match(exportSource, /Anti-pattern finding rate/, 'HTML exports should label anti-pattern traffic lights');
assert.match(exportSource, /Acquisition Quality &amp; Readiness/, 'Master Data should visibly render acquisition quality');
assert.match(exportSource, /Evidence coverage measures how much of the assessment surface was tested/, 'Master Data should distinguish coverage from density');
assert.match(exportSource, /observability-only in this milestone/, 'Master Data should disclose that acquisition readiness does not alter the Quality Gate');
assert.match(exportSource, /renderAcquisitionQuality\(result\)/, 'Master Data generation should include the acquisition quality section');
assert.match(exportSource, /Shadow deterministic A1\/AP-A1 observations/, 'Master Data should visibly label derived evidence as shadow-only');
assert.match(exportSource, /raw values exposed/, 'Master Data should disclose the derived-evidence privacy boundary');

const reportViewModelSource = await readFile(new URL('../src/services/reportViewModel.ts', import.meta.url), 'utf8');
assert.match(reportViewModelSource, /label: 'Corroborated Maturity'/, 'report gauges should expose corroborated paired maturity');
assert.match(reportViewModelSource, /label: 'Observed Maturity'/, 'report gauges should expose observed paired maturity');
assert.match(reportViewModelSource, /label: 'Adjusted FinOps Maturity'/, 'report gauges should expose resolution-adjusted maturity');
assert.match(reportViewModelSource, /Assessment Sufficiency/, 'active gauge explanation should disclose the publication gate');
assert.doesNotMatch(reportViewModelSource, /label: 'Observed Friction'/, 'Observed Friction should no longer occupy a primary report gauge');

const gaugeComponentSource = await readFile(new URL('../src/components/DashboardComponents.tsx', import.meta.url), 'utf8');
const svgGaugeSource = await readFile(new URL('../src/services/svgChartService.ts', import.meta.url), 'utf8');
assert.match(gaugeComponentSource, /High = Good/, 'interactive gauges should state score direction');
assert.match(svgGaugeSource, /High = Good/, 'exported gauges should state score direction');

console.log(functionalChecksRan
  ? 'report rendering unit tests passed'
  : 'report rendering textual tests passed (TypeScript compiler unavailable)');
