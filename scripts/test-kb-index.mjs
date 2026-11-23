import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTypescript } from './ts-emit.mjs';
import {
  buildKbStatus,
  extractKbSections,
  extractJsonFrontMatter,
  expectedIdsFromPathname,
  normalizeDomainName,
  normalizeCapabilityId,
  normalizeCriterionId,
  sanitizeKbDocument,
  validateKbMetadata,
} from '../lib/kbIndex.js';
import { fetchBlobBytes, listBlobPdfs } from '../api/kb-index.js';

const baseMeta = {
  kb_type: 'reference',
  domain_id: 'A',
  domain_name: 'Cost Visibility & Allocation',
  stream: 'maturity',
  criterion_id: 'A1',
  capability_id: 'A1',
  capability_name: 'Comprehensive Cost Allocation & Tagging',
  evidence_categories: ['Policy', 'Process'],
  allowed_uses: ['rubric_context', 'evidence_requirements'],
  forbidden_uses: ['customer_current_state_claim', 'source_evidence_quote'],
  version: '1.0.0',
};

const maturityPath = 'Knowledge Base/Cost Visibility & Allocation/A - Cost Visibility & Allocation - A1 - Comprehensive Cost Allocation & Tagging.pdf';
const antiPath = 'Knowledge Base/Cost Visibility & Allocation/A - Cost Visibility & Allocation - AP-A1 - Tag Sprawl & Missing Tags.pdf';
const fMaturityPath = 'Knowledge Base/GenAI & AI Cost Management/F - GenAI & AI Cost Management - F2 - AI Cost Allocation & Unit Economics.pdf';
const fAntiPath = 'Knowledge Base/GenAI & AI Cost Management/F - GenAI & AI Cost Management - AP-F2 - Playground-to-Production Cost Drift.pdf';

assert.deepEqual(expectedIdsFromPathname(maturityPath), {
  domainId: 'A',
  domainName: 'Cost Visibility & Allocation',
  criterionId: 'A1',
  capabilityId: 'A1',
  stream: 'maturity',
});

assert.deepEqual(validateKbMetadata(baseMeta, maturityPath), []);
assert.equal(normalizeDomainName('F', 'GenAI / Token Cost Management'), 'GenAI & AI Cost Management');
assert.equal(normalizeDomainName('F', 'GenAI & AI Cost Management'), 'GenAI & AI Cost Management');

const antiMeta = {
  ...baseMeta,
  stream: 'antipattern',
  criterion_id: 'AP-A1',
  capability_id: 'A1',
  antipattern_name: 'Tag Sprawl & Missing Tags',
};
delete antiMeta.capability_name;
assert.deepEqual(validateKbMetadata(antiMeta, antiPath), []);
assert.equal(normalizeCriterionId('AP – A1'), 'AP-A1');
assert.equal(normalizeCriterionId('AP - A1'), 'AP-A1');
assert.equal(normalizeCriterionId('AP—A1'), 'AP-A1');
assert.equal(normalizeCriterionId('APA1'), 'AP-A1');
assert.equal(normalizeCapabilityId('AP – A1'), 'A1');

const extractedDashMeta = {
  ...antiMeta,
  criterion_id: 'AP – A1',
  capability_id: 'AP - A1',
};
assert.deepEqual(validateKbMetadata(extractedDashMeta, antiPath), []);

const legacyMeta = {
  ...antiMeta,
  streams: ['anti-pattern'],
  antipattern_id: 'antipattern.A1',
  capability_id: 'A1-AP',
};
assert(validateKbMetadata(legacyMeta, antiPath).some(p => p.includes('legacy streams')));
assert(validateKbMetadata(legacyMeta, antiPath).some(p => p.includes('legacy antipattern_id')));
assert(validateKbMetadata(legacyMeta, antiPath).some(p => p.includes('capability_id=A1-AP')));

const fMeta = {
  ...baseMeta,
  domain_id: 'F',
  domain_name: 'GenAI & AI Cost Management',
  stream: 'maturity',
  criterion_id: 'F2',
  capability_id: 'F2',
  capability_name: 'AI Cost Allocation & Unit Economics',
};
assert.deepEqual(validateKbMetadata(fMeta, fMaturityPath), []);

const oldNameFMeta = {
  ...fMeta,
  domain_name: 'GenAI / Token Cost Management',
};
assert.deepEqual(validateKbMetadata(oldNameFMeta, fMaturityPath), []);

const missingStreamFMeta = {
  ...fMeta,
  stream: undefined,
  streams: ['maturity'],
};
assert(validateKbMetadata(missingStreamFMeta, fMaturityPath).some(p => p.includes('stream=undefined expected=maturity')));
assert(validateKbMetadata(missingStreamFMeta, fMaturityPath).some(p => p.includes('legacy streams')));

const fAntiMeta = {
  ...fMeta,
  stream: 'antipattern',
  criterion_id: 'AP-F2',
  capability_id: 'F2',
  antipattern_name: 'Playground-to-Production Cost Drift',
};
delete fAntiMeta.capability_name;
assert.deepEqual(validateKbMetadata(fAntiMeta, fAntiPath), []);

const text = `Title line\n${JSON.stringify(baseMeta, null, 2)}\n\nReference body for evidence requirements.`;
assert.equal(extractJsonFrontMatter(text).criterion_id, 'A1');
const doc = sanitizeKbDocument({
  pathname: maturityPath,
  url: 'https://example.test/a.pdf',
  downloadUrl: 'https://example.test/a.pdf?download=1',
  size: 123,
  uploadedAt: '2026-05-21T00:00:00.000Z',
  text,
});
assert.equal(doc.stream, 'maturity');
assert.equal(doc.criterion_id, 'A1');
assert(doc.body_excerpt.includes('Reference body'));

const antiDoc = sanitizeKbDocument({
  pathname: antiPath,
  url: 'https://example.test/ap.pdf',
  downloadUrl: 'https://example.test/ap.pdf?download=1',
  size: 123,
  uploadedAt: '2026-05-21T00:00:00.000Z',
  text: `${JSON.stringify(extractedDashMeta, null, 2)}\n\nAnti-pattern reference body.`,
});
assert.equal(antiDoc.criterion_id, 'AP-A1');
assert.equal(antiDoc.capability_id, 'A1');

const fDoc = sanitizeKbDocument({
  pathname: fMaturityPath,
  url: 'https://example.test/f.pdf',
  downloadUrl: 'https://example.test/f.pdf?download=1',
  size: 123,
  uploadedAt: '2026-05-21T00:00:00.000Z',
  text: `${JSON.stringify(oldNameFMeta, null, 2)}\n\nF2 reference body.`,
});
assert.equal(fDoc.domain_name, 'GenAI & AI Cost Management');
assert.equal(fDoc.stream, 'maturity');
assert.equal(fDoc.criterion_id, 'F2');

const apD1Meta = {
  ...antiMeta,
  domain_id: 'D',
  domain_name: 'Architecture & Engineering',
  criterion_id: 'AP-D1',
  capability_id: 'D1',
  antipattern_name: 'Lift-and-Shift Without Optimization',
};
const apD1Path = 'Knowledge Base/Architecture & Engineering/D - Architecture & Engineering - AP-D1 - Lift-and-Shift Without Optimization.pdf';
const longPrefix = 'Persistent migration economics context. '.repeat(220);
const apD1Body = `Purpose
${longPrefix}
This prose mentions Validation Questions but is not a heading boundary.
Canonical Definition
Persistent inherited infrastructure assumptions create inefficient cloud economics.
Primary Assessment Questions
Were workloads migrated without cloud-native optimization?
Anti-Pattern State Interpretation
confirmed_present requires persistent operational evidence.
Evidence Requirements
Strong Evidence
Persistently low utilization and inherited VM sizing.
Moderate Evidence
A modernization backlog with incomplete rightsizing.
Weak Evidence
Virtual machine use alone.
Contradictory Evidence
Operational autoscaling and recurring rightsizing.
False Positive Guards
A recent migration or temporary over-provisioning is not sufficient.
Validation Questions
Are workloads rightsized operationally?
Detection Heuristics
Same VM sizes as on-premises is a strong signal.
Prohibited Inference Rules
VM usage must not be treated as proof of this anti-pattern.
Scoring Guidance Notes
confirmed_present requires persistent inherited inefficiency.
Canonical Source Foundations
FinOps Foundation.`;
const apD1Text = `${JSON.stringify(apD1Meta, null, 2)}\n\n${apD1Body}`;
const apD1LegacyText = `${JSON.stringify(apD1Meta)}\n\n${apD1Body.replace(/\n/g, ' ')}`;
const sections = extractKbSections(apD1Text);
assert(Object.hasOwn(sections, 'evidence_requirements'));
assert(sections.false_positive_guards.includes('recent migration'));
assert(sections.prohibited_inference_rules.includes('must not be treated as proof'));
assert(sections.scoring_guidance.includes('persistent inherited inefficiency'));
assert(!sections.purpose.includes('Are workloads rightsized operationally?'));

const apD1Doc = sanitizeKbDocument({
  pathname: apD1Path,
  text: apD1LegacyText,
  sectionText: apD1Text,
  pdfSha256: 'sha256_pdf',
  extractedTextSha256: 'sha256_text',
  extraction: {
    totalPages: 15,
    processedPages: 15,
    sparsePages: [],
    pageLimitReached: false,
  },
});
assert(apD1Doc.body_excerpt.length > 6000, 'complete KB body must not be truncated at ingestion');
assert(!apD1Doc.body_excerpt.includes('[truncated]'));
assert(!apD1Doc.body_excerpt.includes('\nCanonical Definition'), 'legacy prompt body representation must remain flattened');
assert(apD1Doc.sections.validation_questions.includes('rightsized operationally'));
assert.equal(apD1Doc.extraction.processed_pages, 15);
assert.equal(apD1Doc.extraction.page_limit_reached, false);
assert.equal(apD1Doc.extraction.section_order_valid, true);
assert.deepEqual(apD1Doc.extraction.duplicate_section_headings, []);
assert.equal(apD1Doc.pdf_sha256, 'sha256_pdf');

const status = buildKbStatus([apD1Doc], [], 'remote_blob', 'Knowledge Base/');
assert.equal(status.delivery.sectioned_document_count, 1);
assert.equal(status.delivery.missing_expected_document_count, 59);
assert.equal(status.delivery.shadow_ready, false);

const completeDocuments = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(domainId => (
  Array.from({ length: 5 }, (_, index) => {
    const capabilityId = `${domainId}${index + 1}`;
    return [
      { ...apD1Doc, domain_id: domainId, stream: 'maturity', criterion_id: capabilityId, capability_id: capabilityId },
      { ...apD1Doc, domain_id: domainId, stream: 'antipattern', criterion_id: `AP-${capabilityId}`, capability_id: capabilityId },
    ];
  }).flat()
));
const completeStatus = buildKbStatus(completeDocuments, [], 'remote_blob', 'Knowledge Base/');
assert.equal(completeStatus.delivery.missing_expected_document_count, 0);
assert.equal(completeStatus.delivery.unexpected_document_count, 0);
assert.equal(completeStatus.delivery.duplicate_document_count, 0);
assert.equal(completeStatus.delivery.shadow_ready, true);

await assert.rejects(
  fetchBlobBytes({ pathname: 'oversized.pdf', size: (20 * 1024 * 1024) + 1, url: 'https://example.test/oversized.pdf' }, 'token'),
  /KB_PDF_BYTE_LIMIT_EXCEEDED/
);

const originalFetch = globalThis.fetch;
let listCalls = 0;
globalThis.fetch = async () => {
  const page = listCalls++;
  const start = page * 100;
  const count = page < 3 ? 100 : 1;
  return {
    ok: true,
    json: async () => ({
      blobs: Array.from({ length: count }, (_, index) => ({ pathname: `non-pdf-${start + index}.txt` })),
      hasMore: page < 3,
      cursor: page < 3 ? `cursor-${page + 1}` : undefined,
    }),
  };
};
try {
  const boundedListing = await listBlobPdfs({ token: 'vercel_blob_rw_store_secret', prefix: 'Knowledge Base/' });
  assert.equal(listCalls, 4);
  assert.equal(boundedListing.blobs.length, 0);
  assert.equal(boundedListing.limitReached, true);
} finally {
  globalThis.fetch = originalFetch;
}

{
  const kbOutDir = await mkdtemp(join(tmpdir(), 'finops-kb-runtime-'));
  const kbModulePath = await emitTypescript(new URL('../src/knowledge_base/index.ts', import.meta.url).pathname, kbOutDir);
  const { formatRemoteKbContext } = await import(`file://${kbModulePath}`);

  const richApD1Doc = {
    ...apD1Doc,
    sections: {
      ...apD1Doc.sections,
      risk_notes: 'Aggressive lift-and-shift refactoring without dependency mapping risks outages.',
      remediation_tactic_notes: 'Sequence TAC-ARCH-001 pilots on stable high-cost workloads with rollback gates.',
    },
  };
  const unsectionedDoc = {
    ...doc,
    sections: {},
    body_excerpt: '[KB_PDF_PAGE page="1"] Unsectioned fallback rubric text for A1. [/KB_PDF_PAGE]',
  };
  const runtimeIndex = {
    status: { source: 'remote_blob', document_count: 60, failure_count: 0 },
    documents: [
      ...completeDocuments.map(d => (
        d.criterion_id === 'AP-D1' ? richApD1Doc : { ...d, sections: richApD1Doc.sections }
      )).filter(d => d.criterion_id !== 'A1'),
      unsectionedDoc,
    ],
    failures: [],
  };

  // Domain forensic_audit must deliver late-PDF rubric sections despite >8,000-char Purpose intro
  const domainDAudit = formatRemoteKbContext(runtimeIndex, { batchId: 'D', label: 'forensic_audit' });
  assert.match(domainDAudit, /stage="forensic_audit"/);
  assert.match(domainDAudit, /\[KB_SECTION name="false_positive_guards"\][\s\S]*recent migration/);
  assert.match(domainDAudit, /\[KB_SECTION name="validation_questions"\][\s\S]*rightsized operationally/);
  assert.match(domainDAudit, /\[KB_SECTION name="prohibited_inference_rules"\][\s\S]*must not be treated as proof/);
  assert.match(domainDAudit, /\[KB_SECTION name="scoring_guidance"\][\s\S]*persistent inherited inefficiency/);
  assert.doesNotMatch(domainDAudit, /\[truncated\]/, 'complete domain sections must not be head-truncated');

  // Targeted criterion filter must retrieve only the requested criterion IDs
  const targetedContext = formatRemoteKbContext(runtimeIndex, {
    batchId: 'D',
    criterionIds: ['AP-D1'],
    label: 'targeted_rescan',
  });
  assert.match(targetedContext, /1 criterion rubric\(s\)/);
  assert.match(targetedContext, /\[ANTIPATTERN AP-D1\]/);
  assert.doesNotMatch(targetedContext, /\[MATURITY D1\]/);

  // evidence_synthesis label must map to 'synthesis' (not 'evidence_check') and exclude silent domains
  const synthesisContext = formatRemoteKbContext(runtimeIndex, {
    criterionIds: ['AP-D1', 'E1'],
    excludeDomainIds: ['E'],
    label: 'evidence_synthesis',
  });
  assert.match(synthesisContext, /stage="synthesis"/);
  assert.match(synthesisContext, /\[ANTIPATTERN AP-D1\]/);
  assert.doesNotMatch(synthesisContext, /\[MATURITY E1\]/, 'silent domains must be excluded');

  // roadmap_synthesis / phase3_strategy must deliver bottom-of-PDF risk_notes and remediation_tactic_notes
  const roadmapContext = formatRemoteKbContext(runtimeIndex, {
    criterionIds: ['AP-D1'],
    excludeDomainIds: ['E'],
    label: 'phase3_strategy',
  });
  assert.match(roadmapContext, /stage="roadmap_synthesis"/);
  assert.match(roadmapContext, /\[KB_SECTION name="risk_notes"\][\s\S]*dependency mapping risks outages/);
  assert.match(roadmapContext, /\[KB_SECTION name="remediation_tactic_notes"\][\s\S]*Sequence TAC-ARCH-001 pilots/);

  // Unsectioned documents must fall back cleanly with PDF page markers stripped
  const fallbackDocContext = formatRemoteKbContext(runtimeIndex, {
    batchId: 'A',
    criterionIds: ['A1'],
    label: 'forensic_audit',
  });
  assert.match(fallbackDocContext, /Unsectioned fallback rubric text for A1\./);
  assert.doesNotMatch(fallbackDocContext, /KB_PDF_PAGE/);
  // Taxonomy registry naming examples must match expectedIdsFromPathname in lib/kbIndex.js
  const taxonomyRegistry = JSON.parse(
    await readFile(new URL('../src/knowledge_base/finops_taxonomy_registry.json', import.meta.url), 'utf8')
  );
  assert.equal(taxonomyRegistry.kb_document_naming.expected_document_count, 60);
  for (const examplePath of taxonomyRegistry.kb_document_naming.examples) {
    assert.ok(
      expectedIdsFromPathname(examplePath),
      `taxonomy kb_document_naming example must match canonical parser: ${examplePath}`,
    );
  }
}

console.log('KB index tests passed');
