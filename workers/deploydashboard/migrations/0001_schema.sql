CREATE TABLE IF NOT EXISTS builds (
  source TEXT NOT NULL,
  build_number INTEGER NOT NULL,
  rig TEXT,
  state TEXT,
  created_at TEXT,
  last_event_at TEXT,
  raw_json TEXT NOT NULL,
  stored_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (source, build_number)
);

CREATE INDEX IF NOT EXISTS idx_builds_source_rig_last_event
  ON builds(source, rig, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_builds_source_last_event
  ON builds(source, last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_builds_source_state_last_event
  ON builds(source, state, last_event_at DESC);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
