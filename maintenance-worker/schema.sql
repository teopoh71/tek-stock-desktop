CREATE TABLE IF NOT EXISTS diagnostic_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  app_version TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS diagnostic_received_at ON diagnostic_events(received_at);
