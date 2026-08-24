BEGIN;
ALTER TABLE run_shadow_telemetry
  DROP CONSTRAINT IF EXISTS run_shadow_telemetry_scale_registry_version_check;
ALTER TABLE run_shadow_telemetry
  ADD CONSTRAINT run_shadow_telemetry_scale_registry_version_check
  CHECK (scale_registry_version IN ('data_signal_registry_v1', 'data_signal_registry_v2'));
INSERT INTO schema_versions(version) VALUES (9) ON CONFLICT DO NOTHING;
COMMIT;
