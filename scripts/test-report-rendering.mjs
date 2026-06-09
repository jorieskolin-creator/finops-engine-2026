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

  const {
    isInsufficientEvidenceReport,
    renderInlineMarkdownHtml,
    renderMarkdownSummaryHtml,
    strengthsSectionTitle,
  } = await import(`file://${modulePath}`);

  assert.equal(strengthsSectionTitle(false), 'Confirmed strengths');
  assert.equal(strengthsSectionTitle(true), 'Source observations outside FinOps scope');
  assert.equal(isInsufficientEvidenceReport('Insufficient evidence', 0, 'BLOCK'), true);
  assert.equal(isInsufficientEvidenceReport('Run', 90, 'GO'), false);
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

const dashboardSource = await readFile(new URL('../src/components/DashboardComponents.tsx', import.meta.url), 'utf8');
assert.match(dashboardSource, />Why</, 'Dashboard roadmap should render WHY context');
assert.match(dashboardSource, />What</, 'Dashboard roadmap should render WHAT context');
assert.match(dashboardSource, />How</, 'Dashboard roadmap should preserve HOW action list');

const exportSource = await readFile(new URL('../src/services/exportService.ts', import.meta.url), 'utf8');
assert.match(exportSource, /roadmap-context-label">Why/, 'HTML export should render roadmap WHY context');
assert.match(exportSource, /roadmap-context-label">What/, 'HTML export should render roadmap WHAT context');
assert.match(exportSource, /roadmap-how-label">How/, 'HTML export should label action bullets as HOW');
assert.match(exportSource, /renderDomainSignalOverview/, 'HTML exports should render the domain signal overview');
assert.match(exportSource, /Domain Signal Overview/, 'HTML exports should include the domain signal title');
assert.match(exportSource, /Anti-pattern finding rate/, 'HTML exports should label anti-pattern traffic lights');

console.log(functionalChecksRan
  ? 'report rendering unit tests passed'
  : 'report rendering textual tests passed (TypeScript compiler unavailable)');
