BEGIN;
ALTER TABLE run_shadow_telemetry
  DROP CONSTRAINT IF EXISTS run_shadow_telemetry_analyzer_version_check;
ALTER TABLE run_shadow_telemetry
  ADD CONSTRAINT run_shadow_telemetry_analyzer_version_check
  CHECK (analyzer_version IN ('tagging_allocation_v1@1.0.0', 'tagging_allocation_v1@1.2.0', 'tagging_allocation_v1@1.3.0'));
INSERT INTO schema_versions(version) VALUES (6) ON CONFLICT DO NOTHING;
COMMIT;
