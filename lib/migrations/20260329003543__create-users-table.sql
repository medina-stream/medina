CREATE TABLE assets (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    materialized_at TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'
  );
  CREATE INDEX idx_assets_state ON assets(state);
  CREATE INDEX idx_assets_source ON assets(source);

  CREATE TABLE sensors (
    name TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_run_status TEXT,
    last_error TEXT,
    cursor TEXT,
    runs_requested INTEGER DEFAULT 0
  );

  CREATE TABLE ingest_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    ingest_key TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  );
  CREATE INDEX idx_ingest_fingerprints_ingest_key
    ON ingest_fingerprints(ingest_key);

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    duration TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    data TEXT NOT NULL DEFAULT '{}',
    ingest_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT
  );
  CREATE INDEX idx_notes_at ON notes(at DESC);
  CREATE INDEX idx_notes_type ON notes(type);
  CREATE INDEX idx_notes_source ON notes(source);

  CREATE TABLE note_segments (
    note_id TEXT NOT NULL,
    segment_key TEXT NOT NULL,
    PRIMARY KEY (note_id, segment_key)
  );
  CREATE INDEX idx_note_segments_segment_key ON note_segments(segment_key);
