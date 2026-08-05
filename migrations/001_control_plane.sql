BEGIN;
CREATE TABLE IF NOT EXISTS schema_versions (
  version integer PRIMARY KEY CHECK (version > 0), applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS runs (
  run_id uuid PRIMARY KEY, state text NOT NULL CHECK (state IN ('active','completed','failed','deletion_requested','deleted','expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  absolute_deadline_at timestamptz NOT NULL, effective_expires_at timestamptz NOT NULL, terminal_at timestamptz,
  cleanup_status text CHECK (cleanup_status IS NULL OR cleanup_status IN ('pending','in_progress','verified','retryable_failure')), metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days'),
  failure_code text, CHECK (absolute_deadline_at > created_at), CHECK (effective_expires_at <= absolute_deadline_at)
);
CREATE TABLE IF NOT EXISTS governed_packet_metadata (
  packet_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(run_id), packet_hash char(64) NOT NULL,
  schema_version text NOT NULL, policy_version text NOT NULL, classification_code text NOT NULL,
  provider text NOT NULL, model text NOT NULL, stage text NOT NULL,
  state text NOT NULL CHECK (state IN ('staged','approved','claimed','completed','failed','deleted','expired')),
  part_count integer NOT NULL CHECK (part_count >= 0), char_count integer NOT NULL CHECK (char_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, claimed_at timestamptz, metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days'),
  CHECK (expires_at > created_at)
);
CREATE TABLE IF NOT EXISTS model_attempts (
  attempt_id uuid PRIMARY KEY, internal_call_id uuid NOT NULL UNIQUE, run_id uuid NOT NULL REFERENCES runs(run_id),
  packet_id uuid NOT NULL UNIQUE REFERENCES governed_packet_metadata(packet_id), packet_hash char(64) NOT NULL, provider text NOT NULL, model text NOT NULL, stage text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','dispatch_intent','send_authorized','succeeded','fallback_allowed','outcome_unknown','cancelled','result_unavailable')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0), output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  outcome_code text, lease_owner uuid, lease_token bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  send_authorized_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days')
);
CREATE TABLE IF NOT EXISTS dispatch_outbox (
  outbox_id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE REFERENCES model_attempts(attempt_id),
  run_id uuid NOT NULL REFERENCES runs(run_id), state text NOT NULL CHECK (state IN ('pending','publishing','published')),
  publish_owner uuid, publish_lease_until timestamptz, publish_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz, metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days')
);
CREATE INDEX IF NOT EXISTS dispatch_outbox_pending_idx ON dispatch_outbox(created_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS cleanup_attempts (
  cleanup_attempt_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(run_id),
  status text NOT NULL CHECK (status IN ('pending','in_progress','verified','retryable_failure')),
  evidence_code text, key_count integer CHECK (key_count IS NULL OR key_count >= 0),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(), verified_at timestamptz, metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days'),
  UNIQUE (run_id, attempted_at)
);
INSERT INTO schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
