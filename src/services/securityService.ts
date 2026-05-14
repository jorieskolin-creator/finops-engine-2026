
import DOMPurify from 'dompurify';
import { ImageInput } from '../types';

export const forensicSanitizeImport = (dirtyHtml: string): string => {
  return DOMPurify.sanitize(dirtyHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onmouseover', 'onclick', 'onerror', 'onload']
  });
};

export const generateSafetyAuditPrompt = (textSample: string, images?: ImageInput[]) => {
  const imageCount = images?.length ?? 0;
  return `
<task>
You are a **Data Loss Prevention (DLP) Officer** for a FinOps Assessment Engine.
Scan the following text sample (first 1500 chars)${imageCount > 0 ? ` AND the ${imageCount} attached image part(s)` : ''} for High-Risk Content.

**HIGH-RISK CATEGORIES:**
1. **PII:** Social Security Numbers, Passport Numbers, Home Addresses, Personal Financial Data${imageCount > 0 ? ', faces of individuals in screenshots with names visible, employee photos' : ''}.
2. **SECRETS:** API Keys (AWS AKIA*, Azure keys, GCP service account keys), Passwords, Private Keys, Tokens${imageCount > 0 ? '. In images, look for visible keys in console screenshots, passwords on sticky notes, login screens with credentials, terminal output exposing tokens' : ''}.
3. **CLOUD CREDENTIALS:** Cloud account IDs with associated access keys, billing account numbers with pricing details${imageCount > 0 ? '. In images, check for visible account numbers next to access keys, billing-console screenshots showing exact dollar amounts and account IDs together' : ''}.
4. **FINANCIAL SENSITIVITY:** Exact contract values, specific negotiated discount rates, EDP pricing terms (flag but do not block — mark as CAUTION).
5. **IRRELEVANCE:** Cooking recipes, fiction, code repositories, or gibberish${imageCount > 0 ? '. For images: non-FinOps content (vacation photos, memes, unrelated screenshots)' : ''}.

**IMPORTANT:** Documents about cloud costs, budgets, and FinOps strategies are EXPECTED and should pass even if they mention dollar amounts in a business context. Only flag raw financial instruments or personal financial data.
${imageCount > 0 ? `\n**IMAGE-SPECIFIC GUIDANCE:** Dashboard screenshots, architecture diagrams, org charts, and PDF pages rendered as images are all EXPECTED FinOps content. Pass them unless they visibly contain one of the HIGH-RISK CATEGORIES above. A redacted dashboard or one showing percentages without raw dollar amounts is safe.\n` : ''}
**OUTPUT FORMAT:**
Return a JSON object ONLY:
{
  "safe": boolean,
  "risk_detected": "None" | "PII" | "Secrets" | "CloudCredentials" | "FinancialSensitivity" | "Irrelevant",
  "reason": "Short explanation${imageCount > 0 ? '. Name the image filename and approximate location if a secret was visible in an image.' : ''}",
  "caution_notes": "Optional: notes about financial sensitivity that should be handled with care"
}
</task>

<text_sample>
${textSample.substring(0, 1500)}...
</text_sample>
`;
};

export const validateMetadataPayload = (payload: any): boolean => {
  if (!payload) return false;
  const size = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (size > 500000) return false;
  const validKeys = ['meta', 'phase_1_audit_logs', 'phase_2_validation', 'phase_3_strategy'];
  return validKeys.every(k => k in payload);
};
