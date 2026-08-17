import crypto from 'node:crypto';
import { LIFETIMES_MS } from './controlPlanePolicy.js';
import { authorizedProfiles, configuredProfile, settingsForProfile } from './modelRoutingPolicy.js';
import { authorizeOutputContract } from './outputContracts.js';

export const STAGE_PACKET_REQUEST_VERSION = 'stage_packet_request_v1';
export const APPROVED_STAGE_PACKET_VERSION = 'approved_stage_packet_v1';
export const GOVERNED_OUTPUT_VERSION = 'governed_output_v1';
export const POLICY_VERSION = 'llm_egress_policy_v1';
export const APPROVED_PACKET_HASH_POLICY_VERSION = 'approved_packet_canonical_bytes_sha256_v3';

export class GovernanceError extends Error {
  constructor(code, status = 400, terminationReason) {
    super(code);
    this.code = code;
    this.status = status;
    if (terminationReason) this.terminationReason = terminationReason;
  }
}

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const exactKeys = (o, required, optional = []) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new GovernanceError('INVALID_PACKET');
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(o).some(k => !allowed.has(k)) || required.some(k => !(k in o))) throw new GovernanceError('INVALID_PACKET_KEYS');
};
export const canonicalize = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonicalize).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
export const sha256 = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : canonicalize(value)).digest('hex');
// PostgreSQL stores this exact canonical byte sequence. packet_hash is durable
// metadata over the body and is therefore excluded from the self-hashed body.
export const normalizeApprovedPacket = packet => JSON.parse(JSON.stringify(packet));
export const approvedPacketBytes = packet => { const { packet_hash: _ignored, ...content } = normalizeApprovedPacket(packet); return Buffer.from(canonicalize(content), 'utf8'); };
export const approvedPacketHash = packet => sha256(approvedPacketBytes(packet));
export const parseApprovedPacketBody = (body, packetHash) => {
  const bytes = Buffer.from(body);
  if (sha256(bytes) !== packetHash) throw new GovernanceError('PACKET_CONTENT_HASH_MISMATCH');
  return { ...JSON.parse(bytes.toString('utf8')), packet_hash: packetHash };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKET_FIELDS = ['packet_id','packet_hash','schema_version','policy_version','hash_policy_version','run_id','stage','provider','model','destination','system_instruction','parts','settings','output_contract','sanitization_status','classification_method','approval_basis','residual_classification','created_at','expires_at'];
const safeRuntimeValue = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;
export const packetRuntimeDiagnostics = (packet, canonicalBody = approvedPacketBytes(packet)) => ({
  declared_packet_hash: safeRuntimeValue(packet?.packet_hash),
  recomputed_content_hash: packet && typeof packet === 'object' ? sha256(canonicalBody) : undefined,
  hash_policy_version: safeRuntimeValue(packet?.hash_policy_version) || 'legacy_unspecified',
  packet_schema: safeRuntimeValue(packet?.schema_version),
  serialized_bytes: Buffer.byteLength(canonicalBody || ''),
  field_presence_bitmap: PACKET_FIELDS.map(field => Object.hasOwn(packet || {}, field) ? '1' : '0').join(''),
  app_commit: safeRuntimeValue(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA) || 'unknown',
  deployment_id: safeRuntimeValue(process.env.RAILWAY_DEPLOYMENT_ID) || 'unknown',
  replica_id: safeRuntimeValue(process.env.RAILWAY_REPLICA_ID) || safeRuntimeValue(process.env.HOSTNAME) || 'unknown',
  node_runtime: safeRuntimeValue(process.version) || 'unknown',
});

export const evaluatePacketBinding = (packet, expected = {}, canonicalBody) => {
  const matches = {
    packet_id_match: packet?.packet_id === expected.packetId,
    packet_hash_match: packet?.packet_hash === expected.packetHash,
    content_hash_match: (canonicalBody ? sha256(canonicalBody) : approvedPacketHash(packet)) === expected.packetHash,
    run_id_match: packet?.run_id === expected.runId,
    provider_match: packet?.provider === expected.provider,
    model_match: expected.model === undefined || packet?.model === expected.model,
    stage_match: packet?.stage === expected.stage,
  };
  const code = !matches.packet_id_match ? 'PACKET_ID_MISMATCH'
    : !matches.packet_hash_match ? 'PACKET_HASH_METADATA_MISMATCH'
      : !matches.content_hash_match ? 'PACKET_CONTENT_HASH_MISMATCH'
        : !matches.run_id_match ? 'PACKET_RUN_MISMATCH'
          : !matches.provider_match ? 'PACKET_PROVIDER_MISMATCH'
            : !matches.model_match ? 'PACKET_MODEL_MISMATCH'
              : !matches.stage_match ? 'PACKET_STAGE_MISMATCH'
                : null;
  return { code, matches };
};
export function authorizeDestination(stage, provider, model, settings = {}) {
  const approved = authorizedProfiles(stage, provider, model);
  if (!approved.length) throw new GovernanceError('DESTINATION_NOT_AUTHORIZED', 403);
  exactKeys(settings, [], ['max_tokens','reasoning_effort']);
  if (!approved.some(candidate => canonicalize(normalizeApprovedPacket(settings)) === canonicalize(settingsForProfile(candidate)))) {
    throw new GovernanceError('INVALID_MODEL_SETTINGS');
  }
  return true;
}
export function authorizeConfiguredDestination(stage, provider, model, settings = {}, env = process.env) {
  const configured = configuredProfile(stage, provider, model, env);
  if (!configured || canonicalize(normalizeApprovedPacket(settings)) !== canonicalize(settingsForProfile(configured))) {
    throw new GovernanceError('DESTINATION_NOT_CONFIGURED', 403);
  }
  return true;
}
const forbiddenPayload = /data:image\/|;base64,|"type"\s*:\s*"(?:image|input_image)"|"(?:data|image_url)"\s*:\s*"[A-Za-z0-9+/]{256}/i;
const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token)\s*[:=]\s*\S+/i;
const sensitiveFinancialValue = /\b(?:negotiated\s+(?:discount\s+)?rates?|discount\s+rate|contract\s+value|edp\s+pricing)\b[^\n]{0,48}(?:[$€£]\s?\d[\d,.]*|\d+(?:\.\d+)?\s*%)/i;
const sensitiveFinancialId = /\b(?:billing\s+account|invoice(?:\s+(?:number|no\.?|id))?)\b\s*(?:number|no\.?|id)?\s*[:#=-]\s*[A-Z0-9][A-Z0-9_-]{4,}/i;
const personalIdentity = /\b\d{3}-\d{2}-\d{4}\b|\bpassport(?:\s+(?:number|no\.?|id))?\s*[:#=-]\s*[A-Z0-9][A-Z0-9_-]{5,}|\b(?:bank|credit\s+card|routing)\s+(?:account\s+)?(?:number|no\.?|id)\s*[:#=-]\s*[A-Z0-9][A-Z0-9 _-]{5,}|\b(?:home|residential)\s+address\s*[:#=-]\s*[^\n]{5,160}/i;
const emailDetect = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phoneDetect = /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3}[ .-]\d{4}(?![\w.-])/;
const ipDetect = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
const emailReplace = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phoneReplace = /(?<![\w.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3}[ .-]\d{4}(?![\w.-])/g;
const ipReplace = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const detectionView = value => value
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&apos;|&#39;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&')
  .replace(/(["'])([A-Za-z][A-Za-z0-9 _-]{0,63})\1\s*:/g, '$2:')
  .replace(/:\s*["']/g, ':')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ');
const detectProhibited = value => {
  const view = detectionView(value);
  if (forbiddenPayload.test(value) || forbiddenPayload.test(view)) throw new GovernanceError('IMAGE_PAYLOAD_DISABLED');
  if (secret.test(view)) throw new GovernanceError('SECRET_MATERIAL_REJECTED');
  if (personalIdentity.test(view)) throw new GovernanceError('RESIDUAL_CLASSIFICATION_REJECTED');
  if (sensitiveFinancialValue.test(view) || sensitiveFinancialId.test(view)) throw new GovernanceError('RESIDUAL_CLASSIFICATION_REJECTED');
  return view;
};
const hasUnpairedSurrogate = value => {
  for (let i=0;i<value.length;i++) { const c=value.charCodeAt(i); if(c>=0xD800&&c<=0xDBFF){ if(i+1>=value.length||value.charCodeAt(i+1)<0xDC00||value.charCodeAt(i+1)>0xDFFF)return true; i++; } else if(c>=0xDC00&&c<=0xDFFF)return true; }
  return false;
};
export function sanitizeText(value) {
  if (typeof value !== 'string' || value.length > 500000 || /\0/.test(value)) throw new GovernanceError('INVALID_TEXT');
  detectProhibited(value);
  return value.replace(emailReplace, '[REDACTED_EMAIL]').replace(phoneReplace, '[REDACTED_PHONE]').replace(ipReplace, '[REDACTED_IP]');
}
export function approveRequestArtifact(raw, now = Date.now()) {
  exactKeys(raw, ['schema_version','policy_version','run_id','stage','provider','model','destination','system_instruction','parts','settings'], ['output_contract','stage_execution_id']);
  if (raw.schema_version !== STAGE_PACKET_REQUEST_VERSION) throw new GovernanceError('UNSUPPORTED_SCHEMA_VERSION');
  if (raw.policy_version !== POLICY_VERSION) throw new GovernanceError('UNSUPPORTED_POLICY_VERSION');
  if (![raw.run_id,raw.stage,raw.provider,raw.model].every(v => typeof v === 'string' && IDENT.test(v))) throw new GovernanceError('INVALID_IDENTIFIER');
  if (raw.stage_execution_id !== undefined && (typeof raw.stage_execution_id !== 'string' || !UUID.test(raw.stage_execution_id))) throw new GovernanceError('INVALID_IDENTIFIER');
  if (raw.destination !== `${raw.provider}:external_model`) throw new GovernanceError('DESTINATION_NOT_AUTHORIZED', 403);
  authorizeDestination(raw.stage, raw.provider, raw.model, raw.settings);
  try { authorizeOutputContract(raw.stage, raw.output_contract); }
  catch { throw new GovernanceError('OUTPUT_CONTRACT_NOT_AUTHORIZED', 403); }
  if (!Array.isArray(raw.parts) || raw.parts.length !== 1) throw new GovernanceError('INVALID_PARTS');
  exactKeys(raw.parts[0], ['type','text']);
  if (raw.parts[0].type !== 'text' || typeof raw.system_instruction !== 'string' || typeof raw.parts[0].text !== 'string') throw new GovernanceError('INVALID_PARTS');
  const joinedFields = `${raw.system_instruction}${raw.parts[0].text}`;
  detectProhibited(joinedFields);
  if ((emailDetect.test(joinedFields) || phoneDetect.test(joinedFields) || ipDetect.test(joinedFields))
    && !emailDetect.test(raw.system_instruction) && !phoneDetect.test(raw.system_instruction) && !ipDetect.test(raw.system_instruction)
    && !emailDetect.test(raw.parts[0].text) && !phoneDetect.test(raw.parts[0].text) && !ipDetect.test(raw.parts[0].text)) {
    throw new GovernanceError('SPLIT_IDENTIFIER_REJECTED');
  }
  const parts = raw.parts.map(part => { exactKeys(part, ['type','text']); if (part.type !== 'text') throw new GovernanceError('IMAGE_PAYLOAD_DISABLED'); return { type: 'text', text: sanitizeText(part.text) }; });
  const system_instruction = sanitizeText(raw.system_instruction || '');
  const content = normalizeApprovedPacket({ schema_version: APPROVED_STAGE_PACKET_VERSION, policy_version: POLICY_VERSION, hash_policy_version: APPROVED_PACKET_HASH_POLICY_VERSION, packet_id: crypto.randomUUID(), run_id: raw.run_id, stage: raw.stage, ...(raw.stage_execution_id ? { stage_execution_id: raw.stage_execution_id } : {}), provider: raw.provider, model: raw.model, destination: raw.destination, system_instruction, parts, settings: raw.settings, ...(raw.output_contract ? { output_contract: raw.output_contract } : {}), sanitization_status: 'passed', classification_method: 'deterministic_pattern_screen_v1', approval_basis: 'policy_approved_after_pattern_screening', residual_classification: 'PUBLIC_OR_APPROVED_FOR_EXTERNAL_PROCESSING', created_at: new Date(now).toISOString(), expires_at: new Date(now + LIFETIMES_MS.packet).toISOString() });
  const canonicalBody = Buffer.from(canonicalize(content), 'utf8');
  return { packet: { ...content, packet_hash: sha256(canonicalBody) }, canonicalBody };
}
export function approveRequest(raw, now = Date.now()) { return approveRequestArtifact(raw, now).packet; }
export function inspectOutput(text, source, now = Date.now()) {
  try { if (typeof text !== 'string' || !text.trim() || text.length > 1000000 || text.includes('\0') || hasUnpairedSurrogate(text)) throw new Error(); detectProhibited(text); }
  catch { throw new GovernanceError('OUTPUT_INSPECTION_REJECTED', 502); }
  const inspected = text.replace(emailReplace, '[REDACTED_EMAIL]').replace(phoneReplace, '[REDACTED_PHONE]').replace(ipReplace, '[REDACTED_IP]');
  const out = { schema_version: GOVERNED_OUTPUT_VERSION, policy_version: POLICY_VERSION, output_id: crypto.randomUUID(), output_hash: sha256(inspected), source_packet_id: source.packet_id, source_packet_hash: source.packet_hash, run_id: source.run_id, stage: source.stage, provider: source.provider, model: source.model, inspection_status: 'passed', inspection_method: 'deterministic_pattern_screen_and_contact_redaction_v1', inspected_at: new Date(now).toISOString(), char_count: inspected.length, text: inspected };
  return out;
}
export function validateGovernedOutput(o, expected = {}) {
  exactKeys(o, ['schema_version','policy_version','output_id','output_hash','source_packet_id','source_packet_hash','run_id','stage','provider','model','inspection_status','inspection_method','inspected_at','char_count','text']);
  if (o.schema_version !== GOVERNED_OUTPUT_VERSION || o.policy_version !== POLICY_VERSION || o.inspection_status !== 'passed' || o.inspection_method !== 'deterministic_pattern_screen_and_contact_redaction_v1' || o.output_hash !== sha256(o.text) || o.char_count !== o.text.length || Object.entries(expected).some(([k,v]) => v !== undefined && o[k] !== v)) throw new GovernanceError('INVALID_GOVERNED_OUTPUT');
  return o;
}
