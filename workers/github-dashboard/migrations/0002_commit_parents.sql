CREATE TABLE IF NOT EXISTS commit_parents (
  child_sha  TEXT NOT NULL,
  parent_sha TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (child_sha, parent_sha)
);
CREATE INDEX IF NOT EXISTS idx_commit_parents_child ON commit_parents(child_sha);
CREATE INDEX IF NOT EXISTS idx_commit_parents_parent ON commit_parents(parent_sha);

CREATE INDEX IF NOT EXISTS idx_prs_head_ref ON prs(head_ref);
CREATE INDEX IF NOT EXISTS idx_prs_base_ref ON prs(base_ref);
