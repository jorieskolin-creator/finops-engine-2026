BEGIN;
ALTER TABLE golden_standard_attempts
  ADD COLUMN IF NOT EXISTS summary jsonb,
  ADD COLUMN IF NOT EXISTS failure jsonb;
INSERT INTO schema_versions(version) VALUES (12);
COMMIT;
