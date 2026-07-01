#!/usr/bin/env node
// Ingest a full branch snapshot (produced by `git for-each-ref`) into the
// dashboard's Cloudflare D1 database.
//
// Because git gives us the COMPLETE, authoritative list of live branches in one
// shot (with head SHA + commit date), this is a simple mark-and-sweep every run:
//   1. Upsert every branch with last_seen_at = run timestamp.
//   2. Mark any branch not in this snapshot (last_seen_at < run) as deleted.
//
// Input: a TSV file, one line per branch: "<sha>\t<committerdate-unix>\t<name>".
// Env:
//   CF_API_TOKEN     Cloudflare API token with D1 edit permission (required)
//   CF_ACCOUNT_ID    Cloudflare account id (required)
//   D1_DATABASE_ID   D1 database id (required)
//   DEFAULT_BRANCH   Name of the repo default branch (optional, marks is_default)

import { readFileSync } from "node:fs";

const UPSERT_BATCH = 500;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
// DRY_RUN parses + builds SQL and logs a preview without calling D1.
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

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
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node ingest-branches.mjs <branches.tsv>");
  process.exit(1);
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

// SQLite string literal. Git refnames forbid control chars and backslashes, so
// doubling single quotes is sufficient; we still strip stray control chars.
function sqlStr(value) {
  const clean = String(value).replace(/[\u0000-\u001f]/g, "");
  return `'${clean.replace(/'/g, "''")}'`;
}

async function d1(sql) {
  if (DRY_RUN) {
    const preview = sql.length > 240 ? `${sql.slice(0, 240)}...` : sql;
    console.log(`[dry-run] ${preview}`);
    return { changes: 0 };
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
  return body.result?.[0]?.meta ?? {};
}

function parse(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const first = line.indexOf("\t");
    const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const sha = line.slice(0, first).trim();
    const dateRaw = line.slice(first + 1, second).trim();
    const name = line.slice(second + 1);
    if (!SHA_RE.test(sha) || !name) continue;
    const date = Number.parseInt(dateRaw, 10);
    rows.push({
      name,
      sha,
      committedAt: Number.isFinite(date) ? date : null,
      isDefault: name === DEFAULT_BRANCH ? 1 : 0,
    });
  }
  return rows;
}

async function main() {
  const rows = parse(readFileSync(inputPath, "utf8"));

  // Safety valve: never run the deletion sweep on an empty snapshot (that would
  // wipe every branch if the git fetch silently produced nothing).
  if (rows.length === 0) {
    console.error("No branches parsed from snapshot; aborting without changes.");
    process.exit(1);
  }

  const runTs = Math.floor(Date.now() / 1000);
  console.log(`Parsed ${rows.length} branches; run_ts=${runTs}`);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const values = batch
      .map(
        (b) =>
          `(${sqlStr(b.name)}, ${sqlStr(b.sha)}, ${b.isDefault}, ` +
          `${b.committedAt === null ? "NULL" : b.committedAt}, ${runTs}, ${runTs}, NULL)`
      )
      .join(",");
    const sql =
      `INSERT INTO branches (name, head_sha, is_default, last_commit_at, last_seen_at, first_seen_at, deleted_at) ` +
      `VALUES ${values} ` +
      `ON CONFLICT(name) DO UPDATE SET ` +
      `head_sha = excluded.head_sha, ` +
      `is_default = excluded.is_default, ` +
      `last_commit_at = excluded.last_commit_at, ` +
      `last_seen_at = excluded.last_seen_at, ` +
      `deleted_at = NULL;`;
    await d1(sql);
    upserted += batch.length;
    if (upserted % 5000 === 0 || upserted === rows.length) {
      console.log(`Upserted ${upserted}/${rows.length}`);
    }
  }

  const pruneMeta = await d1(
    `UPDATE branches SET deleted_at = ${runTs} ` +
      `WHERE deleted_at IS NULL AND is_default = 0 ` +
      `AND (last_seen_at IS NULL OR last_seen_at < ${runTs});`
  );
  const pruned = pruneMeta.changes ?? 0;

  await d1(
    `INSERT INTO meta (key, value) VALUES ('branch_external_synced_at', '${runTs}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );
  await d1(
    `INSERT INTO meta (key, value) VALUES ('branch_live_count', '${rows.length}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );

  console.log(`Done: upserted ${upserted}, pruned ${pruned}, live ${rows.length}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
