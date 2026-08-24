import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '../node_modules/typescript/lib/typescript.js';

const compile = source => ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  },
}).outputText;
const dir = await mkdtemp(join(tmpdir(), 'finops-semantic-gap-'));
await writeFile(join(dir, 'knowledgeBase.mjs'), `export const MASTER_BINGO_FINOPS = {
  maturity: [{ id: 'D1', title: 'Architecture efficiency', desc: 'Workload rightsizing and autoscaling controls' }],
  antipattern: []
};`);
await writeFile(join(dir, 'sourceRegistryService.mjs'), `
export const routingTermsForDomain = () => ['architecture', 'efficiency'];
export const expandDomainPacket = (registry, packet, ids) => {
  const additions = registry.chunks.filter(chunk => ids.includes(chunk.chunk_id));
  if (additions.length === 0) return { packet, selected_chunk_ids: [] };
  return {
    selected_chunk_ids: additions.map(chunk => chunk.chunk_id),
    packet: {
      ...packet,
      manifest: [...packet.manifest, ...additions.map(chunk => ({ chunk_id: chunk.chunk_id, source_id: chunk.source_id, type: chunk.type, relevance: 'semantic_gap', routed_domains: ['D'] }))],
      text: [packet.text, ...additions.map(chunk => chunk.text)].join('\\n'),
      included_chunk_count: packet.included_chunk_count + additions.length,
    }
  };
};`);
await writeFile(join(dir, 'aliases.mjs'), `export default { concepts: {
  autoscaling: ['auto scaling', 'automatic scaling', 'automaattinen skaalaus'],
  rightsizing: ['right sizing', 'resource sizing', 'resurssien mitoitus']
}};`);
const serviceSource = (await readFile(new URL('../src/services/semanticGapRetrievalService.ts', import.meta.url), 'utf8'))
  .replace("'../knowledge_base'", "'./knowledgeBase.mjs'")
  .replace("'./sourceRegistryService'", "'./sourceRegistryService.mjs'")
  .replace("'../knowledge_base/finops_term_aliases.json'", "'./aliases.mjs'");
await writeFile(join(dir, 'semanticGapRetrievalService.mjs'), compile(serviceSource));
const { expandWeakEvidencePacket } = await import(`file://${join(dir, 'semanticGapRetrievalService.mjs')}`);

const packet = {
  domain_id: 'D', title: 'D', text: 'baseline', images: [],
  manifest: [{ chunk_id: 'c1', source_id: 's1', type: 'text', relevance: 'high', routed_domains: ['D'] }],
  included_chunk_count: 1, total_candidate_chunks: 3, weak_coverage: true, coverage_notes: [], char_count: 8,
};
const registry = {
  chunks: [
    { chunk_id: 'c1', source_id: 's1', type: 'text', text: 'baseline' },
    { chunk_id: 'c2', source_id: 's1', type: 'text', text: 'Kubernetes autoscaling policy is configured but utilization thresholds remain undocumented.' },
    { chunk_id: 'c3', source_id: 's1', type: 'text', text: 'Unrelated procurement narrative.' },
  ]
};
const weak = {
  stream: 'maturity', id: 'D1', status: 'weak', original_count: 2, verified_count: 1,
  rationale: 'Autoscaling controls are mentioned, but utilization thresholds are unclear.', rescan_recommended: true,
};
const seenTerms = new Set();
const first = expandWeakEvidencePacket({ registry, packet, items: [weak], pass: 1, seenTerms });
assert.deepEqual(first.trace.criterion_ids, ['maturity.D1']);
assert.equal(first.trace.trigger_status, 'weak');
assert.deepEqual(first.trace.selected_chunk_ids, ['c2']);
assert.equal(first.trace.stop_reason, 'NEW_EVIDENCE_SELECTED');
assert.equal(first.trace.strategy, 'deterministic_semantic_fallback');
assert.ok(first.trace.proposed_terms.some(term => term.includes('autoscaling')));
assert.equal('score' in first.trace, false, 'gap retrieval must have no scoring authority or score output');

const nonWeak = ['supported', 'missing', 'unsupported'].map(status => ({ ...weak, status }));
for (const item of nonWeak) {
  const result = expandWeakEvidencePacket({ registry, packet, items: [item], pass: 1, seenTerms: new Set() });
  assert.deepEqual(result.trace.criterion_ids, [], `${item.status} must not trigger semantic retrieval`);
  assert.deepEqual(result.trace.selected_chunk_ids, []);
  assert.equal(result.trace.stop_reason, 'NO_NEW_TERMS');
}

const second = expandWeakEvidencePacket({ registry, packet: first.packet, items: [weak], pass: 2, seenTerms });
assert.deepEqual(second.trace.selected_chunk_ids, [], 'terms and chunks must not repeat on the second pass');
assert.equal(second.trace.stop_reason, 'NO_NEW_CANDIDATES');
assert.ok(second.trace.proposed_terms.every(term => !second.trace.seen_terms_before.includes(term)), 'terms must not repeat between passes');
assert.deepEqual(second.packet.manifest.map(item => item.chunk_id), ['c1', 'c2']);

const generated = expandWeakEvidencePacket({
  registry, packet, items: [weak], pass: 1, seenTerms: new Set(),
  proposedTerms: ['automatic scaling', 'utilization thresholds'], gapAnalysisModel: 'test-workhorse',
});
assert.equal(generated.trace.strategy, 'generative_semantic_expansion');
assert.equal(generated.trace.gap_analysis_model, 'test-workhorse');
assert.deepEqual(generated.trace.selected_chunk_ids, ['c2']);

console.log('semantic gap retrieval tests passed');
