import type { EvidenceSourceAcquisition, EvidenceSourceFormat } from '../types';

const extensionFor = (name: string): string => name.toLowerCase().split('.').pop() || '';
const IMPLEMENTED_EXTRACTION_FORMATS = new Set<EvidenceSourceFormat>(['pdf', 'html', 'csv', 'tsv', 'json', 'xlsx', 'png', 'jpeg', 'webp']);

const formatForExtension = (name: string): EvidenceSourceFormat | null => {
  const extension = extensionFor(name);
  if (extension === 'jpg') return 'jpeg';
  if (['pdf', 'html', 'csv', 'tsv', 'json', 'xlsx', 'png', 'jpeg', 'webp'].includes(extension)) {
    return extension as EvidenceSourceFormat;
  }
  return null;
};

const startsWith = (bytes: Uint8Array, expected: number[]): boolean =>
  expected.every((value, index) => bytes[index] === value);

const decodePrefix = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096)).replace(/^\uFEFF/, '').trimStart();

const detectedFromBytes = (
  bytes: Uint8Array,
  expectedFormat: EvidenceSourceFormat
): Pick<EvidenceSourceAcquisition, 'format' | 'detected_media_type' | 'detection_method'> | null => {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { format: 'pdf', detected_media_type: 'application/pdf', detection_method: 'magic_bytes' };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { format: 'png', detected_media_type: 'image/png', detection_method: 'magic_bytes' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { format: 'jpeg', detected_media_type: 'image/jpeg', detection_method: 'magic_bytes' };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { format: 'webp', detected_media_type: 'image/webp', detection_method: 'magic_bytes' };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && expectedFormat === 'xlsx') {
    return {
      format: 'xlsx',
      detected_media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      detection_method: 'magic_bytes'
    };
  }

  const prefix = decodePrefix(bytes);
  if (expectedFormat === 'json') {
    try {
      JSON.parse(new TextDecoder().decode(bytes));
      return { format: 'json', detected_media_type: 'application/json', detection_method: 'structured_text' };
    } catch {
      return null;
    }
  }
  if (expectedFormat === 'html' && /^(?:<!doctype\s+html|<[a-z][a-z0-9:-]*(?:\s|>))/i.test(prefix)) {
    return { format: 'html', detected_media_type: 'text/html', detection_method: 'structured_text' };
  }
  if (expectedFormat === 'csv' || expectedFormat === 'tsv') {
    const lines = prefix.split(/\r?\n/).filter(Boolean).slice(0, 5);
    if (lines.length === 0) return null;

    // Locale CSV exports (e.g. Finnish/European Excel) commonly use ';' instead of ','.
    // Accept either delimiter for .csv; TSV remains tab-only.
    const hasComma = lines.some(line => line.includes(','));
    const hasSemicolon = lines.some(line => line.includes(';'));
    const hasTab = lines.some(line => line.includes('\t'));

    if (expectedFormat === 'csv' && (hasComma || hasSemicolon)) {
      return {
        format: 'csv',
        detected_media_type: 'text/csv',
        detection_method: 'structured_text'
      };
    }
    if (expectedFormat === 'tsv' && hasTab) {
      return {
        format: 'tsv',
        detected_media_type: 'text/tab-separated-values',
        detection_method: 'structured_text'
      };
    }
  }
  return null;
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer);
  return `sha256_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const inspectEvidenceBytes = async (input: {
  bytes: Uint8Array;
  fileName: string;
  declaredMediaType?: string;
}): Promise<EvidenceSourceAcquisition> => {
  const expectedFormat = formatForExtension(input.fileName);
  const validationCodes: string[] = [];
  if (!expectedFormat) validationCodes.push('UNSUPPORTED_EXTENSION');
  const detected = expectedFormat ? detectedFromBytes(input.bytes, expectedFormat) : null;
  if (!detected) validationCodes.push('CONTENT_TYPE_UNDETECTED');
  if (detected && expectedFormat && detected.format !== expectedFormat) validationCodes.push('EXTENSION_CONTENT_MISMATCH');
  if (detected && !IMPLEMENTED_EXTRACTION_FORMATS.has(detected.format)) validationCodes.push('EXTRACTION_NOT_IMPLEMENTED');

  return {
    schema_version: 'evidence_source_acquisition_v1',
    source_role: 'CUSTOMER_EVIDENCE',
    original_sha256: await sha256(input.bytes),
    byte_size: input.bytes.byteLength,
    declared_media_type: input.declaredMediaType || 'application/octet-stream',
    detected_media_type: detected?.detected_media_type || 'application/octet-stream',
    format: detected?.format || expectedFormat || 'json',
    detection_method: detected?.detection_method || 'structured_text',
    validation_status: validationCodes.length === 0 ? 'PASS' : 'BLOCK',
    validation_codes: validationCodes,
    extraction_method: 'not_started',
    extraction_version: 'not_started',
    extraction_status: validationCodes.length === 0 ? 'PENDING' : 'BLOCK'
  };
};

export const inspectEvidenceFile = async (file: File): Promise<EvidenceSourceAcquisition> =>
  inspectEvidenceBytes({
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
    declaredMediaType: file.type
  });
