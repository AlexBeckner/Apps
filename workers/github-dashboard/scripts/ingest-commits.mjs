#!/usr/bin/env node
// Ingest all-branch commit metadata (from `git log --all`) into the dashboard's
// Cloudflare D1 database.
//
// The Worker only syncs the default branch's commits via the REST API (that keeps
// the "Commits" tab fresh in near-real-time). This script fills in every commit on
// every OTHER branch so branch pages, PR pages, and search can surface work that
// never landed on the default branch. git already has the complete commit graph
// locally, so one `git log --all` is far cheaper than paginating the REST API for
// tens of thousands of branches.
//
// Design:
//   - Metadata only: sha, short sha, author, dates, subject, url. The full commit
//     MESSAGE body is intentionally NOT stored here (keeps D1 lean); the Worker
//     lazily fetches + caches the body the first time a commit detail is viewed.
//   - No parent/DAG edges: the commit_parents table was dropped to fit D1's 500 MB
//     free-plan cap. off-branch commits are inserted with on_default = 0 (the
//     Worker owns the on_default flag for the default branch); branch pages fetch
//     their commit lists live from GitHub instead of walking a stored DAG.
//   - INSERT ... ON CONFLICT DO NOTHING: never clobber the richer rows the Worker
//     writes for default-branch commits (which include the full message + on_default).
//   - Incremental: a `commit_git_synced_at` watermark in D1 limits each run to
//     commits since the last run (with an overlap window). The first run (no
//     watermark, or FULL=1) ingests the entire history.
//
// Env:
//   CF_API_TOKEN     Cloudflare API token with D1 edit permission (required)
//   CF_ACCOUNT_ID    Cloudflare account id (required)
//   D1_DATABASE_ID   D1 database id (required)
//   REPO_DIR         Path to a git clone/bare repo of the target repo (required)
//   GITHUB_REPO      "owner/name" used to build commit URLs (required)
//   DEFAULT_BRANCH   Default branch name (optional; enables default_commit_count)
//   FULL             "1"/"true" to force a full re-ingest, ignoring the watermark
//   OVERLAP_DAYS     Incremental safety overlap in days (default 2)
//   DRY_RUN          "1"/"true" to parse + preview SQL without touching D1

import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

const COMMIT_BATCH = 200;
const US = "\x1f"; // unit separator between git log fields
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const FULL = /^(1|true|yes)$/i.test(process.env.FULL || "");
// Manual window override (e.g. SINCE="2 days ago" or an ISO date). Passed straight
// to `git log --since`; skips the D1 watermark on both read and write so a manual
// re-ingest can't corrupt the incremental cursor.
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
const REPO_DIR = required("REPO_DIR");
const GITHUB_REPO = required("GITHUB_REPO");
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "";
const [OWNER, REPO] = GITHUB_REPO.split("/");
const COMMIT_URL_BASE = `https://github.com/${OWNER}/${REPO}/commit/`;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

// SQLite string literal. Strip control chars (incl. our US delimiter) and double
// single quotes. Author names / subjects are the only free-form inputs here.
function sqlStr(value) {
  const clean = String(value).replace(/[\u0000-\u001f]/g, "");
  return `'${clean.replace(/'/g, "''")}'`;
}

function nullableStr(value) {
  const clean = String(value ?? "").replace(/[\u0000-\u001f]/g, "");
  return clean ? `'${clean.replace(/'/g, "''")}'` : "NULL";
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

// Count commits reachable from a ref, e.g. the default branch. Returns null if
// git can't resolve it.
function gitCount(ref) {
  const res = spawnSync(
    "git",
    ["-C", REPO_DIR, "rev-list", "--count", ref],
    { encoding: "utf8" }
  );
  if (res.status !== 0) return null;
  const n = Number.parseInt((res.stdout || "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseLine(line) {
  const parts = line.split(US);
  if (parts.length < 7) return null;
  const [sha, short, an, ae, at, ct] = parts;
  const subject = parts.slice(6).join(US);
  if (!SHA_RE.test(sha)) return null;
  const authoredAt = Number.parseInt(at, 10);
  const committedAt = Number.parseInt(ct, 10);
  return {
    sha,
    short: short || sha.slice(0, 7),
    authorName: an || "",
    authorEmail: ae || "",
    authoredAt: Number.isFinite(authoredAt) ? authoredAt : null,
    committedAt: Number.isFinite(committedAt) ? committedAt : null,
    subject: subject || "",
  };
}

async function flush(batch) {
  if (!batch.length) return;
  const values = batch
    .map(
      (c) =>
        `(${sqlStr(c.sha)}, ${sqlStr(c.short)}, ${nullableStr(c.authorName)}, ` +
        `${nullableStr(c.authorEmail)}, ${c.authoredAt ?? "NULL"}, ${c.committedAt ?? "NULL"}, ` +
        `${nullableStr(c.subject)}, NULL, ${sqlStr(COMMIT_URL_BASE + c.sha)})`
    )
    .join(",");
  // on_default is left at its column default (0); the Worker owns that flag for
  // the default branch. message stays NULL (lazy-fetched on first view).
  await d1(
    `INSERT INTO commits (sha, short_sha, author_name, author_email, authored_at, committed_at, summary, message, url) ` +
      `VALUES ${values} ON CONFLICT(sha) DO NOTHING;`
  );
}

async function setMeta(key, value) {
  await d1(
    `INSERT INTO meta (key, value) VALUES ('${key}', '${value}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );
}

async function main() {
  const runStart = Math.floor(Date.now() / 1000);

  // Resolve the --since window. Precedence: FULL (none) > SINCE override > watermark.
  let sinceArg = null;
  if (!FULL) {
    if (SINCE_OVERRIDE) {
      sinceArg = SINCE_OVERRIDE;
    } else {
      const rows = await d1Select(
        `SELECT value FROM meta WHERE key = 'commit_git_synced_at' LIMIT 1;`
      );
      const prev = Number.parseInt(rows?.[0]?.value ?? "", 10);
      if (Number.isFinite(prev)) {
        sinceArg = new Date(Math.max(0, prev - OVERLAP_SECONDS) * 1000).toISOString();
      }
    }
  }
  const isFull = sinceArg === null;

  const logArgs = ["-C", REPO_DIR, "log", "--all", "--no-color"];
  if (sinceArg) logArgs.push(`--since=${sinceArg}`);
  logArgs.push(
    "--pretty=tformat:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s"
  );

  console.log(
    isFull
      ? "Enumerating full commit history (git log --all)..."
      : `Enumerating commits since ${sinceArg}...`
  );

  const child = spawn("git", logArgs, { stdio: ["ignore", "pipe", "inherit"] });
  child.on("error", (error) => {
    console.error(`Failed to run git: ${error.message}`);
    process.exit(1);
  });
  // Attach the close listener BEFORE consuming stdout. The final flush() below
  // awaits on D1 network I/O, during which git can exit and emit 'close'. If we
  // only started listening after the loop we'd miss an already-fired event and
  // hang until the job timeout (inserting every commit but never writing meta).
  const closed = new Promise((resolve) => child.on("close", resolve));
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  let buf = [];
  let total = 0;
  let ingested = 0;
  for await (const line of rl) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    buf.push(parsed);
    total++;
    if (buf.length >= COMMIT_BATCH) {
      await flush(buf);
      ingested += buf.length;
      buf = [];
      if (ingested % 5000 === 0) console.log(`Ingested ${ingested} commits...`);
    }
  }
  await flush(buf);
  ingested += buf.length;

  const code = await closed;
  if (code !== 0) {
    console.error(`git log exited with code ${code}`);
    process.exit(1);
  }

  // Safety valve: a full run that finds zero commits means git produced nothing
  // (bad clone / auth). Abort so we don't overwrite the watermark misleadingly.
  if (isFull && total === 0) {
    console.error("Full run parsed 0 commits; aborting without updating watermark.");
    process.exit(1);
  }

  // A manual SINCE window must not move the incremental cursor (it would make the
  // next scheduled run skip everything older than the window).
  if (!SINCE_OVERRIDE) {
    await setMeta("commit_git_synced_at", String(runStart));
  }
  await setMeta("commit_git_last_run_count", String(total));

  const totalCount = gitCount("--all");
  if (totalCount !== null) await setMeta("commit_total_count", String(totalCount));
  const defCount = DEFAULT_BRANCH ? gitCount(DEFAULT_BRANCH) : null;
  if (defCount !== null) await setMeta("default_commit_count", String(defCount));

  console.log(
    `Done: enumerated ${total} commits (${isFull ? "full" : "incremental"}), ` +
      `default_commit_count=${defCount ?? "n/a"}, commit_total_count=${totalCount ?? "n/a"}.`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
