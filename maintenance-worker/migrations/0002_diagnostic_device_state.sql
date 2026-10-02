ALTER TABLE diagnostic_events ADD COLUMN device_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE diagnostic_events ADD COLUMN authority_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE diagnostic_events ADD COLUMN ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE diagnostic_events ADD COLUMN recovered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE diagnostic_events ADD COLUMN revision INTEGER;
ALTER TABLE diagnostic_events ADD COLUMN pending_count INTEGER;
ALTER TABLE diagnostic_events ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS diagnostic_device_stage_received_at ON diagnostic_events(device_id, stage, received_at);
