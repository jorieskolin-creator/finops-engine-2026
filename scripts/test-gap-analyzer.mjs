import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';
import { emitTypescript } from './ts-emit.mjs';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove },
}).outputText;

const dir = await mkdtemp(join(tmpdir(), 'finops-gap-'));
const stubPath = join(dir, 'sourceRegistryService.mjs');
await writeFile(stubPath, `
export const rankedDomainCandidates = (registry, domainId) =>
  registry.chunks.filter(chunk => chunk.routing.some(route => route.domain === domainId)).map(chunk => ({ chunk }));
export const expandDomainPacket = (registry, packet, ids) => {
  const additions = registry.chunks.filter(chunk => ids.includes(chunk.chunk_id));
  if (additions.length === 0) return { packet, selected_chunk_ids: [] };
  return {
    selected_chunk_ids: additions.map(chunk => chunk.chunk_id),
    packet: {
      ...packet,
      manifest: [...packet.manifest, ...additions.map(chunk => ({ chunk_id: chunk.chunk_id, source_id: chunk.source_id, type: chunk.type, relevance: 'gap', routed_domains: [packet.domain_id] }))],
      text: [packet.text, ...additions.map(chunk => chunk.text)].join('\\n'),
      included_chunk_count: packet.included_chunk_count + additions.length,
    }
  };
};
`);

const coverageOut = await emitTypescript(new URL('../src/services/derivedEvidence/coverageAnalyzer.ts', import.meta.url).pathname, join(dir, 'coverage'));
const gapOut = await emitTypescript(new URL('../src/services/gapAnalyzerService.ts', import.meta.url).pathname, join(dir, 'gap'));
const retrievalSource = (await readFile(new URL('../src/services/boundedRetrievalService.ts', import.meta.url), 'utf8'))
  .replace("'./sourceRegistryService'", JSON.stringify(`file://${stubPath}`));
const retrievalOut = join(dir, 'boundedRetrievalService.mjs');
await writeFile(retrievalOut, compile(retrievalSource));

const { analyzeCrucialItemCoverage } = await import(`file://${coverageOut}`);
const { planGapRetrieval } = await import(`file://${gapOut}`);
const { applyBoundedRetrieval } = await import(`file://${retrievalOut}`);

const sources = [{
  schema_version: 'source_record_v1', source_id: 'src-1', source_name: 'pack.txt', kind: 'text',
  text: 'Monthly forecast ennuste is owned by finance. Budget variance is tracked.'
}];
const chunks = [
  { chunk_id: 'c1', source_id: 'src-1', type: 'text', text: 'Monthly forecast ennuste is owned by finance.', routing: [{ domain: 'C', tier: 'high', score: 6, reasons: [] }] },
  { chunk_id: 'c2', source_id: 'src-1', type: 'text', text: 'Corrective action mechanism for budget overrun.', routing: [{ domain: 'C', tier: 'low', score: 0, reasons: [] }] },
];
const registry = {
  source_count: 1, chunk_count: 2, warnings: [],
  extraction: { overall_completeness: 100, status: 'COMPLETE', warning_count: 0, sources: [], blocking_reasons: [] },
  chunks
};
const coverage = analyzeCrucialItemCoverage(sources, registry);
const packets = {
  C: {
    domain_id: 'C', title: 'C', text: 'baseline', images: [],
    manifest: [{ chunk_id: 'c1', source_id: 'src-1', type: 'text', relevance: 'high', routed_domains: ['C'] }],
    included_chunk_count: 1, total_candidate_chunks: 1, weak_coverage: false, coverage_notes: [], char_count: 8,
  }
};
const plan = planGapRetrieval({ packets, derived: coverage.evidence, locations: coverage.locations });
assert.equal(plan.generative, false);
assert.ok(plan.trigger_domains.includes('C'), 'partial crucial-item coverage must trigger without a generative model');
assert.ok((plan.terms_by_domain.C || []).length > 0, 'missing items expand to aliases');

const applied = applyBoundedRetrieval(registry, packets, { gap_plan: plan });
const c = applied.trace.domains.find(domain => domain.domain_id === 'C');
assert.ok(c.passes.length > 0, 'gap plan must be allowed to run even when weak_coverage is false');
assert.ok(applied.packets.C.manifest.some(item => item.chunk_id === 'c2'), 'unrouted supporting or omitted chunks should be selectable');

const sufficient = {
  B: { domain_id: 'B', title: 'B', text: '', images: [], manifest: [], included_chunk_count: 0, total_candidate_chunks: 0, weak_coverage: false, coverage_notes: [], char_count: 0 }
};
const untouched = applyBoundedRetrieval(registry, sufficient);
assert.equal(untouched.trace.domains[0].stop_reason, 'SUFFICIENT_BASELINE');

console.log('gap analyzer tests passed');
