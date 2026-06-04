import assert from 'node:assert/strict';
import {
  extractJsonFrontMatter,
  expectedIdsFromPathname,
  normalizeDomainName,
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

console.log('KB index tests passed');
