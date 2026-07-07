ALTER TABLE branches ADD COLUMN last_seen_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_branches_last_seen ON branches(last_seen_at);
