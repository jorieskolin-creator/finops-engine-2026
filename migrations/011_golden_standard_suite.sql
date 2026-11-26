BEGIN;
CREATE TABLE golden_standard_suites (
  suite_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'cancelled')),
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX golden_standard_one_active_suite
  ON golden_standard_suites (state) WHERE state = 'running';
CREATE INDEX golden_standard_recent_suites ON golden_standard_suites (created_at DESC);

CREATE TABLE golden_standard_attempts (
  suite_id uuid NOT NULL REFERENCES golden_standard_suites(suite_id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 14),
  case_id text NOT NULL,
  repetition integer NOT NULL CHECK (repetition BETWEEN 1 AND 3),
  run_id uuid UNIQUE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'delivered', 'incomplete')),
  started_at timestamptz,
  finished_at timestamptz,
  comparison jsonb,
  review jsonb,
  PRIMARY KEY (suite_id, ordinal)
);
INSERT INTO schema_versions(version) VALUES (11);
COMMIT;
