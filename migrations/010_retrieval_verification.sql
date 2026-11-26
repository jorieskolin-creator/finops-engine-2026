BEGIN;
ALTER TABLE runs ADD COLUMN retrieval_opening_id uuid UNIQUE;
CREATE INDEX model_attempts_run_idx ON model_attempts(run_id);
INSERT INTO schema_versions(version) VALUES (10);
COMMIT;
