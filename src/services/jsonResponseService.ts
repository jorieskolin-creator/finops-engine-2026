const MALFORMED_RESPONSE_ERROR = 'AI response was malformed and could not be repaired safely.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stripRecognizedFence = (text: string): string => {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
};

const hasDangerousKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDangerousKey);
  if (!isRecord(value)) return false;
  return Object.keys(value).some(key =>
    key === '__proto__' || key === 'prototype' || key === 'constructor' || hasDangerousKey(value[key])
  );
};

const parseObject = (candidate: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) && !hasDangerousKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const balancedObjectCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}') {
      if (depth === 0) return [];
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return depth === 0 && !inString ? candidates : [];
};

export const parseGovernedJsonObject = (text: string): Record<string, unknown> => {
  if (!text?.trim()) throw new Error(MALFORMED_RESPONSE_ERROR);
  const cleaned = stripRecognizedFence(text);
  try {
    const direct: unknown = JSON.parse(cleaned);
    if (!isRecord(direct) || hasDangerousKey(direct)) throw new Error(MALFORMED_RESPONSE_ERROR);
    return direct;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  const candidates = balancedObjectCandidates(cleaned);
  if (candidates.length !== 1) throw new Error(MALFORMED_RESPONSE_ERROR);
  const parsed = parseObject(candidates[0]);
  if (!parsed) throw new Error(MALFORMED_RESPONSE_ERROR);
  return parsed;
};

export const validateFindingsModePayload = (payload: unknown): string[] => {
  if (!isRecord(payload) || !isRecord(payload.phase_3_strategy)) {
    return ['Missing phase_3_strategy object'];
  }
  const findings = payload.phase_3_strategy.findings_mode;
  if (!isRecord(findings)) return ['Missing findings_mode object'];

  const rules: Array<[string, number, number]> = [
    ['evidence_backed_findings', 4, 8],
    ['candidate_themes', 3, 6],
    ['missing_evidence', 4, 8],
    ['validation_plan', 3, 6],
  ];
  const errors: string[] = [];
  for (const [key, minimum, maximum] of rules) {
    const value = findings[key];
    if (!Array.isArray(value)) {
      errors.push(`findings_mode.${key} must be an array`);
      continue;
    }
    if (value.length < minimum || value.length > maximum) {
      errors.push(`findings_mode.${key} must contain ${minimum}-${maximum} items`);
    }
    if (value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
      errors.push(`findings_mode.${key} must contain non-empty strings only`);
    }
  }
  return errors;
};
