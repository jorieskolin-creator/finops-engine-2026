BEGIN;
CREATE TABLE IF NOT EXISTS stage_executions (
  stage_execution_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  stage text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','succeeded')),
  accepted_attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  metadata_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '90 days')
);
ALTER TABLE model_attempts ADD COLUMN IF NOT EXISTS stage_execution_id uuid;
ALTER TABLE model_attempts ADD COLUMN IF NOT EXISTS attempt_order integer;
INSERT INTO stage_executions(stage_execution_id,run_id,stage,state,accepted_attempt_id,created_at,completed_at)
SELECT attempt_id,run_id,stage,CASE WHEN state='succeeded' THEN 'succeeded' ELSE 'active' END,
  CASE WHEN state='succeeded' THEN attempt_id END,created_at,CASE WHEN state='succeeded' THEN updated_at END
FROM model_attempts
ON CONFLICT(stage_execution_id) DO NOTHING;
UPDATE model_attempts SET stage_execution_id=attempt_id WHERE stage_execution_id IS NULL;
UPDATE model_attempts SET attempt_order=1 WHERE attempt_order IS NULL;
ALTER TABLE model_attempts ADD CONSTRAINT model_attempts_stage_execution_fk
  FOREIGN KEY(stage_execution_id) REFERENCES stage_executions(stage_execution_id) ON DELETE CASCADE;
ALTER TABLE model_attempts ADD CONSTRAINT model_attempts_attempt_order_check CHECK (attempt_order > 0);
CREATE UNIQUE INDEX IF NOT EXISTS model_attempts_stage_order_idx ON model_attempts(stage_execution_id,attempt_order);
ALTER TABLE stage_executions ADD CONSTRAINT stage_executions_accepted_attempt_fk
  FOREIGN KEY(accepted_attempt_id) REFERENCES model_attempts(attempt_id) ON DELETE SET NULL;

ALTER TABLE checkpoint_metadata ADD COLUMN IF NOT EXISTS predecessor_checkpoint_id uuid REFERENCES checkpoint_metadata(checkpoint_id);
ALTER TABLE checkpoint_metadata ADD COLUMN IF NOT EXISTS input_revision integer CHECK (input_revision IS NULL OR input_revision > 0);
ALTER TABLE checkpoint_metadata ADD COLUMN IF NOT EXISTS input_hash char(64) CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE checkpoint_metadata ADD COLUMN IF NOT EXISTS producing_stage_execution_id uuid REFERENCES stage_executions(stage_execution_id);

INSERT INTO schema_versions(version) VALUES (7) ON CONFLICT DO NOTHING;
COMMIT;
