-- migration
CREATE TABLE events (
    key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT DEFAULT '{}'
  );
  CREATE INDEX idx_events_created_at ON events(created_at);
