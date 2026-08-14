
import DOMPurify from 'dompurify';

export const forensicSanitizeImport = (dirtyHtml: string): string => {
  return DOMPurify.sanitize(dirtyHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onmouseover', 'onclick', 'onerror', 'onload']
  });
};

export const validateMetadataPayload = (payload: any): boolean => {
  if (!payload) return false;
  const size = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (size > 500000) return false;
  const validKeys = ['meta', 'phase_1_audit_logs', 'phase_2_validation', 'phase_3_strategy'];
  return validKeys.every(k => k in payload);
};
