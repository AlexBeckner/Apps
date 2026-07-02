#!/usr/bin/env node
// Ingest the full tag list (from `git for-each-ref refs/tags`) into the
// dashboard's Cloudflare D1 database. Runs in the same workflow as the commit
// ingest, reusing its blobless clone (which now also fetches refs/tags/*).
//
// git gives the COMPLETE, authoritative tag list in one shot, so this is a simple
// snapshot upsert + prune:
//   1. Upsert every tag (name, dereferenced target commit, annotated flag, date,
//      subject), reviving any previously-deleted tag that reappeared.
//   2. Mark any tag no longer present as deleted (diffed against the snapshot; the
//      tags table has no last_seen_at column, and tag counts are small).
//
// Env:
//   CF_API_TOKEN     Cloudflare API token with D1 edit permission (required)
//   CF_ACCOUNT_ID    Cloudflare account id (required)
//   D1_DATABASE_ID   D1 database id (required)
//   REPO_DIR         Path to a git clone/bare repo with refs/tags/* fetched (required)
//   DRY_RUN          "1"/"true" to preview without touching D1

import { spawnSync } from "node:child_process";

const UPSERT_BATCH = 500;
const DELETE_BATCH = 200;
const US = "\x1f"; // unit separator between for-each-ref fields
const SHA_RE = /^[0-9a-f]{7,64}$/i;
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
const REPO_DIR = required("REPO_DIR");

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

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
    const preview = sql.length > 240 ? `${sql.slice(0, 240)}...` : sql;
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

// One line per tag; only the last field (subject) is free-form. Fields:
// name, objecttype, objectname, *objectname (deref), creatordate:unix, subject.
function readTags() {
  const format =
    `%(refname:short)${US}%(objecttype)${US}%(objectname)${US}` +
    `%(*objectname)${US}%(creatordate:unix)${US}%(contents:subject)`;
  const res = spawnSync(
    "git",
    ["-C", REPO_DIR, "for-each-ref", `--format=${format}`, "refs/tags"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 }
  );
  if (res.status !== 0) {
    throw new Error(`git for-each-ref failed: ${res.stderr || res.status}`);
  }
  const tags = [];
  for (const line of (res.stdout || "").split("\n")) {
    if (!line) continue;
    const parts = line.split(US);
    if (parts.length < 5) continue;
    const [name, objType, objName, derefName, dateRaw] = parts;
    const subject = parts.slice(5).join(US);
    // Annotated tags dereference to the underlying commit (*objectname); a
    // lightweight tag already points straight at the commit (objectname).
    const targetSha = SHA_RE.test(derefName) ? derefName : objName;
    if (!name || !SHA_RE.test(targetSha)) continue;
    const date = Number.parseInt(dateRaw, 10);
    tags.push({
      name,
      targetSha,
      isAnnotated: objType === "tag" ? 1 : 0,
      taggedAt: Number.isFinite(date) ? date : null,
      message: subject || null,
    });
  }
  return tags;
}

async function main() {
  const tags = readTags();

  // Safety valve: never run the deletion diff on an empty snapshot.
  if (tags.length === 0) {
    console.error("No tags parsed from git; aborting without changes.");
    process.exit(1);
  }

  const runTs = Math.floor(Date.now() / 1000);
  console.log(`Parsed ${tags.length} tags; run_ts=${runTs}`);

  let upserted = 0;
  for (let i = 0; i < tags.length; i += UPSERT_BATCH) {
    const batch = tags.slice(i, i + UPSERT_BATCH);
    const values = batch
      .map(
        (t) =>
          `(${sqlStr(t.name)}, ${sqlStr(t.targetSha)}, ${t.isAnnotated}, ` +
          `${t.taggedAt ?? "NULL"}, ${nullableStr(t.message)}, ${runTs}, NULL)`
      )
      .join(",");
    await d1(
      `INSERT INTO tags (name, target_sha, is_annotated, tagged_at, message, first_seen_at, deleted_at) ` +
        `VALUES ${values} ` +
        `ON CONFLICT(name) DO UPDATE SET ` +
        `target_sha = excluded.target_sha, is_annotated = excluded.is_annotated, ` +
        `tagged_at = excluded.tagged_at, message = excluded.message, deleted_at = NULL;`
    );
    upserted += batch.length;
  }

  // Prune: mark any currently-live tag missing from this snapshot as deleted.
  const seen = new Set(tags.map((t) => t.name));
  const existing = await d1Select("SELECT name FROM tags WHERE deleted_at IS NULL;");
  const missing = existing.map((r) => r.name).filter((name) => !seen.has(name));
  let pruned = 0;
  for (let i = 0; i < missing.length; i += DELETE_BATCH) {
    const batch = missing.slice(i, i + DELETE_BATCH);
    const list = batch.map((name) => sqlStr(name)).join(",");
    const out = await d1(
      `UPDATE tags SET deleted_at = ${runTs} WHERE deleted_at IS NULL AND name IN (${list});`
    );
    pruned += out.meta?.changes ?? 0;
  }

  await d1(
    `INSERT INTO meta (key, value) VALUES ('tag_git_synced_at', '${runTs}') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );

  console.log(`Done: upserted ${upserted}, pruned ${pruned}, live ${tags.length}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
