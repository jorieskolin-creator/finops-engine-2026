BEGIN;
CREATE TABLE IF NOT EXISTS run_quality_snapshots (
  run_id uuid PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  schema_version text NOT NULL,
  formula_version text NOT NULL,
  extraction_completeness smallint NOT NULL CHECK (extraction_completeness BETWEEN 0 AND 100),
  evidence_coverage smallint NOT NULL CHECK (evidence_coverage BETWEEN 0 AND 100),
  evidence_density smallint NOT NULL CHECK (evidence_density BETWEEN 0 AND 100),
  provenance_integrity smallint NOT NULL CHECK (provenance_integrity BETWEEN 0 AND 100),
  kb_completeness smallint NOT NULL CHECK (kb_completeness BETWEEN 0 AND 100),
  evidence_packet_status text NOT NULL CHECK (evidence_packet_status IN ('READY','NOT_READY')),
  knowledge_packet_status text NOT NULL CHECK (knowledge_packet_status IN ('READY','NOT_READY')),
  acquisition_status text NOT NULL CHECK (acquisition_status IN ('READY','NOT_READY')),
  security_status text NOT NULL CHECK (security_status IN ('PASS','WARN','BLOCK')),
  extraction_incomplete_count integer NOT NULL CHECK (extraction_incomplete_count >= 0),
  weak_source_packet_count integer NOT NULL CHECK (weak_source_packet_count >= 0),
  kb_blocking_count integer NOT NULL CHECK (kb_blocking_count >= 0),
  unresolved_provenance_count integer NOT NULL CHECK (unresolved_provenance_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days')
);
COMMIT;
