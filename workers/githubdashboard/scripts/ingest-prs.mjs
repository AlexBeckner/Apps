#!/usr/bin/env node
// Ingest EVERY pull request into the dashboard's Cloudflare D1 database via the
// GitHub REST API.
//
// Why this exists: the Worker back-fills PRs by paginating the REST API a few
// pages per cron tick, but the free plan caps it at ~30 GitHub subrequests per
// invocation. For a repo with ~100k PRs that back-fill takes many hours and
// leaves the merged/closed counts badly understated in the meantime. A GitHub
// Action has the full 5,000 req/hour authenticated budget, so it can walk all
// ~1k pages in a single run.
//
// Design mirrors ingest-commits.mjs:
//   - Metadata only: the PR BODY is intentionally NOT stored (keeps D1 lean); the
//     Worker lazily fetches + caches it the first time a PR detail is viewed.
//   - INSERT ... ON CONFLICT(number) DO UPDATE: PRs mutate (state, merged_at,
//     labels, title), so unlike commits we refresh the mutable fields — but never
//     overwrite a body the Worker may have lazily cached.
//   - Incremental: a `pr_git_synced_at` watermark limits scheduled runs to PRs
//     updated since the last run (the API is walked sort=updated desc, so we can
//     stop as soon as a page falls entirely before the window). FULL=1 (or the
//     first run, with no watermark) walks every page to the end and, on reaching
//     it, marks seed_prs_complete=1 so the Worker stops its own slow back-fill.
//
// Env:
//   CF_API_TOKEN     Cloudflare API token with D1 edit permission (required)
//   CF_ACCOUNT_ID    Cloudflare account id (required)
//   D1_DATABASE_ID   D1 database id (required)
//   GITHUB_REPO      "owner/name" to sync PRs from (required)
//   GITHUB_TOKEN     GitHub token with pull-request read on the repo (required)
//   FULL             "1"/"true" to force a full walk, ignoring the watermark
//   SINCE            manual "since" (ISO) override; skips + preserves the watermark
//   OVERLAP_DAYS     incremental safety overlap in days (default 2)
//   DRY_RUN          "1"/"true" to preview without touching D1 or requiring creds

const PR_BATCH = 100; // PRs per D1 upsert statement
const PAGE_SIZE = 100; // GitHub max per_page for /pulls
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const FULL = /^(1|true|yes)$/i.test(process.env.FULL || "");
const SINCE_OVERRIDE = (process.env.SINCE || "").trim();
const OVERLAP_SECONDS =
  Math.max(0, Number.parseFloat(process.env.OVERLAP_DAYS || "2") || 2) * 86400;

function required(name) {
  const value = process.env[name];
  if (!value && !DRY_RUN) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value || "";
}

const CF_API_TOKEN = required("CF_API_TOKEN");
const CF_ACCOUNT_ID = required("CF_ACCOUNT_ID");
const D1_DATABASE_ID = required("D1_DATABASE_ID");
const GITHUB_REPO = required("GITHUB_REPO");
const GITHUB_TOKEN = required("GITHUB_TOKEN");
const [OWNER, REPO] = GITHUB_REPO.split("/");

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

function sqlStr(value) {
  const clean = String(value).replace(/[\u0000-\u001f]/g, "");
  return `'${clean.replace(/'/g, "''")}'`;
}

function nullableStr(value) {
  const clean = String(value ?? "").replace(/[\u0000-\u001f]/g, "");
  return clean ? `'${clean.replace(/'/g, "''")}'` : "NULL";
}

function toUnix(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function d1(sql) {
  if (DRY_RUN) {
    const preview = sql.length > 200 ? `${sql.slice(0, 200)}...` : sql;
    console.log(`[dry-run] ${preview}`);
    return { results: [], meta: { changes: 0 } };
  }
  const response = await fetch(D1_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    const detail = JSON.stringify(body.errors || body);
    throw new Error(`D1 query failed (${response.status}): ${detail}`);
  }
  return body.result?.[0] ?? { results: [], meta: {} };
}

async function d1Select(sql) {
  if (DRY_RUN && !CF_API_TOKEN) return [];
  const out = await d1(sql);
  return out.results || [];
}

async function setMeta(key, value) {
  await d1(
    `INSERT INTO meta (key, value) VALUES ('${key}', '${value}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );
}

// Fetch one page of PRs, retrying on transient throttling / 5xx.
async function fetchPrPage(page) {
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/pulls` +
    `?state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "githubdashboard-pr-ingest",
      },
    });
    if (res.ok) return res.json();

    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt > 5) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} on page ${page}: ${text.slice(0, 300)}`);
    }
    // Honor Retry-After / rate-limit reset when present, else exponential backoff.
    const retryAfter = Number.parseInt(res.headers.get("retry-after") || "", 10);
    const reset = Number.parseInt(res.headers.get("x-ratelimit-reset") || "", 10);
    let waitMs = 0;
    if (Number.isFinite(retryAfter)) waitMs = retryAfter * 1000;
    else if (Number.isFinite(reset)) waitMs = Math.max(0, reset * 1000 - Date.now());
    if (!waitMs) waitMs = Math.min(60000, 1000 * 2 ** attempt);
    console.warn(`GitHub ${res.status} on page ${page}; retry ${attempt} in ${Math.round(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function toRow(pr) {
  return {
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
  };
}

// Upsert a batch. body is intentionally omitted: new rows keep it NULL (lazy-
// fetched later) and existing rows keep whatever body the Worker cached.
async function flush(batch) {
  if (!batch.length) return;
  const values = batch
    .map(
      (p) =>
        `(${p.number}, ${nullableStr(p.title)}, ${sqlStr(p.state)}, ${nullableStr(p.author)}, ` +
        `${nullableStr(p.baseRef)}, ${nullableStr(p.headRef)}, ${nullableStr(p.headSha)}, ` +
        `${nullableStr(p.mergeCommitSha)}, ${p.createdAt ?? "NULL"}, ${p.updatedAt ?? "NULL"}, ` +
        `${p.mergedAt ?? "NULL"}, ${p.closedAt ?? "NULL"}, ${nullableStr(p.url)}, ${p.draft})`
    )
    .join(",");
  await d1(
    `INSERT INTO prs (number, title, state, author, base_ref, head_ref, head_sha, ` +
      `merge_commit_sha, created_at, updated_at, merged_at, closed_at, url, draft) ` +
      `VALUES ${values} ` +
      `ON CONFLICT(number) DO UPDATE SET ` +
      `title = excluded.title, state = excluded.state, author = excluded.author, ` +
      `base_ref = excluded.base_ref, head_ref = excluded.head_ref, head_sha = excluded.head_sha, ` +
      `merge_commit_sha = excluded.merge_commit_sha, updated_at = excluded.updated_at, ` +
      `merged_at = excluded.merged_at, closed_at = excluded.closed_at, url = excluded.url, ` +
      `draft = excluded.draft;`
  );
}

async function main() {
  const runStart = Math.floor(Date.now() / 1000);

  // Resolve the incremental window. Precedence: FULL (none) > SINCE > watermark.
  let sinceUnix = null;
  if (!FULL) {
    if (SINCE_OVERRIDE) {
      sinceUnix = toUnix(SINCE_OVERRIDE);
    } else {
      const rows = await d1Select(
        `SELECT value FROM meta WHERE key = 'pr_git_synced_at' LIMIT 1;`
      );
      const prev = Number.parseInt(rows?.[0]?.value ?? "", 10);
      if (Number.isFinite(prev)) sinceUnix = Math.max(0, prev - OVERLAP_SECONDS);
    }
  }
  const isFull = sinceUnix === null;

  console.log(
    isFull
      ? "Walking every pull request (full)..."
      : `Walking pull requests updated since ${new Date(sinceUnix * 1000).toISOString()}...`
  );

  let buf = [];
  let total = 0;
  let reachedEnd = false;
  let page = 1;

  for (;;) {
    const items = await fetchPrPage(page);
    if (!Array.isArray(items) || items.length === 0) {
      reachedEnd = true;
      break;
    }

    let pageOldestBeforeWindow = false;
    for (const pr of items) {
      if (!Number.isInteger(pr?.number)) continue;
      const row = toRow(pr);
      buf.push(row);
      total++;
      if (!isFull && sinceUnix !== null && (row.updatedAt ?? 0) < sinceUnix) {
        pageOldestBeforeWindow = true;
      }
      if (buf.length >= PR_BATCH) {
        await flush(buf);
        buf = [];
      }
    }

    if (total % 2000 === 0 || page % 20 === 0) console.log(`Ingested ${total} PRs (page ${page})...`);

    // Last page (short) means we hit the end of the list.
    if (items.length < PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    // Incremental: sort=updated desc, so once a page drops before the window,
    // everything after it is older too.
    if (pageOldestBeforeWindow) break;
    page++;
  }
  await flush(buf);

  // Move the incremental cursor unless this was a manual SINCE window.
  if (!SINCE_OVERRIDE) await setMeta("pr_git_synced_at", String(runStart));
  await setMeta("pr_git_last_run_count", String(total));
  // A full walk that reached the end has every PR: let the Worker stop its own
  // slow REST back-fill (its fresh pass still keeps recently-updated PRs current).
  if (isFull && reachedEnd) await setMeta("seed_prs_complete", "1");

  console.log(
    `Done: upserted ${total} PRs (${isFull ? "full" : "incremental"}` +
      `${reachedEnd ? ", reached end" : ""}).`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
