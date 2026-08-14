import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'finops-visual-acquisition-'));
const bundle = async (name, entry, external = []) => {
  const outfile = join(dir, `${name}.mjs`);
  await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    external,
    logLevel: 'silent',
  });
  return import(`file://${outfile}`);
};

const { normalizeOcrResult } = await bundle('ocr', '../src/services/ocrService.ts', ['tesseract.js']);
const { sanitizeEvidenceSources } = await bundle('privacy', '../src/services/deterministicPrivacyService.ts');
const { buildSourceRegistry, buildDomainPackets, scanRegistryDlp, sourceRegistryRuntimeStatus } = await bundle('registry', '../src/services/sourceRegistryService.ts');
const { inspectEvidenceBytes } = await bundle('inspection', '../src/services/evidenceFileService.ts');

const sourceHash = `sha256_${'a'.repeat(64)}`;
const pendingUnit = normalizeOcrResult({
  sourceHash,
  width: 800,
  height: 600,
  text: 'Tagging owner alice@example.com and allocation coverage',
  confidence: 66.5,
  blocks: [{ paragraphs: [{ lines: [{ words: [
    { text: 'Tagging', confidence: 91, bbox: { x0: 10, y0: 10, x1: 80, y1: 30 } },
    { text: 'alice@example.com', confidence: 82, bbox: { x0: 90, y0: 10, x1: 230, y1: 30 } },
  ] }] }] }]
});
assert.equal(pendingUnit.words.length, 2);
assert.equal(pendingUnit.withheld_regions[0].reason, 'UNINSPECTED_VISUAL_REGION');
assert.equal(pendingUnit.visual_interpretation_status, 'OCR_TEXT_ONLY');

const acquisition = {
  schema_version: 'evidence_source_acquisition_v1', source_role: 'CUSTOMER_EVIDENCE',
  original_sha256: sourceHash, byte_size: 1024, declared_media_type: 'image/png',
  detected_media_type: 'image/png', format: 'png', detection_method: 'magic_bytes',
  validation_status: 'PASS', validation_codes: [], extraction_method: 'local_ocr',
  extraction_version: 'tesseract.js@7.0.0', extraction_status: 'PASS'
};
const rawSource = {
  schema_version: 'source_record_v1', source_id: 'src-visual', source_name: 'private-name.png', kind: 'image',
  acquisition, extraction: { unit: 'document', total_units: 1, processed_units: 1, truncated: false },
  parse_warnings: ['OCR text only; visual semantics are uninspected.'],
  visual_units: [{ ...pendingUnit, source_id: 'src-visual' }]
};
const privacy = sanitizeEvidenceSources([rawSource]);
assert.equal(privacy.decision.decision, 'PASS_WITH_REDACTIONS');
assert.equal(privacy.decision.scanned_text_unit_count, 1, 'canonical OCR text is scanned exactly once');
assert.equal(privacy.sources[0].visual_units[0].text, 'Tagging owner [EMAIL_REDACTED] and allocation coverage');
assert.ok(privacy.sources[0].visual_units[0].words.every(word => word.text === '[OCR_TOKEN_WITHHELD]'));
assert.equal(privacy.sources[0].visual_units[0].post_ocr_redaction_status, 'PASSED_WITH_REDACTIONS');

const registry = buildSourceRegistry(privacy.sources);
assert.equal(registry.source_count, 1);
assert.equal(registry.chunks[0].type, 'image');
assert.equal(registry.chunks[0].visual_unit_id, pendingUnit.unit_id);
assert.deepEqual(registry.chunks[0].bounding_box, { x0: 0, y0: 0, x1: 800, y1: 600 });
assert.equal(registry.chunks[0].ocr_confidence, 66.5);
assert.equal(registry.chunks[0].ocr_extraction_method, 'local_ocr');
assert.equal(registry.chunks[0].ocr_engine_version, 'tesseract.js@7.0.0');
assert.equal(registry.chunks[0].ocr_language, 'eng');
assert.equal(registry.chunks[0].post_ocr_redaction_status, 'PASSED_WITH_REDACTIONS');
assert.equal(registry.chunks[0].visual_interpretation_status, 'OCR_TEXT_ONLY');
assert.equal(registry.chunks[0].withheld_visual_region_count, 1);
assert.doesNotMatch(JSON.stringify(registry), /alice@example\.com/);
const packet = buildDomainPackets(registry).A;
assert.match(packet.text, /visual_unit_id=/);
assert.match(packet.text, /region="0,0,800,600"/);
assert.match(packet.text, /ocr_method="local_ocr"/);
assert.match(packet.text, /post_ocr_redaction="PASSED_WITH_REDACTIONS"/);
assert.equal(packet.manifest[0].ocr_engine_version, 'tesseract.js@7.0.0');
assert.equal(packet.manifest[0].withheld_visual_region_count, 1);
assert.doesNotMatch(packet.text, /private-name\.png/, 'browser-local filename must not enter the model packet');
assert.deepEqual(packet.images, [], 'raw customer image bytes must never enter the model packet');
const packets = buildDomainPackets(registry);
const dlp = scanRegistryDlp(registry);
const readiness = sourceRegistryRuntimeStatus(
  registry,
  packets,
  0,
  dlp,
  privacy.decision,
  { registry_hash: 'registry-hash', packet_manifest_hash: 'packet-hash' }
);
assert.equal(readiness.acquisition_readiness.status, 'READY_WITH_WARNINGS');
assert.ok(readiness.acquisition_readiness.reasons.includes('EXTRACTION_WARNINGS_PRESENT'));
assert.equal(readiness.acquisition_readiness.registry_hash, 'registry-hash');

assert.throws(() => buildSourceRegistry([{
  ...privacy.sources[0],
  visual_units: [{ ...privacy.sources[0].visual_units[0], width: 10000, height: 10000 }]
}]), /INVALID_VISUAL_EVIDENCE_UNIT/, 'oversized visual units must fail closed');
assert.throws(() => buildSourceRegistry([rawSource]), /INVALID_VISUAL_EVIDENCE_UNIT/, 'unredacted pending OCR must not enter the registry');

const png = await inspectEvidenceBytes({
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  fileName: 'evidence.png', declaredMediaType: 'image/png'
});
assert.equal(png.validation_status, 'PASS');
const disguised = await inspectEvidenceBytes({
  bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0x00]),
  fileName: 'evidence.png', declaredMediaType: 'image/png'
});
assert.equal(disguised.validation_status, 'BLOCK');
assert.ok(disguised.validation_codes.includes('EXTENSION_CONTENT_MISMATCH'));

console.log('visual acquisition tests passed');
