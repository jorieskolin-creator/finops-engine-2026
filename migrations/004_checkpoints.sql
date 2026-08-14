BEGIN;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_state_check;
ALTER TABLE runs ADD CONSTRAINT runs_state_check CHECK (state IN ('active','recovery_required','ready_for_delivery','completed','failed','deletion_requested','deleted','expired'));
CREATE TABLE IF NOT EXISTS checkpoint_metadata (
  checkpoint_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('acquisition','phase1','phase2','synthesis','fact_check','quality_gate','final_report')),
  scope text NOT NULL CHECK (scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  revision integer NOT NULL CHECK (revision > 0),
  schema_version text NOT NULL CHECK (schema_version = 'checkpoint_v1'),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  char_count integer NOT NULL CHECK (char_count > 0 AND char_count <= 1572864),
  parent_hash char(64) CHECK (parent_hash IS NULL OR parent_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available','deleted','expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days'),
  UNIQUE (run_id,kind,scope,revision),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS checkpoint_manifest_idx ON checkpoint_metadata(run_id,kind,scope,revision);
INSERT INTO schema_versions(version) VALUES (4) ON CONFLICT DO NOTHING;
COMMIT;
