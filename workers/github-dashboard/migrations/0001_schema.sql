CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  name           TEXT PRIMARY KEY,
  head_sha       TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  last_commit_at INTEGER,
  first_seen_at  INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_branches_last_commit ON branches(last_commit_at DESC);
CREATE INDEX IF NOT EXISTS idx_branches_deleted ON branches(deleted_at);

CREATE TABLE IF NOT EXISTS commits (
  sha           TEXT PRIMARY KEY,
  short_sha     TEXT NOT NULL,
  author_name   TEXT,
  author_email  TEXT,
  authored_at   INTEGER,
  committed_at  INTEGER,
  summary       TEXT,
  message       TEXT,
  url           TEXT
);
CREATE INDEX IF NOT EXISTS idx_commits_committed ON commits(committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_short ON commits(short_sha);

CREATE TABLE IF NOT EXISTS prs (
  number            INTEGER PRIMARY KEY,
  title             TEXT,
  state             TEXT,
  author            TEXT,
  base_ref          TEXT,
  head_ref          TEXT,
  head_sha          TEXT,
  merge_commit_sha  TEXT,
  created_at        INTEGER,
  updated_at        INTEGER,
  merged_at         INTEGER,
  closed_at         INTEGER,
  url               TEXT,
  draft             INTEGER NOT NULL DEFAULT 0,
  body              TEXT
);
CREATE INDEX IF NOT EXISTS idx_prs_updated ON prs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prs_state ON prs(state);
CREATE INDEX IF NOT EXISTS idx_prs_merge_sha ON prs(merge_commit_sha);
CREATE INDEX IF NOT EXISTS idx_prs_head_sha ON prs(head_sha);

CREATE TABLE IF NOT EXISTS tags (
  name           TEXT PRIMARY KEY,
  target_sha     TEXT NOT NULL,
  is_annotated   INTEGER NOT NULL DEFAULT 0,
  tagged_at      INTEGER,
  message        TEXT,
  first_seen_at  INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tags_tagged ON tags(tagged_at DESC);
CREATE INDEX IF NOT EXISTS idx_tags_target ON tags(target_sha);
CREATE INDEX IF NOT EXISTS idx_tags_deleted ON tags(deleted_at);
