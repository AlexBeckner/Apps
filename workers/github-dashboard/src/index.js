import { dashboardHtml, isDashboardRoute } from "./ui.js";

const GITHUB_API = "https://api.github.com";
const DEFAULT_REPO = "AppliedNeuron/core-stack";
const DEFAULT_BRANCH_PAGES = 5;
const DEFAULT_COMMIT_PAGES = 3;
const DEFAULT_PR_PAGES = 5;
const DEFAULT_TAG_PAGES = 3;
const MAX_SYNC_PAGES = 100;
const MAX_LIST_LIMIT = 500;
const RUNNING_TTL_SECONDS = 2 * 60;

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
`;

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);

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
  if ((await getMeta(env, "schema_initialized")) === "1") return;

  const metaTable = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
  ).first();
  if (!metaTable) {
    throw httpError(
      500,
      "D1 schema is not initialized. Run `npm run migrate:remote` before deploying."
    );
  }

  await setMeta(env, "schema_initialized", "1");
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

  const commit = await getCommitRow(env, row.head_sha);
  const directionCounts = await Promise.all([
    scalar(env, "SELECT COUNT(*) AS c FROM prs WHERE head_ref = ?", name),
    scalar(env, "SELECT COUNT(*) AS c FROM prs WHERE base_ref = ?", name),
  ]);

  return {
    branch: toBranch(row),
    branchedFrom: null,
    defaultBranch: await getMeta(env, "default_branch"),
    totalCommits: commit ? 1 : 0,
    walkError: null,
    prsFromBranchCount: directionCounts[0],
    prsToBranchCount: directionCounts[1],
    commits: commit ? [toCommit(commit)] : [],
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
  const commit = await getCommitRow(env, branch.head_sha);
  const commits =
    commit && matchesCommitQuery(commit, q) ? [toCommit(commit)] : [];

  return {
    total: commits.length,
    offset,
    limit,
    q,
    source: "sql",
    walkError: null,
    commits: commits.slice(offset, offset + limit),
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
    const like = likeParam(q);
    filterSql =
      " AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) LIKE ? ESCAPE '\\')";
    bindings.push(like, like, like);
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
  if (
    current.status === "running" &&
    current.startedAt &&
    now - current.startedAt < RUNNING_TTL_SECONDS
  ) {
    return current;
  }

  await setSyncStatus(env, {
    status: "running",
    phase: "starting",
    message: `Starting ${trigger} sync`,
    started_at: now,
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

  await setSyncStatus(env, {
    phase: "repo",
    message: `Fetching ${owner}/${repo} metadata`,
  });
  const repoMeta = await githubJson(env, `/repos/${owner}/${repo}`);
  await setMeta(env, "default_branch", repoMeta.default_branch || "");
  await setMeta(env, "repo_url", repoMeta.html_url || `https://github.com/${owner}/${repo}`);

  await setSyncStatus(env, { phase: "branches", message: "Syncing branches" });
  const branchSync = await fetchBranches(env, owner, repo, repoMeta.default_branch, now);
  await upsertBranches(env, branchSync.items, now, branchSync.complete);

  await setSyncStatus(env, { phase: "tags", message: "Syncing tags" });
  const tagSync = await fetchTags(env, owner, repo, now);
  await upsertTags(env, tagSync.items, now, tagSync.complete);

  await setSyncStatus(env, { phase: "commits", message: "Syncing recent commits" });
  const commits = await fetchCommits(env, owner, repo, repoMeta.default_branch);
  await upsertCommits(env, commits);
  await fillBranchCommitTimes(env);

  await setSyncStatus(env, { phase: "prs", message: "Syncing pull requests" });
  const prs = await fetchPullRequests(env, owner, repo);
  await upsertPrs(env, prs);

  await setMeta(env, "last_sync_at", String(unixNow()));
  await setSyncStatus(env, {
    status: "success",
    phase: "done",
    message: `Synced ${branchSync.items.length} branches, ${tagSync.items.length} tags, ${commits.length} commits, ${prs.length} PRs`,
    finished_at: unixNow(),
    error: null,
    trigger,
  });
}

async function fetchBranches(env, owner, repo, defaultBranch, now) {
  const pages = syncPages(env.SYNC_BRANCH_PAGES, DEFAULT_BRANCH_PAGES);
  const branches = [];
  const complete = await eachGithubPage(env, `/repos/${owner}/${repo}/branches`, {}, pages, (items) => {
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
  });
  return { items: branches, complete };
}

async function fetchTags(env, owner, repo, now) {
  const pages = syncPages(env.SYNC_TAG_PAGES, DEFAULT_TAG_PAGES);
  const tags = [];
  const complete = await eachGithubPage(env, `/repos/${owner}/${repo}/tags`, {}, pages, (items) => {
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
  });
  return { items: tags, complete };
}

async function fetchCommits(env, owner, repo, branch) {
  const pages = syncPages(env.SYNC_COMMIT_PAGES, DEFAULT_COMMIT_PAGES);
  const commits = [];
  await eachGithubPage(env, `/repos/${owner}/${repo}/commits`, { sha: branch }, pages, (items) => {
    for (const item of items) {
      const commit = item?.commit;
      if (!item?.sha || !commit) continue;
      const message = commit.message || "";
      commits.push({
        sha: item.sha,
        shortSha: item.sha.slice(0, 7),
        authorName: commit.author?.name || item.author?.login || null,
        authorEmail: commit.author?.email || null,
        authoredAt: toUnix(commit.author?.date),
        committedAt: toUnix(commit.committer?.date || commit.author?.date),
        summary: message.split("\n")[0] || null,
        message,
        url: item.html_url || null,
      });
    }
  });
  return commits;
}

async function fetchPullRequests(env, owner, repo) {
  const pages = syncPages(env.SYNC_PR_PAGES, DEFAULT_PR_PAGES);
  const prs = [];
  await eachGithubPage(
    env,
    `/repos/${owner}/${repo}/pulls`,
    { state: "all", sort: "updated", direction: "desc" },
    pages,
    (items) => {
      for (const pr of items) {
        if (!Number.isInteger(pr?.number)) continue;
        prs.push({
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
    }
  );
  return prs;
}

async function eachGithubPage(env, path, query, maxPages, onPage) {
  for (let page = 1; page <= maxPages; page++) {
    const items = await githubJson(env, path, {
      ...query,
      per_page: "100",
      page: String(page),
    });
    if (!Array.isArray(items) || items.length === 0) return true;
    onPage(items, page);
    if (items.length < 100) return true;
  }
  return false;
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

async function githubJson(env, path, query = {}) {
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
  ] = await Promise.all([
    getMeta(env, "sync_status"),
    getMeta(env, "sync_phase"),
    getMeta(env, "sync_message"),
    getMeta(env, "sync_started_at"),
    getMeta(env, "sync_finished_at"),
    getMeta(env, "sync_error"),
    getMeta(env, "last_sync_at"),
    getMeta(env, "sync_trigger"),
  ]);
  return {
    status: status || "idle",
    phase: phase || "idle",
    message: message || "",
    startedAt: unixOrNull(startedAt),
    finishedAt: unixOrNull(finishedAt),
    lastSyncAt: unixOrNull(lastSyncAt),
    error: error || null,
    trigger: trigger || null,
  };
}

async function setSyncStatus(env, patch) {
  const entries = [];
  for (const [key, value] of Object.entries(patch)) {
    const metaKey = key.startsWith("sync_") || key === "last_sync_at" ? key : `sync_${key}`;
    entries.push([metaKey, value === null || value === undefined ? "" : String(value)]);
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
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_SYNC_PAGES, Math.floor(parsed)));
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

