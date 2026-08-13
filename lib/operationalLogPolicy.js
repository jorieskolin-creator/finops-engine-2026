// Pure, dependency-free policy for client-originated operational logs.
// An event must be known and each event gets its own metadata allowlist.
const EVENT_FIELDS = Object.freeze({
  pipeline_start: ['source_chars', 'images', 'model_mode'],
  source_registry_created: ['sources', 'chunks', 'dlp_review_chunks', 'images'],
  source_packet_created: ['domain', 'chunks', 'candidates', 'weak_coverage', 'chars', 'images'],
  source_packet_used: ['batch', 'chunks', 'candidates', 'weak_coverage', 'fallback', 'chars', 'images'],
  dlp_full_source_scan: ['chunks', 'high_risk_hits', 'caution_hits', 'blocked'],
  stage_complete: ['stage', 'provider', 'model', 'substage', 'duration_ms', 'attempt', 'bracket', 'regen'],
  stage_fallback_used: ['stage', 'succeeded_with', 'provider', 'failed_models'],
  stage_exhausted: ['stage', 'attempt_count', 'error_code'],
  internal_result_recovered: ['stage', 'model', 'internal_call_id', 'duration_ms', 'response_chars'],
  internal_result_error: ['stage', 'model', 'internal_call_id', 'error_code', 'http_status'],
  internal_result_timeout: ['stage', 'model', 'internal_call_id', 'duration_ms', 'error_code', 'attempt_status'],
  kb_index_loaded: ['documents', 'failures', 'source'],
  kb_index_fallback: ['documents', 'failures', 'source'],
  synthesis_confidence: ['bracket', 'evidence_density', 'delivery_integrity', 'silent_areas'],
  synthesis_routing: ['stage', 'reason_code', 'readiness', 'burden', 'antipatterns', 'gaps', 'class'],
  invalid_tactic_ids: ['invalid_count', 'regen'],
  invalid_tactic_ids_persisted: ['invalid_count'],
  roadmap_tactic_grounding_adjusted: ['adjustments'],
  fact_check_trajectory: ['passes'],
  fact_check_escalated: ['from_stage', 'to_stage', 'medium_attempts', 'blocking_reasons'],
  fact_check_escalation_result: ['ok', 'decision', 'model', 'supported', 'total', 'unsupported', 'error_code'],
  qg_explanation: ['decision', 'model', 'duration_ms', 'ok', 'error_code'],
  strategy_downgraded: ['from', 'to', 'decision'],
  pipeline_complete: ['outcome', 'duration_ms', 'quality_gate', 'bracket', 'synthesis_bracket', 'fact_check_supported', 'fact_check_total', 'model_mode'],
  pipeline_failed: ['duration_ms', 'error_code', 'model_mode'],
  evidence_adjudication_used: ['batch', 'model', 'criteria_count'],
  evidence_adjudication_failed: ['batch', 'criteria_count', 'error_code'],
  evidence_check_targeted_rescan: ['batch', 'criteria_count'],
  targeted_rescan_model_used: ['batch', 'model', 'criteria_count'],
  batch_complete: ['batch', 'attempt', 'model', 'evidence_check_model', 'evidence_adjudication_model', 'evidence_downgrades', 'evidence_rescans', 'duration_ms'],
  batch_attempt_failed: ['batch', 'attempt', 'error_code'],
  batch_failed: ['batch', 'error_code'],
  claims_sanitized: ['total', 'removed', 'rewritten', 'quarantined', 'remaining_unsupported'],
  claims_quarantined: ['total', 'removed', 'rewritten', 'quarantined', 'remaining_unsupported'],
});

const safeValue = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 160 && !/\r|\n|data:|base64/i.test(value)) return value;
  return undefined;
};

export function filterOperationalMetadata(event, fields = {}) {
  const allowed = EVENT_FIELDS[event];
  if (!allowed || !fields || typeof fields !== 'object') return {};
  const filtered = {};
  for (const key of allowed) {
    const value = safeValue(fields[key]);
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

export function isKnownOperationalEvent(event) {
  return typeof event === 'string' && Object.hasOwn(EVENT_FIELDS, event);
}

export function safeOperationalIdentifier(value, fallback = '?') {
  return typeof value === 'string'
    && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value)
    && !/\.(?:pdf|docx?|xlsx?|csv|txt|png|jpe?g|gif|webp)$/i.test(value)
    ? value
    : fallback;
}
