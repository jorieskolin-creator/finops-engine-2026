BEGIN;
CREATE TABLE IF NOT EXISTS governed_packet_bodies (
  packet_id uuid PRIMARY KEY REFERENCES governed_packet_metadata(packet_id) ON DELETE CASCADE,
  canonical_body bytea NOT NULL,
  byte_count integer NOT NULL CHECK (byte_count > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (byte_count = octet_length(canonical_body)),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS governed_packet_bodies_expiry_idx ON governed_packet_bodies(expires_at);
INSERT INTO schema_versions(version) VALUES (8) ON CONFLICT DO NOTHING;
COMMIT;
