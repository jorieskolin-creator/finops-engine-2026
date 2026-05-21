import assert from 'node:assert/strict';
import {
  extractJsonFrontMatter,
  expectedIdsFromPathname,
  normalizeCapabilityId,
  normalizeCriterionId,
  sanitizeKbDocument,
  validateKbMetadata,
} from '../lib/kbIndex.js';

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

assert.deepEqual(expectedIdsFromPathname(maturityPath), {
  domainId: 'A',
  domainName: 'Cost Visibility & Allocation',
  criterionId: 'A1',
  capabilityId: 'A1',
  stream: 'maturity',
});

assert.deepEqual(validateKbMetadata(baseMeta, maturityPath), []);

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

console.log('KB index tests passed');
