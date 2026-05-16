import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const sourcePath = new URL('../src/services/reportTextService.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
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

console.log('report rendering unit tests passed');
