-- Drop the commit parent DAG. It backed "commits reachable from a ref" walks for
-- the Commits tab and branch pages, but for a large monorepo the edge table + its
-- indexes were ~100 MB and pushed the database past D1's 500 MB free-plan cap.
--
-- Replacement (handled at runtime by ensureSchemaUpgrades, so it is not repeated
-- here): commits gain an `on_default` flag (+ a partial index) for the default-
-- branch-scoped Commits tab, and non-default branch pages fetch their commit
-- lists live from the GitHub API instead of walking stored parent edges.
DROP TABLE IF EXISTS commit_parents;
