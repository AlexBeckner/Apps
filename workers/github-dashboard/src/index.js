import { companyAuthResponse } from "./company-auth.js";
import { dashboardHtml, isDashboardRoute } from "./ui.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const DEFAULT_REPO = "AppliedNeuron/core-stack";
const GITHUB_PAGE_SIZE = 100;
const MAX_LIST_LIMIT = 500;
const SCHEMA_UPGRADE_VERSION = "commits-on-default-2026-07-01";

// All syncing is owned by git-based GitHub Actions (branches; commits+tags; PRs).
// The Worker no longer syncs anything itself: it serves the dashboard from D1 and
// lazily reads a few things from GitHub at request time (PR bodies, commit
// messages, live per-branch commit lists). "Sync now" dispatches these three
// workflows via the GitHub API; each also runs hourly on its own cron.
const DEFAULT_ACTIONS_REPO = "AlexBeckner/Apps";
const SYNC_WORKFLOWS = ["sync-branches.yml", "sync-commits.yml", "sync-prs.yml"];
// Where each workflow's ingest script records its last successful run. Status is
// derived from these timestamps, so no GitHub API call is needed to render it.
const SYNC_SOURCES = [
  { key: "branches", label: "Branches", metaKey: "branch_external_synced_at" },
  { key: "commits", label: "Commits", metaKey: "commit_git_synced_at" },
  { key: "prs", label: "PRs", metaKey: "pr_git_synced_at" },
  { key: "tags", label: "Tags", metaKey: "tag_git_synced_at" },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  name           TEXT PRIMARY KEY,
  head_sha       TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  last_commit_at INTEGER,
  last_seen_at   INTEGER,
  first_seen_at  INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_branches_last_commit ON branches(last_commit_at DESC);
CREATE INDEX IF NOT EXISTS idx_branches_deleted ON branches(deleted_at);
CREATE INDEX IF NOT EXISTS idx_branches_last_seen ON branches(last_seen_at);
CREATE TABLE IF NOT EXISTS commits (
  sha           TEXT PRIMARY KEY,
  short_sha     TEXT NOT NULL,
  author_name   TEXT,
  author_email  TEXT,
  authored_at   INTEGER,
  committed_at  INTEGER,
  summary       TEXT,
  message       TEXT,
  url           TEXT,
  on_default    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_commits_committed ON commits(committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_short ON commits(short_sha);
CREATE INDEX IF NOT EXISTS idx_commits_default ON commits(committed_at DESC) WHERE on_default = 1;
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
CREATE INDEX IF NOT EXISTS idx_prs_head_ref ON prs(head_ref);
CREATE INDEX IF NOT EXISTS idx_prs_base_ref ON prs(base_ref);
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
`;

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, env),
        });
      }

      const originError = validateOrigin(request, env);
      if (originError) {
        return jsonResponse(request, env, { error: originError }, { status: 403 });
      }

      const authResponse = await companyAuthResponse(
        request,
        env,
        "GitHub Dashboard"
      );
      if (authResponse) {
        return authResponse;
      }

      await ensureSchema(env);

      const url = new URL(request.url);

      if (request.method === "GET" && isDashboardRoute(url.pathname)) {
        return htmlResponse(dashboardHtml(env), request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse(request, env, await handleHealth(env));
      }
      if (request.method === "GET" && url.pathname === "/api/summary") {
        return jsonResponse(request, env, await handleSummary(env));
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        return jsonResponse(request, env, await handleSearch(env, url));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/branch-commits/")) {
        const name = decodePathParam(url.pathname, "/api/branch-commits/");
        return jsonResponse(request, env, await handleBranchCommits(env, url, name));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/branch-prs/")) {
        const name = decodePathParam(url.pathname, "/api/branch-prs/");
        return jsonResponse(request, env, await handleBranchPrs(env, url, name));
      }
      if (request.method === "GET" && url.pathname === "/api/branches") {
        return jsonResponse(request, env, await handleBranches(env, url));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/branches/")) {
        const name = decodePathParam(url.pathname, "/api/branches/");
        return jsonResponse(request, env, await handleBranchDetail(env, name));
      }
      if (request.method === "GET" && url.pathname === "/api/commits") {
        return jsonResponse(request, env, await handleCommits(env, url));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/commits/")) {
        const rest = decodePathParam(url.pathname, "/api/commits/");
        if (rest.endsWith("/branches")) {
          const sha = rest.slice(0, -"/branches".length);
          return jsonResponse(request, env, await handleCommitBranches(env, sha));
        }
        return jsonResponse(request, env, await handleCommitDetail(env, rest));
      }
      if (request.method === "GET" && url.pathname === "/api/prs") {
        return jsonResponse(request, env, await handlePrs(env, url));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/prs/")) {
        const rest = decodePathParam(url.pathname, "/api/prs/");
        if (rest.endsWith("/branches")) {
          const number = Number(rest.slice(0, -"/branches".length));
          return jsonResponse(request, env, await handlePrBranches(env, number));
        }
        return jsonResponse(request, env, await handlePrDetail(env, Number(rest)));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/tag-commits/")) {
        const name = decodePathParam(url.pathname, "/api/tag-commits/");
        return jsonResponse(request, env, await handleTagCommits(env, url, name));
      }
      if (request.method === "GET" && url.pathname === "/api/tags") {
        return jsonResponse(request, env, await handleTags(env, url));
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/tags/")) {
        const name = decodePathParam(url.pathname, "/api/tags/");
        return jsonResponse(request, env, await handleTagDetail(env, name));
      }
      if (request.method === "GET" && url.pathname === "/api/sync/status") {
        return jsonResponse(request, env, await syncStatus(env));
      }
      if (request.method === "POST" && url.pathname === "/api/sync") {
        const authError = requireWrite(request, env);
        if (authError) {
          return jsonResponse(request, env, { error: authError }, { status: 403 });
        }
        const status = await dispatchSync(env, "manual");
        return jsonResponse(request, env, status);
      }

      return jsonResponse(request, env, { error: "Not found" }, { status: 404 });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      return jsonResponse(
        request,
        env,
        { error: error.message || "Unexpected error" },
        { status }
      );
    }
  },
};

async function ensureSchema(env) {
  if (!env.DB) throw httpError(500, "D1 binding DB is not configured.");
  const metaTable = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
  ).first();
  if (!metaTable) {
    throw httpError(
      500,
      "D1 schema is not initialized. Run `npm run migrate:remote` before deploying."
    );
  }

  if ((await getMeta(env, "schema_upgrade_version")) !== SCHEMA_UPGRADE_VERSION) {
    await ensureSchemaUpgrades(env);
    await setMeta(env, "schema_upgrade_version", SCHEMA_UPGRADE_VERSION);
  }
  if ((await getMeta(env, "schema_initialized")) !== "1") {
    await setMeta(env, "schema_initialized", "1");
  }
}

async function ensureSchemaUpgrades(env) {
  await ensureColumn(env, "branches", "last_seen_at", "INTEGER");
  // on_default marks commits reachable from the default branch. It replaces the
  // old commit_parents DAG (dropped to fit D1's 500 MB free-plan cap): the global
  // Commits tab / summary filter on it instead of walking parent edges.
  await ensureColumn(env, "commits", "on_default", "INTEGER NOT NULL DEFAULT 0");
  const statements = [
    "CREATE INDEX IF NOT EXISTS idx_commits_default ON commits(committed_at DESC) WHERE on_default = 1",
    "CREATE INDEX IF NOT EXISTS idx_prs_head_ref ON prs(head_ref)",
    "CREATE INDEX IF NOT EXISTS idx_prs_base_ref ON prs(base_ref)",
    "CREATE INDEX IF NOT EXISTS idx_branches_last_seen ON branches(last_seen_at)",
  ];
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

// SQLite has no "ADD COLUMN IF NOT EXISTS", so probe the table first.
async function ensureColumn(env, table, column, ddl) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const exists = (info.results || []).some((col) => col.name === column);
  if (!exists) {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}

async function handleHealth(env) {
  const [owner, repo] = repoParts(env);
  return {
    status: "ok",
    repo: `${owner}/${repo}`,
    repoUrl: (await getMeta(env, "repo_url")) || `https://github.com/${owner}/${repo}`,
    tokenSet: !!env.GITHUB_TOKEN,
    db: "cloudflare-d1",
    sync: await syncStatus(env),
  };
}

async function handleSummary(env) {
  const [owner, repo] = repoParts(env);
  const counts = await Promise.all([
    scalar(env, "SELECT COUNT(*) AS c FROM branches"),
    scalar(env, "SELECT COUNT(*) AS c FROM branches WHERE deleted_at IS NULL"),
    countDefaultBranchCommits(env),
    scalar(env, "SELECT COUNT(*) AS c FROM tags"),
    scalar(env, "SELECT COUNT(*) AS c FROM tags WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT state, COUNT(*) AS c FROM prs GROUP BY state").all(),
  ]);

  const prCount = { open: 0, closed: 0, merged: 0, total: 0 };
  for (const row of counts[5].results || []) {
    if (row.state === "open") prCount.open = row.c;
    else if (row.state === "merged") prCount.merged = row.c;
    else if (row.state === "closed") prCount.closed = row.c;
    prCount.total += row.c;
  }

  // commitCount tracks the default branch (matches the Commits tab);
  // allBranchCommitCount is every commit across all branches, sourced from the
  // git ingest (falls back to the raw table count until that meta exists).
  const allBranchMeta = await getMeta(env, "commit_total_count");
  const allBranchCommitCount = allBranchMeta
    ? Number.parseInt(allBranchMeta, 10)
    : await scalar(env, "SELECT COUNT(*) AS c FROM commits");

  return {
    repo: `${owner}/${repo}`,
    repoUrl: (await getMeta(env, "repo_url")) || `https://github.com/${owner}/${repo}`,
    cloned: true,
    tokenSet: !!env.GITHUB_TOKEN,
    lastSyncAt: unixOrNull(await getMeta(env, "last_sync_at")),
    defaultBranch: await getMeta(env, "default_branch"),
    branchCount: counts[0],
    liveBranchCount: counts[1],
    commitCount: counts[2],
    allBranchCommitCount,
    tagCount: counts[3],
    liveTagCount: counts[4],
    prCount,
    recentBranches: await listBranches(env, { limit: 12, offset: 0, includeDeleted: false, sort: "last_commit_at" }),
    recentCommits: await listCommits(env, { limit: 12, offset: 0 }),
    recentPrs: await listPrs(env, { limit: 12, offset: 0, state: "all" }),
    recentTags: await listTags(env, { limit: 12, offset: 0, includeDeleted: false }),
  };
}

async function handleSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  const limit = normalizedLimit(url.searchParams.get("limit"), 25);
  if (!q) return { query: q, branches: [], commits: [], prs: [], tags: [] };

  const like = likeParam(q);
  const branchRows = await env.DB.prepare(
    `SELECT * FROM branches
     WHERE name LIKE ? ESCAPE '\\'
     ORDER BY deleted_at IS NULL DESC, COALESCE(last_commit_at, 0) DESC, name ASC
     LIMIT ?`
  )
    .bind(like, limit)
    .all();

  const commits = isShaPrefix(q)
    ? await env.DB.prepare(
        `SELECT * FROM commits
         WHERE sha LIKE ? OR short_sha LIKE ?
         ORDER BY committed_at DESC
         LIMIT ?`
      )
        .bind(`${q.toLowerCase()}%`, `${q.toLowerCase()}%`, limit)
        .all()
    : await env.DB.prepare(
        `SELECT * FROM commits
         WHERE summary LIKE ? ESCAPE '\\'
            OR message LIKE ? ESCAPE '\\'
            OR author_name LIKE ? ESCAPE '\\'
         ORDER BY committed_at DESC
         LIMIT ?`
      )
        .bind(like, like, like, limit)
        .all();

  const prRows = prNumber(q)
    ? await env.DB.prepare("SELECT * FROM prs WHERE number = ?")
        .bind(prNumber(q))
        .all()
    : await env.DB.prepare(
        `SELECT * FROM prs
         WHERE title LIKE ? ESCAPE '\\'
            OR body LIKE ? ESCAPE '\\'
            OR author LIKE ? ESCAPE '\\'
            OR head_ref LIKE ? ESCAPE '\\'
            OR base_ref LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
        .bind(like, like, like, like, like, limit)
        .all();

  const tagRows = await env.DB.prepare(
    `SELECT * FROM tags
     WHERE name LIKE ? ESCAPE '\\'
        OR message LIKE ? ESCAPE '\\'
     ORDER BY deleted_at IS NULL DESC, COALESCE(tagged_at, 0) DESC, name ASC
     LIMIT ?`
  )
    .bind(like, like, limit)
    .all();

  return {
    query: q,
    branches: (branchRows.results || []).map(toBranch),
    commits: (commits.results || []).map(toCommit),
    prs: (prRows.results || []).map(toPr),
    tags: (tagRows.results || []).map(toTag),
  };
}

async function handleBranchDetail(env, name) {
  const row = await env.DB.prepare("SELECT * FROM branches WHERE name = ?")
    .bind(name)
    .first();
  if (!row) throw httpError(404, "Branch not found");

  const commitCount = await countBranchCommits(env, row, "");
  const directionCounts = await Promise.all([
    scalar(env, "SELECT COUNT(*) AS c FROM prs WHERE head_ref = ?", name),
    scalar(env, "SELECT COUNT(*) AS c FROM prs WHERE base_ref = ?", name),
  ]);

  return {
    branch: toBranch(row),
    branchedFrom: null,
    defaultBranch: await getMeta(env, "default_branch"),
    totalCommits: commitCount,
    walkError: null,
    prsFromBranchCount: directionCounts[0],
    prsToBranchCount: directionCounts[1],
  };
}

async function handleBranchCommits(env, url, name) {
  const branch = await env.DB.prepare("SELECT * FROM branches WHERE name = ?")
    .bind(name)
    .first();
  if (!branch) throw httpError(404, "Branch not found");

  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const offset = normalizedOffset(url.searchParams.get("offset"));
  const limit = normalizedLimit(url.searchParams.get("limit"), 100);
  const result = await listBranchCommits(env, branch, { q, limit, offset });

  return {
    total: result.total,
    offset,
    limit,
    q,
    source: result.source,
    walkError: result.error || null,
    commits: result.commits,
  };
}

async function countBranchCommits(env, branch, q) {
  const result = await listBranchCommits(env, branch, {
    q,
    limit: 1,
    offset: 0,
    countOnly: true,
  });
  return result.total;
}

async function listBranchCommits(env, branch, opts) {
  const q = (opts.q || "").trim().toLowerCase();
  const limit = normalizedLimit(opts.limit, 100);
  const offset = normalizedOffset(opts.offset);
  const defaultBranch = await getMeta(env, "default_branch");

  // The default branch's full history lives in D1 (on_default = 1). Every other
  // branch is fetched live from GitHub: D1 stores off-branch commit metadata but
  // no branch-membership mapping (the commit_parents DAG that used to answer
  // "which commits are on this branch" was dropped to fit the 500 MB free cap).
  if (defaultBranch && branch.name === defaultBranch) {
    const like = q ? likeParam(q) : null;
    const cond = q
      ? `on_default = 1 AND (LOWER(sha) LIKE ? ESCAPE '\\'
           OR LOWER(short_sha) LIKE ? ESCAPE '\\'
           OR LOWER(COALESCE(summary, '')) LIKE ? ESCAPE '\\'
           OR LOWER(COALESCE(author_name, '')) LIKE ? ESCAPE '\\')`
      : "on_default = 1";
    const binds = q ? [like, like, like, like] : [];
    const total = await scalar(
      env,
      `SELECT COUNT(*) AS c FROM commits WHERE ${cond}`,
      ...binds
    );
    if (opts.countOnly) return { total, source: "sql", commits: [] };
    const rows = await env.DB.prepare(
      `SELECT * FROM commits WHERE ${cond} ORDER BY committed_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, offset)
      .all();
    return { total, source: "sql", commits: (rows.results || []).map(toCommit) };
  }

  return await listRefCommitsFromGitHub(env, branch.name, {
    q,
    limit,
    offset,
    countOnly: opts.countOnly,
  });
}

// Commit listings for an arbitrary ref (a branch name, or a tag's target SHA)
// come straight from GitHub. One request yields the exact total (via the Link
// header) and one or two more cover the requested window. Human browsing is
// low-volume, so this stays well within the authenticated 5k req/hour budget.
async function listRefCommitsFromGitHub(env, ref, opts) {
  const q = (opts.q || "").trim().toLowerCase();
  const limit = normalizedLimit(opts.limit, 100);
  const offset = normalizedOffset(opts.offset);
  const [owner, repo] = repoParts(env);

  let total = 0;
  try {
    total = await githubRefCommitCount(env, owner, repo, ref);
  } catch {
    total = 0;
  }
  if (opts.countOnly) return { total, source: "github", commits: [] };

  const commits = [];
  const within = offset % GITHUB_PAGE_SIZE;
  try {
    const startPage = Math.floor(offset / GITHUB_PAGE_SIZE) + 1;
    const pagesNeeded = Math.ceil((within + limit) / GITHUB_PAGE_SIZE);
    for (let i = 0; i < pagesNeeded; i++) {
      const items = await githubJson(env, `/repos/${owner}/${repo}/commits`, {
        sha: ref,
        per_page: String(GITHUB_PAGE_SIZE),
        page: String(startPage + i),
      });
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        const row = githubCommitToRow(item);
        if (row) commits.push(row);
      }
      if (items.length < GITHUB_PAGE_SIZE) break;
    }
    let windowed = commits.slice(within, within + limit);
    // GitHub's commits API has no text search, so per-branch q is a best-effort
    // filter over the fetched window (the global Search tab covers all commits).
    if (q) windowed = windowed.filter((row) => matchesCommitQuery(row, q));
    return { total, source: "github", commits: windowed.map(toCommit) };
  } catch (error) {
    return { total, source: "github", commits: [], error: error.message };
  }
}

// Total commits reachable from a ref via the commits API Link header
// (per_page=1 => the "last" page number equals the commit count).
async function githubRefCommitCount(env, owner, repo, ref) {
  const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/commits`);
  url.searchParams.set("sha", ref);
  url.searchParams.set("per_page", "1");
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "github-dashboard-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw httpError(response.status, `${response.status} ${response.statusText}`);
  }
  const link = response.headers.get("link") || "";
  const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (match) return Number.parseInt(match[1], 10);
  const items = await response.json();
  return Array.isArray(items) ? items.length : 0;
}

// Shape a GitHub commits-API item into the row form our D1 mappers expect.
function githubCommitToRow(item) {
  const commit = item?.commit;
  if (!item?.sha || !commit) return null;
  const message = commit.message || "";
  return {
    sha: item.sha,
    short_sha: item.sha.slice(0, 7),
    author_name: commit.author?.name || item.author?.login || null,
    author_email: commit.author?.email || null,
    authored_at: toUnix(commit.author?.date),
    committed_at: toUnix(commit.committer?.date || commit.author?.date),
    summary: message.split("\n")[0] || null,
    message,
    url: item.html_url || null,
  };
}

// Compare status for base...head. With base = branch and head = commit, the
// commit is contained in the branch when the status is "behind" or "identical"
// (i.e. the commit is an ancestor of, or equal to, the branch head). per_page=1
// keeps the payload small since we only read the status field.
async function githubCompareStatus(env, base, head) {
  const [owner, repo] = repoParts(env);
  const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const data = await githubJson(
    env,
    `/repos/${owner}/${repo}/compare/${basehead}`,
    { per_page: "1" }
  );
  return data && typeof data.status === "string" ? data.status : null;
}

// Run an async mapper over items with a bounded number of in-flight tasks so a
// commit sitting on dozens of branches does not fan out into an unbounded burst
// of GitHub subrequests. Results preserve input order.
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) break;
          results[index] = await mapper(items[index], index);
        }
      })()
    );
  }
  await Promise.all(workers);
  return results;
}

async function handleBranchPrs(env, url, name) {
  const direction = url.searchParams.get("direction") === "to" ? "to" : "from";
  const column = direction === "to" ? "base_ref" : "head_ref";
  const q = (url.searchParams.get("q") || "").trim();
  const offset = normalizedOffset(url.searchParams.get("offset"));
  const limit = normalizedLimit(url.searchParams.get("limit"), 100);
  const bindings = [name];
  let filterSql = "";

  if (q) {
    const like = likeParam(q.toLowerCase());
    const numericLike = likeParam(q.replace(/^#/, ""));
    filterSql =
      ` AND (
          CAST(number AS TEXT) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(author, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(head_ref, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(base_ref, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(state, '')) LIKE ? ESCAPE '\\'
        )`;
    bindings.push(numericLike, like, like, like, like, like);
  }

  const total = await scalar(
    env,
    `SELECT COUNT(*) AS c FROM prs WHERE ${column} = ?${filterSql}`,
    ...bindings
  );
  const rows = await env.DB.prepare(
    `SELECT * FROM prs WHERE ${column} = ?${filterSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all();

  return {
    total,
    offset,
    limit,
    direction,
    q,
    prs: (rows.results || []).map(toPr),
  };
}

// Commits reachable from a tag, mirroring the per-branch commit list. A tag's
// stored target_sha is the dereferenced commit (annotated tags are peeled at
// ingest), so it plugs straight into the ref-commits GitHub helper.
async function handleTagCommits(env, url, name) {
  const tag = await env.DB.prepare("SELECT * FROM tags WHERE name = ?")
    .bind(name)
    .first();
  if (!tag) throw httpError(404, "Tag not found");

  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const offset = normalizedOffset(url.searchParams.get("offset"));
  const limit = normalizedLimit(url.searchParams.get("limit"), 100);
  const result = await listRefCommitsFromGitHub(env, tag.target_sha, {
    q,
    limit,
    offset,
  });

  return {
    total: result.total,
    offset,
    limit,
    q,
    source: result.source,
    walkError: result.error || null,
    commits: result.commits,
  };
}

async function handleTagDetail(env, name) {
  const row = await env.DB.prepare("SELECT * FROM tags WHERE name = ?")
    .bind(name)
    .first();
  if (!row) throw httpError(404, "Tag not found");

  const target = await getCommitRow(env, row.target_sha);
  return {
    tag: {
      ...toTag(row),
      taggerName: null,
      taggerEmail: null,
    },
    target: target ? toCommit(target) : null,
  };
}

async function handleCommitDetail(env, sha) {
  const row = await getCommitRow(env, sha);
  if (!row) throw httpError(404, "Commit not found");

  // Off-branch commits are ingested from git with metadata only (no message body,
  // to keep D1 lean). Fetch + cache the full message the first time one is opened.
  let message = row.message || "";
  if (!message) {
    const fetched = await fetchCommitMessageFromGitHub(env, row.sha);
    if (fetched && fetched.message) {
      message = fetched.message;
      await env.DB.prepare(
        `UPDATE commits
         SET message = ?,
             author_name = COALESCE(author_name, ?),
             author_email = COALESCE(author_email, ?)
         WHERE sha = ?`
      )
        .bind(message, fetched.authorName, fetched.authorEmail, row.sha)
        .run();
    }
  }
  message = message || row.summary || "";

  const [prRows, tagRows] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM prs
       WHERE merge_commit_sha = ? OR head_sha = ?
       ORDER BY updated_at DESC
       LIMIT 100`
    )
      .bind(row.sha, row.sha)
      .all(),
    env.DB.prepare("SELECT * FROM tags WHERE target_sha = ? ORDER BY COALESCE(tagged_at, 0) DESC, name ASC")
      .bind(row.sha)
      .all(),
  ]);

  return {
    commit: toCommit(row),
    message,
    parents: [],
    prs: (prRows.results || []).map(toPr),
    tagsPointing: (tagRows.results || []).map((tag) => ({
      name: tag.name,
      deletedAt: tag.deleted_at ?? null,
    })),
    // "Branches containing this commit" loads lazily via
    // /api/commits/{sha}/branches (live GitHub compare calls; see
    // handleCommitBranches) so this detail response stays fast.
  };
}

// "Branches containing this commit" (git branch --contains) is answered live:
// D1 has no commit-ancestry DAG (it was dropped to fit the free storage cap).
//   - a branch whose head IS this commit trivially contains it (no API call);
//   - if the commit is on the default branch, the default branch contains it;
//   - otherwise compare base=branch, head=commit -- the commit is contained iff
//     the branch is "behind" or "identical" (the commit is reachable from the
//     branch head).
// Each compare is one GitHub subrequest, so we probe at most
// MAX_CONTAINMENT_CHECKS branches (most-recently-active first) to stay within
// the Worker per-request subrequest budget.
const MAX_CONTAINMENT_CHECKS = 45;
const CONTAINMENT_CONCURRENCY = 6;

async function handleCommitBranches(env, sha) {
  const row = await getCommitRow(env, sha);
  if (!row) throw httpError(404, "Commit not found");

  const branchRows = await env.DB.prepare(
    `SELECT name, head_sha, is_default FROM branches
     WHERE deleted_at IS NULL
     ORDER BY COALESCE(last_commit_at, 0) DESC, name ASC`
  ).all();
  const allBranches = branchRows.results || [];

  const contained = [];
  const toCompare = [];
  for (const branch of allBranches) {
    if (branch.head_sha === row.sha || (row.on_default && branch.is_default)) {
      contained.push(branch.name);
    } else {
      toCompare.push(branch);
    }
  }
  const freeCount = contained.length;

  const probeList = toCompare.slice(0, MAX_CONTAINMENT_CHECKS);
  const truncated = toCompare.length > probeList.length;

  const probeResults = await mapWithConcurrency(
    probeList,
    CONTAINMENT_CONCURRENCY,
    async (branch) => {
      try {
        const status = await githubCompareStatus(env, branch.name, row.sha);
        return status === "behind" || status === "identical" ? branch.name : null;
      } catch {
        // Skip branches we cannot compare (e.g. renamed/removed upstream).
        return null;
      }
    }
  );
  for (const name of probeResults) {
    if (name) contained.push(name);
  }

  contained.sort((a, b) => a.localeCompare(b));

  return {
    sha: row.sha,
    branches: contained,
    totalBranches: allBranches.length,
    evaluatedBranches: freeCount + probeList.length,
    truncated,
    stale: false,
    computedAt: unixNow(),
  };
}

async function handlePrDetail(env, number) {
  if (!Number.isFinite(number)) throw httpError(400, "Invalid PR number");

  const row = await env.DB.prepare("SELECT * FROM prs WHERE number = ?")
    .bind(number)
    .first();
  if (!row) throw httpError(404, "PR not found");

  // PR bodies are not stored in bulk (they dominated D1's size). Fetch + cache the
  // body the first time a PR is opened; storing an empty string keeps us from
  // re-fetching description-less PRs.
  if (row.body == null) {
    const body = await fetchPrBodyFromGitHub(env, number);
    if (body != null) {
      await env.DB.prepare("UPDATE prs SET body = ? WHERE number = ?")
        .bind(body, number)
        .run();
      row.body = body;
    }
  }

  const shas = [...new Set([row.head_sha, row.merge_commit_sha].filter(Boolean))];
  const commits = [];
  for (const sha of shas) {
    const commit = await getCommitRow(env, sha);
    if (commit) commits.push(toCommit(commit));
  }

  return {
    pr: toPrDetail(row),
    commits,
  };
}

async function handlePrBranches(env, number) {
  if (!Number.isFinite(number)) throw httpError(400, "Invalid PR number");

  const row = await env.DB.prepare("SELECT * FROM prs WHERE number = ?")
    .bind(number)
    .first();
  if (!row) throw httpError(404, "PR not found");

  const sha = row.merge_commit_sha || row.head_sha || null;
  if (!sha) {
    return { sha: null, branches: [], stale: false, computedAt: unixNow() };
  }

  const branches = await env.DB.prepare(
    "SELECT name FROM branches WHERE head_sha = ? ORDER BY name ASC"
  )
    .bind(sha)
    .all();

  return {
    sha,
    branches: (branches.results || []).map((branch) => branch.name),
    stale: false,
    computedAt: unixNow(),
  };
}

async function handleBranches(env, url) {
  const includeDeleted = url.searchParams.get("includeDeleted") === "1";
  const total = includeDeleted
    ? await scalar(env, "SELECT COUNT(*) AS c FROM branches")
    : await scalar(env, "SELECT COUNT(*) AS c FROM branches WHERE deleted_at IS NULL");
  return {
    total,
    branches: await listBranches(env, {
      limit: normalizedLimit(url.searchParams.get("limit"), 100),
      offset: normalizedOffset(url.searchParams.get("offset")),
      includeDeleted,
      sort: normalizeBranchSort(url.searchParams.get("sort")),
    }),
  };
}

async function handleCommits(env, url) {
  return {
    total: await countAllCommits(env),
    commits: await listCommits(env, {
      limit: normalizedLimit(url.searchParams.get("limit"), 100),
      offset: normalizedOffset(url.searchParams.get("offset")),
    }),
  };
}

async function handlePrs(env, url) {
  const state = normalizePrState(url.searchParams.get("state"));
  const total =
    state === "all"
      ? await scalar(env, "SELECT COUNT(*) AS c FROM prs")
      : await scalar(env, "SELECT COUNT(*) AS c FROM prs WHERE state = ?", state);
  return {
    total,
    state,
    prs: await listPrs(env, {
      limit: normalizedLimit(url.searchParams.get("limit"), 100),
      offset: normalizedOffset(url.searchParams.get("offset")),
      state,
    }),
  };
}

async function handleTags(env, url) {
  return {
    total: await scalar(env, "SELECT COUNT(*) AS c FROM tags"),
    tags: await listTags(env, {
      limit: normalizedLimit(url.searchParams.get("limit"), 100),
      offset: normalizedOffset(url.searchParams.get("offset")),
      includeDeleted: url.searchParams.get("includeDeleted") === "1",
    }),
  };
}

async function listBranches(env, opts) {
  const limit = normalizedLimit(opts.limit, 100);
  const offset = normalizedOffset(opts.offset);
  const where = opts.includeDeleted ? "" : "WHERE deleted_at IS NULL";
  const order =
    opts.sort === "name"
      ? "name ASC"
      : "COALESCE(last_commit_at, 0) DESC, name ASC";
  const rows = await env.DB.prepare(
    `SELECT * FROM branches ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(limit, offset)
    .all();
  return (rows.results || []).map(toBranch);
}

// Count of commits on the default branch. The git-based commit ingest
// (.github/workflows/sync-commits.yml) writes an authoritative `default_commit_count`
// (git rev-list --count <default>) each run; fall back to the on_default flag,
// which the Worker's own commit sync keeps current for the newest history.
async function countDefaultBranchCommits(env) {
  const meta = await getMeta(env, "default_commit_count");
  const cached = meta ? Number.parseInt(meta, 10) : NaN;
  if (Number.isFinite(cached)) return cached;
  return await scalar(env, "SELECT COUNT(*) AS c FROM commits WHERE on_default = 1");
}

// The global "Commits" tab lists commits from ALL branches (the git ingest fills
// in every non-default-branch commit), ordered by commit date via
// idx_commits_committed. Per-branch history lives on the branch pages; the default
// branch's on_default flag still backs its branch page + the default_commit_count
// stat, but the global list is intentionally the full cross-branch firehose.
async function listCommits(env, opts) {
  const limit = normalizedLimit(opts.limit, 100);
  const offset = normalizedOffset(opts.offset);
  const rows = await env.DB.prepare(
    "SELECT * FROM commits ORDER BY committed_at DESC LIMIT ? OFFSET ?"
  )
    .bind(limit, offset)
    .all();
  return (rows.results || []).map(toCommit);
}

// Every commit across every branch (matches the global Commits list). Prefer the
// cached commit_total_count the git ingest writes; fall back to a live COUNT.
async function countAllCommits(env) {
  const meta = await getMeta(env, "commit_total_count");
  const cached = meta ? Number.parseInt(meta, 10) : NaN;
  if (Number.isFinite(cached)) return cached;
  return await scalar(env, "SELECT COUNT(*) AS c FROM commits");
}

async function listPrs(env, opts) {
  const limit = normalizedLimit(opts.limit, 100);
  const offset = normalizedOffset(opts.offset);
  const state = normalizePrState(opts.state);
  const rows =
    state === "all"
      ? await env.DB.prepare(
          "SELECT * FROM prs ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
          .bind(limit, offset)
          .all()
      : await env.DB.prepare(
          "SELECT * FROM prs WHERE state = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
          .bind(state, limit, offset)
          .all();
  return (rows.results || []).map(toPr);
}

async function listTags(env, opts) {
  const where = opts.includeDeleted ? "" : "WHERE deleted_at IS NULL";
  const rows = await env.DB.prepare(
    `SELECT * FROM tags ${where}
     ORDER BY COALESCE(tagged_at, 0) DESC, name ASC
     LIMIT ? OFFSET ?`
  )
    .bind(normalizedLimit(opts.limit, 100), normalizedOffset(opts.offset))
    .all();
  return (rows.results || []).map(toTag);
}

// "Sync now" fans out to the three git-based workflows (branches; commits+tags;
// PRs) via the GitHub Actions REST API. They also run hourly on their own cron;
// this just kicks an immediate run of each. Requires ACTIONS_DISPATCH_TOKEN, a
// PAT with actions:read+write on ACTIONS_REPO (the repo hosting the workflows).
async function dispatchSync(env, trigger) {
  const token = env.ACTIONS_DISPATCH_TOKEN;
  if (!token) {
    throw httpError(500, "Worker secret ACTIONS_DISPATCH_TOKEN is not configured.");
  }
  const repo = (env.ACTIONS_REPO || DEFAULT_ACTIONS_REPO).trim();
  const ref = (env.ACTIONS_REF || "main").trim();

  const results = await Promise.allSettled(
    SYNC_WORKFLOWS.map(async (file) => {
      const res = await fetch(
        `${GITHUB_API}/repos/${repo}/actions/workflows/${file}/dispatches`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "github-dashboard-worker",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref }),
        }
      );
      // A successful workflow_dispatch returns 204 No Content.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${file}: ${res.status} ${text.slice(0, 200)}`);
      }
      return file;
    })
  );

  const failed = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r.reason && r.reason.message) || String(r.reason));
  await setMeta(env, "sync_dispatched_at", String(unixNow()));
  await setMeta(env, "sync_trigger", trigger);
  await setMeta(env, "sync_dispatch_error", failed.join(" | "));
  if (failed.length) {
    throw httpError(
      502,
      `Failed to dispatch ${failed.length}/${SYNC_WORKFLOWS.length} workflow(s): ${failed.join(" | ")}`
    );
  }
  return syncStatus(env);
}

// Compact "5m ago" relative time for status messages.
function relativeAgo(now, ts) {
  if (!ts) return "never";
  const d = Math.max(0, now - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

async function githubJson(env, path, query = {}, budget = null) {
  if (budget) budget.noteFetch();
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "github-dashboard-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    let githubMessage = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      githubMessage = body.message || githubMessage;
    } catch {
      // Keep the status text when GitHub does not return a JSON error body.
    }
    throw httpError(response.status, githubMessage);
  }

  return response.json();
}

async function githubGraphQL(env, query, variables = {}, budget = null) {
  if (budget) budget.noteFetch();
  const response = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "github-dashboard-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.message || message;
    } catch {
      // Keep the status text when GitHub does not return a JSON error body.
    }
    throw httpError(response.status, message);
  }

  const body = await response.json();
  // GraphQL reports query-level failures with HTTP 200 + an errors array.
  if (Array.isArray(body.errors) && body.errors.length) {
    const message = body.errors
      .map((error) => error && error.message)
      .filter(Boolean)
      .join("; ");
    throw httpError(502, message || "GitHub GraphQL error");
  }
  return body.data;
}

// Lazily fetch a single commit's full message body from GitHub. Used for commits
// ingested from git with metadata only. Returns null on any failure so the
// commit detail view still renders from the cached subject.
async function fetchCommitMessageFromGitHub(env, sha) {
  if (!env.GITHUB_TOKEN || !sha) return null;
  try {
    const [owner, repo] = repoParts(env);
    const data = await githubGraphQL(
      env,
      `query($owner:String!,$name:String!,$oid:GitObjectID!){
         repository(owner:$owner,name:$name){
           object(oid:$oid){ ... on Commit { message author { name email } } }
         }
       }`,
      { owner, name: repo, oid: sha }
    );
    const object = data?.repository?.object;
    if (!object) return null;
    return {
      message: object.message || "",
      authorName: object.author?.name || null,
      authorEmail: object.author?.email || null,
    };
  } catch {
    return null;
  }
}

// Lazily fetch a single PR's description body from GitHub. Used because bodies are
// no longer stored in bulk. Returns "" for a genuinely empty body (so we cache the
// absence and stop re-fetching), or null on any failure.
async function fetchPrBodyFromGitHub(env, number) {
  if (!env.GITHUB_TOKEN) return null;
  try {
    const [owner, repo] = repoParts(env);
    const data = await githubJson(env, `/repos/${owner}/${repo}/pulls/${number}`);
    return data?.body ?? "";
  } catch {
    return null;
  }
}

// Status is derived from the per-source "last synced" timestamps each workflow's
// ingest script writes to meta, plus a short "running" window after a manual
// dispatch (until every source reports a run at/after the dispatch, capped so a
// slow/failed workflow can't pin the indicator forever). No GitHub API call.
async function syncStatus(env) {
  const values = await Promise.all([
    ...SYNC_SOURCES.map((s) => getMeta(env, s.metaKey)),
    getMeta(env, "sync_dispatched_at"),
    getMeta(env, "sync_trigger"),
    getMeta(env, "sync_dispatch_error"),
  ]);
  const dispatchError = values.pop();
  const trigger = values.pop();
  const dispatchedRaw = values.pop();

  const now = unixNow();
  const sources = SYNC_SOURCES.map((s, i) => ({
    key: s.key,
    label: s.label,
    lastSyncAt: unixOrNull(values[i]),
  }));
  const times = sources.map((s) => s.lastSyncAt || 0);
  const lastSyncAt = Math.max(0, ...times) || null;

  const dispatched = unixOrNull(dispatchedRaw);
  // Running until every source recorded a sync at/after the dispatch (each ingest
  // script always bumps its timestamp when it finishes), capped at 15 minutes.
  const allReported = dispatched ? times.every((t) => t >= dispatched) : true;
  const running = !!dispatched && !allReported && now - dispatched < 15 * 60;

  let status = "idle";
  if (running) status = "running";
  else if (dispatchError) status = "error";
  else if (lastSyncAt) status = "success";

  const summary = sources
    .map((s) => `${s.label} ${relativeAgo(now, s.lastSyncAt)}`)
    .join(" \u00b7 ");

  return {
    status,
    phase: running ? "dispatch" : "done",
    message: running ? `Syncing \u2014 dispatched ${relativeAgo(now, dispatched)}` : summary,
    startedAt: dispatched,
    finishedAt: allReported ? lastSyncAt : null,
    lastSyncAt,
    heartbeatAt: lastSyncAt,
    error: dispatchError || null,
    trigger: trigger || null,
    sources,
  };
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, value)
    .run();
}

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(key)
    .first();
  return row?.value || null;
}

async function scalar(env, sql, ...bindings) {
  const row = await env.DB.prepare(sql)
    .bind(...bindings)
    .first();
  return Number(row?.c || 0);
}

async function getCommitRow(env, sha) {
  if (!sha) return null;
  return env.DB.prepare(
    `SELECT * FROM commits
     WHERE sha = ? OR short_sha = ? OR sha LIKE ?
     ORDER BY committed_at DESC
     LIMIT 1`
  )
    .bind(sha, sha, `${sha}%`)
    .first();
}

function toBranch(row) {
  return {
    type: "branch",
    name: row.name,
    headSha: row.head_sha,
    shortHeadSha: row.head_sha?.slice(0, 7) || "",
    isDefault: !!row.is_default,
    lastCommitAt: row.last_commit_at ?? null,
    branchCreatedAt: null,
    deletedAt: row.deleted_at ?? null,
  };
}

function toCommit(row) {
  return {
    type: "commit",
    sha: row.sha,
    shortSha: row.short_sha || row.sha?.slice(0, 7) || "",
    authorName: row.author_name,
    authorEmail: row.author_email,
    authoredAt: row.authored_at ?? null,
    committedAt: row.committed_at ?? null,
    summary: row.summary,
    url: row.url || githubCommitUrl(row.sha),
  };
}

function toPr(row) {
  return {
    type: "pr",
    number: row.number,
    title: row.title,
    state: row.state,
    author: row.author,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    headSha: row.head_sha,
    mergeCommitSha: row.merge_commit_sha,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    mergedAt: row.merged_at ?? null,
    closedAt: row.closed_at ?? null,
    draft: !!row.draft,
    url: row.url || githubPrUrl(row.number),
  };
}

function toPrDetail(row) {
  return {
    ...toPr(row),
    body: row.body,
  };
}

function toTag(row) {
  return {
    type: "tag",
    name: row.name,
    targetSha: row.target_sha,
    shortTargetSha: row.target_sha?.slice(0, 7) || "",
    isAnnotated: !!row.is_annotated,
    taggedAt: row.tagged_at ?? null,
    message: row.message,
    deletedAt: row.deleted_at ?? null,
  };
}

function repoParts(env) {
  const value = (env.GITHUB_REPO || DEFAULT_REPO).trim();
  const [owner, repo] = value.split("/");
  if (!owner || !repo) {
    throw httpError(500, `GITHUB_REPO must be in owner/repo form, got: ${value}`);
  }
  return [owner, repo];
}

function decodePathParam(pathname, prefix) {
  return pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent)
    .join("/");
}

function githubCommitUrl(sha) {
  return `https://github.com/${DEFAULT_REPO}/commit/${encodeURIComponent(sha || "")}`;
}

function githubPrUrl(number) {
  return `https://github.com/${DEFAULT_REPO}/pull/${encodeURIComponent(number || "")}`;
}

function normalizeBranchSort(value) {
  return value === "name" ? "name" : "last_commit_at";
}

function normalizePrState(value) {
  return value === "open" || value === "closed" || value === "merged" ? value : "all";
}

function normalizedLimit(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(parsed)));
}

function normalizedOffset(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function toUnix(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function unixOrNull(value) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function likeParam(value) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function isShaPrefix(value) {
  return /^[0-9a-f]{4,40}$/i.test(value);
}

function prNumber(value) {
  const match = value.match(/^#?(\d+)$/);
  return match ? Number(match[1]) : null;
}

function matchesCommitQuery(row, q) {
  if (!q) return true;
  return [
    row.sha,
    row.short_sha,
    row.summary,
    row.message,
    row.author_name,
    row.author_email,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function requireWrite(request, env) {
  // Admin token requirement temporarily disabled. Remove this early return to re-enable.
  return "";

  if (!env.ADMIN_TOKEN) {
    return "Worker secret ADMIN_TOKEN is not configured.";
  }
  const provided = authToken(request);
  if (!provided || !timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return "Admin token is required.";
  }
  return "";
}

function authToken(request) {
  const headerToken = request.headers.get("X-Dashboard-Admin-Token");
  if (headerToken) return headerToken.trim();
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function validateOrigin(request, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  if (allowedOrigin === "*") return "";

  const origin = request.headers.get("Origin");
  if (!origin) return "";

  const allowedOrigins = allowedOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowedOrigins.includes(origin) ? "" : "Origin is not allowed.";
}

function corsHeaders(request, env) {
  const configuredOrigin = env.ALLOWED_ORIGIN || "*";
  const base = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Dashboard-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (configuredOrigin === "*") {
    return { ...base, "Access-Control-Allow-Origin": "*" };
  }

  const origin = request.headers.get("Origin");
  const allowedOrigins = configuredOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin =
    origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return { ...base, "Access-Control-Allow-Origin": allowOrigin };
}

function jsonResponse(request, env, body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json;charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function htmlResponse(html, request, env, init = {}) {
  return new Response(html, {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "text/html;charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

