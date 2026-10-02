CREATE TABLE IF NOT EXISTS diagnostic_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'legacy',
  authority_id TEXT NOT NULL DEFAULT 'unknown',
  ok INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  revision INTEGER,
  pending_count INTEGER,
  event_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS diagnostic_received_at ON diagnostic_events(received_at);
CREATE INDEX IF NOT EXISTS diagnostic_device_stage_received_at ON diagnostic_events(device_id, stage, received_at);
