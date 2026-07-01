import { companyAuthResponse } from "./company-auth.js";
import { dashboardHtml, isDashboardRoute } from "./ui.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "AppliedNeuron/core-stack";
const DEFAULT_BRANCH_PAGES = 5;
const DEFAULT_COMMIT_PAGES = 3;
const DEFAULT_PR_PAGES = 5;
const DEFAULT_TAG_PAGES = 3;
const GITHUB_PAGE_SIZE = 100;
const MAX_SYNC_PAGES = 100;
const DEFAULT_SEED_PAGE_BUDGET = 1000;
const MAX_SEED_PAGE_BUDGET = 5000;
// History back-fill rotates through the entity types one page-range at a time so
// they all advance together. 1 page per turn = pure round-robin by page.
const DEFAULT_SEED_PAGES_PER_TURN = 1;
const MAX_SEED_PAGES_PER_TURN = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_RUNNING_TTL_SECONDS = 10 * 60;
const MAX_RUNNING_TTL_SECONDS = 24 * 60 * 60;
// Free-plan Workers allow 50 external subrequests per invocation. Cap GitHub
// calls per run well under that so a single sync never trips the limit; the
// cron trigger resumes from saved cursors on the next tick.
const DEFAULT_MAX_GITHUB_REQUESTS = 30;
const MAX_GITHUB_REQUESTS = 5000;
// A live sync updates its heartbeat on every phase/batch. If the heartbeat goes
// stale the worker was almost certainly evicted or hit a limit mid-run, so a new
// sync is allowed to take over instead of waiting for the full running TTL.
const DEFAULT_HEARTBEAT_STALE_SECONDS = 180;
const MAX_HEARTBEAT_STALE_SECONDS = 60 * 60;
const SEED_PLAN_VERSION = "full-history-with-parents-2026-06-30";
const SCHEMA_UPGRADE_VERSION = "commit-parents-2026-06-30";

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
CREATE TABLE IF NOT EXISTS commit_parents (
  child_sha  TEXT NOT NULL,
  parent_sha TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (child_sha, parent_sha)
);
CREATE INDEX IF NOT EXISTS idx_commit_parents_child ON commit_parents(child_sha);
CREATE INDEX IF NOT EXISTS idx_commit_parents_parent ON commit_parents(parent_sha);
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
        const status = await startSync(env, ctx, "manual");
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

  async scheduled(_event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(startSync(env, ctx, "scheduled"));
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
  const statements = [
    `CREATE TABLE IF NOT EXISTS commit_parents (
       child_sha  TEXT NOT NULL,
       parent_sha TEXT NOT NULL,
       ordinal    INTEGER NOT NULL,
       PRIMARY KEY (child_sha, parent_sha)
     )`,
    "CREATE INDEX IF NOT EXISTS idx_commit_parents_child ON commit_parents(child_sha)",
    "CREATE INDEX IF NOT EXISTS idx_commit_parents_parent ON commit_parents(parent_sha)",
    "CREATE INDEX IF NOT EXISTS idx_prs_head_ref ON prs(head_ref)",
    "CREATE INDEX IF NOT EXISTS idx_prs_base_ref ON prs(base_ref)",
  ];
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
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
    scalar(env, "SELECT COUNT(*) AS c FROM commits"),
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
    walkError: null,
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
  const mode = await branchCommitMode(env, branch);
  const filter = branchCommitFilter(q);

  if (mode === "dag") {
    const reachableCte = `
      WITH RECURSIVE reachable(sha) AS (
        SELECT ?
        UNION
        SELECT cp.parent_sha
        FROM commit_parents cp
        JOIN reachable r ON cp.child_sha = r.sha
      )`;
    const total = await scalar(
      env,
      `${reachableCte}
       SELECT COUNT(*) AS c
       FROM commits c
       JOIN reachable r ON c.sha = r.sha
       ${filter.where}`,
      branch.head_sha,
      ...filter.bindings
    );
    if (opts.countOnly) return { total, source: "sql", commits: [] };
    const rows = await env.DB.prepare(
      `${reachableCte}
       SELECT c.*
       FROM commits c
       JOIN reachable r ON c.sha = r.sha
       ${filter.where}
       ORDER BY c.committed_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(branch.head_sha, ...filter.bindings, limit, offset)
      .all();
    return {
      total,
      source: "sql",
      commits: (rows.results || []).map(toCommit),
    };
  }

  if (mode === "default") {
    const total = await scalar(
      env,
      `SELECT COUNT(*) AS c FROM commits c ${filter.where}`,
      ...filter.bindings
    );
    if (opts.countOnly) return { total, source: "sql", commits: [] };
    const rows = await env.DB.prepare(
      `SELECT c.*
       FROM commits c
       ${filter.where}
       ORDER BY c.committed_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...filter.bindings, limit, offset)
      .all();
    return {
      total,
      source: "sql",
      commits: (rows.results || []).map(toCommit),
    };
  }

  const commit = await getCommitRow(env, branch.head_sha);
  const commits =
    commit && matchesCommitQuery(commit, q) ? [toCommit(commit)] : [];
  return {
    total: commits.length,
    source: "sql",
    commits: opts.countOnly ? [] : commits.slice(offset, offset + limit),
  };
}

async function branchCommitMode(env, branch) {
  const parentEdges = await scalar(
    env,
    "SELECT COUNT(*) AS c FROM commit_parents WHERE child_sha = ?",
    branch.head_sha
  );
  if (parentEdges > 0) return "dag";

  const defaultBranch = await getMeta(env, "default_branch");
  if (defaultBranch && branch.name === defaultBranch) return "default";
  return "head";
}

function branchCommitFilter(q) {
  if (!q) return { where: "", bindings: [] };
  const like = likeParam(q);
  return {
    where:
      `WHERE LOWER(c.sha) LIKE ? ESCAPE '\\'
         OR LOWER(c.short_sha) LIKE ? ESCAPE '\\'
         OR LOWER(COALESCE(c.summary, '')) LIKE ? ESCAPE '\\'
         OR LOWER(COALESCE(c.author_name, '')) LIKE ? ESCAPE '\\'`,
    bindings: [like, like, like, like],
  };
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

  const [prRows, tagRows, branchRows] = await Promise.all([
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
    env.DB.prepare("SELECT * FROM branches WHERE head_sha = ? ORDER BY name ASC")
      .bind(row.sha)
      .all(),
  ]);

  return {
    commit: toCommit(row),
    message: row.message || row.summary || "",
    parents: [],
    prs: (prRows.results || []).map(toPr),
    tagsPointing: (tagRows.results || []).map((tag) => ({
      name: tag.name,
      deletedAt: tag.deleted_at ?? null,
    })),
    branches: (branchRows.results || []).map(toBranch),
  };
}

async function handleCommitBranches(env, sha) {
  const row = await getCommitRow(env, sha);
  if (!row) throw httpError(404, "Commit not found");

  const branches = await env.DB.prepare(
    "SELECT name FROM branches WHERE head_sha = ? ORDER BY name ASC"
  )
    .bind(row.sha)
    .all();

  return {
    sha: row.sha,
    branches: (branches.results || []).map((branch) => branch.name),
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
  return {
    total: await scalar(env, "SELECT COUNT(*) AS c FROM branches"),
    branches: await listBranches(env, {
      limit: normalizedLimit(url.searchParams.get("limit"), 100),
      offset: normalizedOffset(url.searchParams.get("offset")),
      includeDeleted: url.searchParams.get("includeDeleted") === "1",
      sort: normalizeBranchSort(url.searchParams.get("sort")),
    }),
  };
}

async function handleCommits(env, url) {
  return {
    total: await scalar(env, "SELECT COUNT(*) AS c FROM commits"),
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

async function listCommits(env, opts) {
  const rows = await env.DB.prepare(
    "SELECT * FROM commits ORDER BY committed_at DESC LIMIT ? OFFSET ?"
  )
    .bind(normalizedLimit(opts.limit, 100), normalizedOffset(opts.offset))
    .all();
  return (rows.results || []).map(toCommit);
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

async function startSync(env, ctx, trigger) {
  if (!env.GITHUB_TOKEN) {
    throw httpError(500, "Worker secret GITHUB_TOKEN is not configured.");
  }

  const current = await syncStatus(env);
  const now = unixNow();
  // syncStatus() already downgrades a stalled run to "error", so a status of
  // "running" here means a live sync is genuinely still in progress.
  if (current.status === "running") {
    return current;
  }

  await setSyncStatus(env, {
    status: "running",
    phase: "starting",
    message: `Starting ${trigger} sync`,
    started_at: now,
    heartbeat_at: now,
    finished_at: null,
    error: null,
  });

  ctx.waitUntil(
    runSync(env, trigger).catch(async (error) => {
      await setSyncStatus(env, {
        status: "error",
        phase: "error",
        message: "Sync failed",
        finished_at: unixNow(),
        error: error.message || String(error),
      });
    })
  );

  return syncStatus(env);
}

async function runSync(env, trigger) {
  const [owner, repo] = repoParts(env);
  const now = unixNow();
  // One shared subrequest budget for the whole invocation so the fresh pass and
  // the history back-fill together stay under the free-plan limit.
  const budget = createSyncBudget(env);
  await ensureSeedPlan(env, owner, repo);
  const previousSyncAt = unixOrNull(await getMeta(env, "last_sync_at"));
  const seeded = await seedComplete(env);

  await setSyncStatus(env, {
    phase: "repo",
    message: `Fetching ${owner}/${repo} metadata`,
  });
  const repoMeta = await githubJson(env, `/repos/${owner}/${repo}`, {}, budget);
  await setMeta(env, "default_branch", repoMeta.default_branch || "");
  await setMeta(env, "repo_url", repoMeta.html_url || `https://github.com/${owner}/${repo}`);

  await setSyncStatus(env, { phase: "branches", message: "Syncing branches" });
  const branchSync = await fetchBranches(env, owner, repo, repoMeta.default_branch, now, { budget });
  await upsertBranches(env, branchSync.items, now, branchSync.complete);

  await setSyncStatus(env, { phase: "tags", message: "Syncing tags" });
  const tagSync = await fetchTags(env, owner, repo, now, { budget });
  await upsertTags(env, tagSync.items, now, tagSync.complete);

  await setSyncStatus(env, { phase: "commits", message: "Syncing recent commits" });
  const commitSync = await fetchCommits(env, owner, repo, repoMeta.default_branch, {
    stopWhenKnown: seeded && !!previousSyncAt,
    budget,
  });
  await upsertCommits(env, commitSync.items);

  await setSyncStatus(env, { phase: "prs", message: "Syncing pull requests" });
  const prSync = await fetchPullRequests(env, owner, repo, {
    updatedAfter: seeded ? previousSyncAt : null,
    budget,
  });
  await upsertPrs(env, prSync.items);
  await setMeta(env, "last_sync_at", String(unixNow()));

  const historySeed = await seedHistory(
    env,
    owner,
    repo,
    repoMeta.default_branch,
    now,
    {
      branches: branchSync.complete,
      tags: tagSync.complete,
      commits: commitSync.complete,
      prs: prSync.complete,
    },
    budget
  );

  // Recompute branch commit times once per run instead of after every batch.
  await fillBranchCommitTimes(env);
  await setMeta(env, "last_sync_at", String(unixNow()));

  const backfilling = !(await seedComplete(env));
  await setSyncStatus(env, {
    status: "success",
    phase: "done",
    message:
      `Synced ${branchSync.items.length + historySeed.branches.items} branches, ` +
      `${tagSync.items.length + historySeed.tags.items} tags, ` +
      `${commitSync.items.length + historySeed.commits.items} commits, ` +
      `${prSync.items.length + historySeed.prs.items} PRs` +
      (backfilling
        ? ` (back-fill in progress, ${budget.githubUsed}/${budget.githubLimit} GitHub requests used)`
        : ""),
    finished_at: unixNow(),
    error: null,
    trigger,
  });
}

async function fetchBranches(env, owner, repo, defaultBranch, now, opts = {}) {
  const pages = opts.pages || syncPages(env.SYNC_BRANCH_PAGES, DEFAULT_BRANCH_PAGES);
  const branches = [];
  const pageState = await eachGithubPage(
    env,
    `/repos/${owner}/${repo}/branches`,
    {},
    { pages, startPage: opts.startPage, budget: opts.budget },
    (items) => {
      for (const item of items) {
        if (!item?.name || !item?.commit?.sha) continue;
        branches.push({
          name: item.name,
          headSha: item.commit.sha,
          isDefault: item.name === defaultBranch ? 1 : 0,
          lastCommitAt: null,
          firstSeenAt: now,
        });
      }
    }
  );
  return { items: branches, ...pageState };
}

async function fetchTags(env, owner, repo, now, opts = {}) {
  const pages = opts.pages || syncPages(env.SYNC_TAG_PAGES, DEFAULT_TAG_PAGES);
  const tags = [];
  const pageState = await eachGithubPage(
    env,
    `/repos/${owner}/${repo}/tags`,
    {},
    { pages, startPage: opts.startPage, budget: opts.budget },
    (items) => {
      for (const item of items) {
        if (!item?.name || !item?.commit?.sha) continue;
        tags.push({
          name: item.name,
          targetSha: item.commit.sha,
          isAnnotated: 0,
          taggedAt: null,
          message: null,
          firstSeenAt: now,
        });
      }
    }
  );
  return { items: tags, ...pageState };
}

async function fetchCommits(env, owner, repo, branch, opts = {}) {
  const pages = opts.pages || syncPages(env.SYNC_COMMIT_PAGES, DEFAULT_COMMIT_PAGES);
  const commits = [];
  const pageState = await eachGithubPage(
    env,
    `/repos/${owner}/${repo}/commits`,
    { sha: branch },
    { pages, startPage: opts.startPage, budget: opts.budget },
    async (items) => {
      const pageCommits = [];
      for (const item of items) {
        const commit = item?.commit;
        if (!item?.sha || !commit) continue;
        const message = commit.message || "";
        pageCommits.push({
          sha: item.sha,
          shortSha: item.sha.slice(0, 7),
          authorName: commit.author?.name || item.author?.login || null,
          authorEmail: commit.author?.email || null,
          authoredAt: toUnix(commit.author?.date),
          committedAt: toUnix(commit.committer?.date || commit.author?.date),
          summary: message.split("\n")[0] || null,
          message,
          url: item.html_url || null,
          parents: Array.isArray(item.parents)
            ? item.parents
                .map((parent) => parent?.sha)
                .filter(Boolean)
            : [],
        });
      }
      commits.push(...pageCommits);
      if (opts.stopWhenKnown && pageCommits.length > 0) {
        return !(await allCommitsExist(env, pageCommits));
      }
      return true;
    }
  );
  return { items: commits, ...pageState };
}

async function fetchPullRequests(env, owner, repo, opts = {}) {
  const pages = opts.pages || syncPages(env.SYNC_PR_PAGES, DEFAULT_PR_PAGES);
  const prs = [];
  const pageState = await eachGithubPage(
    env,
    `/repos/${owner}/${repo}/pulls`,
    { state: "all", sort: "updated", direction: "desc" },
    { pages, startPage: opts.startPage, budget: opts.budget },
    (items) => {
      const pagePrs = [];
      for (const pr of items) {
        if (!Number.isInteger(pr?.number)) continue;
        pagePrs.push({
          number: pr.number,
          title: pr.title || "",
          state: pr.merged_at ? "merged" : pr.state || "closed",
          author: pr.user?.login || null,
          baseRef: pr.base?.ref || null,
          headRef: pr.head?.ref || null,
          headSha: pr.head?.sha || null,
          mergeCommitSha: pr.merge_commit_sha || null,
          createdAt: toUnix(pr.created_at),
          updatedAt: toUnix(pr.updated_at),
          mergedAt: toUnix(pr.merged_at),
          closedAt: toUnix(pr.closed_at),
          url: pr.html_url || null,
          draft: pr.draft ? 1 : 0,
          body: pr.body || null,
        });
      }
      prs.push(...pagePrs);
      if (opts.updatedAfter && pagePrs.length > 0) {
        return pagePrs.some((pr) => (pr.updatedAt || 0) > opts.updatedAfter);
      }
      return true;
    }
  );
  return { items: prs, ...pageState };
}

async function seedHistory(env, owner, repo, defaultBranch, now, freshComplete, budget) {
  const pagesPerTurn = seedPagesPerTurn(env);
  const perEntityBudget = seedPageBudget(env);

  // Each seeder knows how to fetch + upsert one page-range of its entity type.
  const seeders = [
    {
      kind: "branches",
      table: "branches",
      freshComplete: freshComplete.branches,
      freshPages: syncPages(env.SYNC_BRANCH_PAGES, DEFAULT_BRANCH_PAGES),
      run: async (startPage, pages) => {
        const result = await fetchBranches(env, owner, repo, defaultBranch, now, { startPage, pages, budget });
        await upsertBranches(env, result.items, now, false);
        return result;
      },
    },
    {
      kind: "tags",
      table: "tags",
      freshComplete: freshComplete.tags,
      freshPages: syncPages(env.SYNC_TAG_PAGES, DEFAULT_TAG_PAGES),
      run: async (startPage, pages) => {
        const result = await fetchTags(env, owner, repo, now, { startPage, pages, budget });
        await upsertTags(env, result.items, now, false);
        return result;
      },
    },
    {
      kind: "commits",
      table: "commits",
      freshComplete: freshComplete.commits,
      freshPages: syncPages(env.SYNC_COMMIT_PAGES, DEFAULT_COMMIT_PAGES),
      run: async (startPage, pages) => {
        const result = await fetchCommits(env, owner, repo, defaultBranch, { startPage, pages, budget });
        await upsertCommits(env, result.items);
        return result;
      },
    },
    {
      kind: "prs",
      table: "prs",
      freshComplete: freshComplete.prs,
      freshPages: syncPages(env.SYNC_PR_PAGES, DEFAULT_PR_PAGES),
      run: async (startPage, pages) => {
        const result = await fetchPullRequests(env, owner, repo, { startPage, pages, budget });
        await upsertPrs(env, result.items);
        return result;
      },
    },
  ];

  // Resolve each type's starting cursor / completion up front.
  const states = seeders.map((seeder) => ({
    seeder,
    complete: false,
    cursor: 1,
    items: 0,
    pagesThisRun: 0,
  }));
  for (const state of states) {
    const { seeder } = state;
    if (seeder.freshComplete) {
      await setMeta(env, seedCompleteKey(seeder.kind), "1");
      state.complete = true;
    } else if ((await getMeta(env, seedCompleteKey(seeder.kind))) === "1") {
      state.complete = true;
    } else {
      state.cursor = await seedStartPage(env, seeder.kind, seeder.table, seeder.freshPages);
    }
  }

  // Round-robin one page-range per type per rotation (branches -> tags ->
  // commits -> prs -> repeat) so every type back-fills together, until this
  // invocation's shared subrequest budget is spent. Cursors persist to meta, so
  // the next run picks up exactly where this one stopped.
  let progressed = true;
  while (budget.canFetch() && progressed) {
    progressed = false;
    for (const state of states) {
      if (!budget.canFetch()) break;
      if (state.complete || state.pagesThisRun >= perEntityBudget) continue;

      const pages = Math.min(pagesPerTurn, perEntityBudget - state.pagesThisRun);
      await setSyncStatus(env, {
        phase: state.seeder.kind,
        message: `Back-filling ${state.seeder.kind} (page ${state.cursor})`,
      });
      const result = await state.seeder.run(state.cursor, pages);

      const advanced = Math.max(0, result.nextPage - state.cursor);
      state.items += result.items.length;
      state.pagesThisRun += advanced;
      state.cursor = result.nextPage;
      state.complete = !!result.complete;

      await setMeta(env, seedNextPageKey(state.seeder.kind), String(state.cursor));
      await setMeta(env, seedCompleteKey(state.seeder.kind), state.complete ? "1" : "0");

      if (result.budgetExhausted) break;
      if (advanced > 0 && !state.complete) progressed = true;
    }
  }

  const results = {
    branches: { items: 0, complete: freshComplete.branches },
    tags: { items: 0, complete: freshComplete.tags },
    commits: { items: 0, complete: freshComplete.commits },
    prs: { items: 0, complete: freshComplete.prs },
  };
  for (const state of states) {
    results[state.seeder.kind] = { items: state.items, complete: state.complete };
  }
  return results;
}

async function seedStartPage(env, kind, table, freshPages) {
  const saved = Number(await getMeta(env, seedNextPageKey(kind)));
  if (Number.isFinite(saved) && saved >= 1) return Math.floor(saved);

  const cachedItems = await scalar(env, `SELECT COUNT(*) AS c FROM ${table}`);
  const nextCachedPage = Math.floor(cachedItems / GITHUB_PAGE_SIZE) + 1;
  return Math.max(freshPages + 1, nextCachedPage);
}

function seedPagesPerTurn(env) {
  return positiveInt(
    env.SYNC_SEED_PAGES_PER_TURN,
    DEFAULT_SEED_PAGES_PER_TURN,
    MAX_SEED_PAGES_PER_TURN
  );
}

function seedPageBudget(env) {
  return positiveInt(env.SYNC_SEED_PAGE_BUDGET, DEFAULT_SEED_PAGE_BUDGET, MAX_SEED_PAGE_BUDGET);
}

async function ensureSeedPlan(env, owner, repo) {
  const expected = `${owner}/${repo}:${SEED_PLAN_VERSION}`;
  if ((await getMeta(env, "seed_plan_version")) === expected) return;

  const nextPages = {
    branches: syncPages(env.SYNC_BRANCH_PAGES, DEFAULT_BRANCH_PAGES) + 1,
    tags: syncPages(env.SYNC_TAG_PAGES, DEFAULT_TAG_PAGES) + 1,
    commits: syncPages(env.SYNC_COMMIT_PAGES, DEFAULT_COMMIT_PAGES) + 1,
    prs: syncPages(env.SYNC_PR_PAGES, DEFAULT_PR_PAGES) + 1,
  };

  for (const kind of Object.keys(nextPages)) {
    await setMeta(env, seedNextPageKey(kind), String(nextPages[kind]));
    await setMeta(env, seedCompleteKey(kind), "0");
  }
  await setMeta(env, "seed_plan_version", expected);
}

async function seedComplete(env) {
  const complete = await Promise.all([
    getMeta(env, seedCompleteKey("branches")),
    getMeta(env, seedCompleteKey("tags")),
    getMeta(env, seedCompleteKey("commits")),
    getMeta(env, seedCompleteKey("prs")),
  ]);
  return complete.every((value) => value === "1");
}

function seedNextPageKey(kind) {
  return `seed_${kind}_next_page`;
}

function seedCompleteKey(kind) {
  return `seed_${kind}_complete`;
}

async function eachGithubPage(env, path, query, opts, onPage) {
  const maxPages = opts.pages;
  const startPage = opts.startPage || 1;
  const budget = opts.budget || null;
  for (let page = startPage; page < startPage + maxPages; page++) {
    if (budget && !budget.canFetch()) {
      // Stop before spending another subrequest; resume from this page later.
      return { complete: false, nextPage: page, budgetExhausted: true };
    }
    const items = await githubJson(
      env,
      path,
      {
        ...query,
        per_page: String(GITHUB_PAGE_SIZE),
        page: String(page),
      },
      budget
    );
    if (!Array.isArray(items) || items.length === 0) {
      return { complete: true, nextPage: page };
    }
    const shouldContinue = await onPage(items, page);
    if (items.length < GITHUB_PAGE_SIZE) {
      return { complete: true, nextPage: page + 1 };
    }
    if (shouldContinue === false) {
      return { complete: false, nextPage: page + 1, stoppedEarly: true };
    }
  }
  return { complete: false, nextPage: startPage + maxPages };
}

async function allCommitsExist(env, commits) {
  if (!commits.length) return false;
  const existing = new Set();
  for (let i = 0; i < commits.length; i += 50) {
    const chunk = commits.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT sha FROM commits WHERE sha IN (${placeholders})`
    )
      .bind(...chunk.map((commit) => commit.sha))
      .all();
    for (const row of rows.results || []) existing.add(row.sha);
  }
  return commits.every((commit) => existing.has(commit.sha));
}

async function upsertBranches(env, branches, now, markMissingDeleted) {
  const seen = new Set(branches.map((branch) => branch.name));
  await chunkedBatch(
    env,
    branches.map((branch) =>
      env.DB.prepare(
        `INSERT INTO branches (name, head_sha, is_default, last_commit_at, first_seen_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET
           head_sha = excluded.head_sha,
           is_default = excluded.is_default,
           last_commit_at = excluded.last_commit_at,
           deleted_at = NULL`
      ).bind(branch.name, branch.headSha, branch.isDefault, branch.lastCommitAt, branch.firstSeenAt)
    )
  );
  if (markMissingDeleted) {
    await markDeleted(env, "branches", "name", seen, now);
  }
}

async function upsertTags(env, tags, now, markMissingDeleted) {
  const seen = new Set(tags.map((tag) => tag.name));
  await chunkedBatch(
    env,
    tags.map((tag) =>
      env.DB.prepare(
        `INSERT INTO tags (name, target_sha, is_annotated, tagged_at, message, first_seen_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET
           target_sha = excluded.target_sha,
           is_annotated = excluded.is_annotated,
           tagged_at = excluded.tagged_at,
           message = excluded.message,
           deleted_at = NULL`
      ).bind(tag.name, tag.targetSha, tag.isAnnotated, tag.taggedAt, tag.message, tag.firstSeenAt)
    )
  );
  if (markMissingDeleted) {
    await markDeleted(env, "tags", "name", seen, now);
  }
}

async function upsertCommits(env, commits) {
  await chunkedBatch(
    env,
    commits.map((commit) =>
      env.DB.prepare(
        `INSERT INTO commits (sha, short_sha, author_name, author_email, authored_at, committed_at, summary, message, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           author_name = excluded.author_name,
           author_email = excluded.author_email,
           authored_at = excluded.authored_at,
           committed_at = excluded.committed_at,
           summary = excluded.summary,
           message = excluded.message,
           url = excluded.url`
      ).bind(
        commit.sha,
        commit.shortSha,
        commit.authorName,
        commit.authorEmail,
        commit.authoredAt,
        commit.committedAt,
        commit.summary,
        commit.message,
        commit.url
      )
    )
  );
  const parentStatements = [];
  for (const commit of commits) {
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    for (let i = 0; i < parents.length; i++) {
      parentStatements.push(
        env.DB.prepare(
          `INSERT INTO commit_parents (child_sha, parent_sha, ordinal)
           VALUES (?, ?, ?)
           ON CONFLICT(child_sha, parent_sha) DO UPDATE SET
             ordinal = excluded.ordinal`
        ).bind(commit.sha, parents[i], i)
      );
    }
  }
  await chunkedBatch(env, parentStatements);
}

async function fillBranchCommitTimes(env) {
  await env.DB.prepare(
    `UPDATE branches
     SET last_commit_at = (
       SELECT committed_at FROM commits WHERE commits.sha = branches.head_sha
     )
     WHERE EXISTS (
       SELECT 1 FROM commits WHERE commits.sha = branches.head_sha
     )`
  ).run();
}

async function upsertPrs(env, prs) {
  await chunkedBatch(
    env,
    prs.map((pr) =>
      env.DB.prepare(
        `INSERT INTO prs (
           number, title, state, author, base_ref, head_ref, head_sha,
           merge_commit_sha, created_at, updated_at, merged_at, closed_at,
           url, draft, body
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET
           title = excluded.title,
           state = excluded.state,
           author = excluded.author,
           base_ref = excluded.base_ref,
           head_ref = excluded.head_ref,
           head_sha = excluded.head_sha,
           merge_commit_sha = excluded.merge_commit_sha,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           merged_at = excluded.merged_at,
           closed_at = excluded.closed_at,
           url = excluded.url,
           draft = excluded.draft,
           body = excluded.body`
      ).bind(
        pr.number,
        pr.title,
        pr.state,
        pr.author,
        pr.baseRef,
        pr.headRef,
        pr.headSha,
        pr.mergeCommitSha,
        pr.createdAt,
        pr.updatedAt,
        pr.mergedAt,
        pr.closedAt,
        pr.url,
        pr.draft,
        pr.body
      )
    )
  );
}

async function markDeleted(env, table, keyColumn, seen, now) {
  const existing = await env.DB.prepare(`SELECT ${keyColumn} AS key FROM ${table} WHERE deleted_at IS NULL`).all();
  const statements = [];
  for (const row of existing.results || []) {
    if (!seen.has(row.key)) {
      statements.push(
        env.DB.prepare(`UPDATE ${table} SET deleted_at = ? WHERE ${keyColumn} = ?`).bind(now, row.key)
      );
    }
  }
  await chunkedBatch(env, statements);
}

async function chunkedBatch(env, statements, size = 50) {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
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

async function syncStatus(env) {
  const [
    status,
    phase,
    message,
    startedAt,
    finishedAt,
    error,
    lastSyncAt,
    trigger,
    heartbeatAt,
  ] = await Promise.all([
    getMeta(env, "sync_status"),
    getMeta(env, "sync_phase"),
    getMeta(env, "sync_message"),
    getMeta(env, "sync_started_at"),
    getMeta(env, "sync_finished_at"),
    getMeta(env, "sync_error"),
    getMeta(env, "last_sync_at"),
    getMeta(env, "sync_trigger"),
    getMeta(env, "sync_heartbeat_at"),
  ]);
  const normalizedStatus = status || "idle";
  const normalizedStartedAt = unixOrNull(startedAt);
  const normalizedHeartbeatAt = unixOrNull(heartbeatAt);
  if (
    normalizedStatus === "running" &&
    syncStalled(env, normalizedStartedAt, normalizedHeartbeatAt)
  ) {
    return {
      status: "error",
      phase: "error",
      message: "Previous sync stalled",
      startedAt: normalizedStartedAt,
      finishedAt: unixOrNull(finishedAt),
      lastSyncAt: unixOrNull(lastSyncAt),
      heartbeatAt: normalizedHeartbeatAt,
      error:
        "Previous sync stopped updating (the worker was likely evicted or hit a limit mid-run). Start a new sync to resume from the saved cursors.",
      trigger: trigger || null,
    };
  }

  return {
    status: normalizedStatus,
    phase: phase || "idle",
    message: message || "",
    startedAt: normalizedStartedAt,
    finishedAt: unixOrNull(finishedAt),
    lastSyncAt: unixOrNull(lastSyncAt),
    heartbeatAt: normalizedHeartbeatAt,
    error: error || null,
    trigger: trigger || null,
  };
}

// A run is stalled if its heartbeat has gone quiet (primary signal) or, as a
// backstop, if it has been marked running past the hard TTL.
function syncStalled(env, startedAt, heartbeatAt) {
  const now = unixNow();
  const lastProgressAt = heartbeatAt || startedAt;
  if (lastProgressAt && now - lastProgressAt >= heartbeatStaleSeconds(env)) {
    return true;
  }
  if (startedAt && now - startedAt >= runningTtlSeconds(env)) {
    return true;
  }
  return false;
}

async function setSyncStatus(env, patch) {
  const entries = [];
  for (const [key, value] of Object.entries(patch)) {
    const metaKey = key.startsWith("sync_") || key === "last_sync_at" ? key : `sync_${key}`;
    entries.push([metaKey, value === null || value === undefined ? "" : String(value)]);
  }
  // Every status write doubles as a heartbeat so stall detection can tell a live
  // run from an evicted one. Callers can still set it explicitly (e.g. on start).
  if (!entries.some(([key]) => key === "sync_heartbeat_at")) {
    entries.push(["sync_heartbeat_at", String(unixNow())]);
  }
  await chunkedBatch(
    env,
    entries.map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, value)
    )
  );
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

function syncPages(value, fallback) {
  return positiveInt(value, fallback, MAX_SYNC_PAGES);
}

function runningTtlSeconds(env) {
  return positiveInt(
    env.SYNC_RUNNING_TTL_SECONDS,
    DEFAULT_RUNNING_TTL_SECONDS,
    MAX_RUNNING_TTL_SECONDS
  );
}

function heartbeatStaleSeconds(env) {
  return positiveInt(
    env.SYNC_HEARTBEAT_STALE_SECONDS,
    DEFAULT_HEARTBEAT_STALE_SECONDS,
    MAX_HEARTBEAT_STALE_SECONDS
  );
}

function maxGithubRequests(env) {
  return positiveInt(
    env.SYNC_MAX_GITHUB_REQUESTS,
    DEFAULT_MAX_GITHUB_REQUESTS,
    MAX_GITHUB_REQUESTS
  );
}

// Tracks how many GitHub subrequests this invocation has spent so fetch loops can
// stop before hitting the platform's per-invocation subrequest limit.
function createSyncBudget(env) {
  return {
    githubUsed: 0,
    githubLimit: maxGithubRequests(env),
    canFetch() {
      return this.githubUsed < this.githubLimit;
    },
    noteFetch() {
      this.githubUsed += 1;
    },
  };
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
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

