const EVENT_FIELDS = Object.freeze({
  execution_worker_started: [],
  execution_worker_loop_error: ['error_code'],
  execution_attempt_claimed: ['run_id', 'attempt_id', 'stage', 'provider', 'model', 'queue_age_ms'],
  execution_attempt_succeeded: ['run_id', 'attempt_id', 'stage', 'provider', 'model', 'duration_ms'],
  execution_attempt_failed: ['run_id', 'attempt_id', 'stage', 'provider', 'model', 'outcome_code', 'termination_reason', 'duration_ms'],
  execution_output_rejected: ['run_id', 'attempt_id', 'stage', 'provider', 'model', 'output_chars', 'balanced_object_count', 'failure_category'],
  execution_attempt_processing_error: ['attempt_id', 'error_code'],
  outbox_publisher_started: [],
  outbox_attempt_published: ['run_id', 'attempt_id'],
  outbox_publisher_error: ['error_code'],
  attempt_reconciler_started: [],
  attempt_reconciler_error: ['error_code'],
});

const safeValue = value => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return undefined;
  return /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : undefined;
};

export const safeWorkerErrorCode = error => {
  const candidate = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'INTERNAL_ERROR';
};

export function workerOperationalLog(level, event, fields = {}) {
  const allowed = EVENT_FIELDS[event];
  if (!allowed) return;
  const safe = {};
  for (const key of allowed) {
    const value = safeValue(fields[key]);
    if (value !== undefined) safe[key] = value;
  }
  const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(' ');
  const line = `[${new Date().toISOString()}] level=${level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'} event=${event}${suffix ? ` ${suffix}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
