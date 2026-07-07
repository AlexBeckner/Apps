-- Restore the commit parent DAG to answer "branches containing this commit"
-- (git branch --contains) with a single recursive walk instead of one live
-- GitHub compare call per branch (which capped coverage at ~45 of ~35k branches).
--
-- Leaner than the original 0002 table: WITHOUT ROWID clusters the row on the
-- (child_sha, parent_sha) primary key, and we keep only the reverse index on
-- parent_sha (the child lookup is served by the PK prefix). That roughly halves
-- the on-disk footprint vs. the old rowid table + child index + parent index.
--
-- Populated by the commit ingest workflow (git log --all %P); the Worker reads it
-- only after a full ingest sets meta.commit_parents_full_at (until then it falls
-- back to the live GitHub compare probe).
CREATE TABLE IF NOT EXISTS commit_parents (
  child_sha  TEXT NOT NULL,
  parent_sha TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (child_sha, parent_sha)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_commit_parents_parent ON commit_parents(parent_sha);
