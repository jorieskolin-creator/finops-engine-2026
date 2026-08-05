import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const localTsPath = fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js', import.meta.url));
const bundledTsPath = '/Users/jorieskolin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/typescript/lib/typescript.js';
const tsPath = existsSync(localTsPath) ? localTsPath : existsSync(bundledTsPath) ? bundledTsPath : null;
if (!tsPath) {
  console.warn('source registry packetizer tests skipped: TypeScript compiler is unavailable in this local dependency tree');
  process.exit(0);
}
const ts = await import(pathToFileURL(tsPath));

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    resolveJsonModule: true,
  },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-source-registry-'));
const source = (await readFile(new URL('../src/services/sourceRegistryService.ts', import.meta.url), 'utf8'))
  .replace(
    "import { BATCH_TITLES } from '../knowledge_base';",
    "const BATCH_TITLES = { A: 'Cost Visibility & Allocation', B: 'Rate & Usage Optimization', C: 'Governance & Policy', D: 'Architecture & Engineering', E: 'Culture & Organization', F: 'GenAI & AI Cost Management' };"
  );
await writeFile(join(dir, 'sourceRegistryService.mjs'), transpile(source), 'utf8');

const {
  buildSourceRegistry,
  buildDomainPackets,
  buildDlpReviewPacket
} = await import(`file://${join(dir, 'sourceRegistryService.mjs')}`);

const text = `
<DOCUMENT name="Cloud AI Platform Notes.pdf">
[PDF_PAGE source="Cloud AI Platform Notes.pdf" page="1"]
FinOps team reviews cloud cost dashboards, tagging ownership, showback reporting, and cost center allocation.
[/PDF_PAGE]

[PDF_PAGE source="Cloud AI Platform Notes.pdf" page="2"]
The AI gateway tracks LLM token usage by application, customer workflow, environment, and model. Model routing reduces premium model overuse.
[/PDF_PAGE]

[PDF_PAGE source="Cloud AI Platform Notes.pdf" page="15"]
Appendix: budget guardrails are not implemented for GenAI API usage. Token alerts are planned but not yet active.
[/PDF_PAGE]
</DOCUMENT>`;

const images = [{
  mimeType: 'image/jpeg',
  data: 'abc123',
  source_name: 'Cloud AI Platform Notes.pdf',
  page_number: 15
}];

const registry = buildSourceRegistry(text, images);
assert.ok(registry.chunk_count >= 4, 'registry should include text chunks and image chunk');
assert.ok(registry.chunks.some(c => c.chunk_id.includes('p015')), 'page 15 should keep page-aware chunk id');

const packets = buildDomainPackets(registry);
assert.ok(packets.A.text.includes('tagging ownership'), 'A packet should include cost visibility evidence');
assert.ok(packets.F.text.includes('LLM token usage'), 'F packet should include GenAI/token evidence');
assert.ok(packets.F.text.length <= 45000, 'F packet should stay under hard cap');
assert.ok(packets.F.manifest.some(m => m.page_number === 15), 'F packet should preserve page references');
assert.doesNotMatch(JSON.stringify(packets), /fallback is allowed|full source registry remains available/i, 'packets must not authorize broad raw-source fallback');

const dlp = buildDlpReviewPacket(registry);
assert.match(dlp.text, /page="15"|p015/, 'DLP review packet should include distributed later-page material');
assert.ok(dlp.selected_chunk_count > 1, 'DLP review should not be first chunk only');

console.log('source registry packetizer tests passed');
