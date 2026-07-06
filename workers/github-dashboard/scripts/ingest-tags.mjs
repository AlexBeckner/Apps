#!/usr/bin/env node
// Ingest the full tag list (from `git for-each-ref refs/tags`) into the
// dashboard's Cloudflare D1 database. Runs in the same workflow as the commit
// ingest, reusing its blobless clone (which now also fetches refs/tags/*).
//
// git gives the COMPLETE, authoritative tag list in one shot, so this is a simple
// snapshot upsert + prune:
//   1. Upsert every tag (name, dereferenced target commit, annotated flag, date,
//      tagger name/email, and the full annotation message), reviving any
//      previously-deleted tag that reappeared.
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
const RS = "\x1e"; // record separator between tags (a tag message may span newlines)
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

// Tag messages (annotated tag bodies) are multi-line, like PR descriptions, so
// unlike nullableStr this keeps newlines and tabs (both safe inside a SQLite
// string literal and JSON-escaped in the request body) and strips only the other
// control characters. A generous cap guards against a pathologically long body.
const MAX_MESSAGE_LEN = 16000;
function messageStr(value) {
  let clean = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+$/, "");
  if (clean.length > MAX_MESSAGE_LEN) clean = clean.slice(0, MAX_MESSAGE_LEN);
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

// One RS-terminated record per tag (RS, not newline, so a tag's multi-line
// message body doesn't break record parsing); US separates the fields. Fields:
// name, objecttype, objectname, *objectname (deref), creatordate:unix,
// taggername, taggeremail (trimmed), contents:subject, contents:body.
function readTags() {
  const format =
    `%(refname:short)${US}%(objecttype)${US}%(objectname)${US}` +
    `%(*objectname)${US}%(creatordate:unix)${US}` +
    `%(taggername)${US}%(taggeremail:trim)${US}` +
    `%(contents:subject)${US}%(contents:body)${RS}`;
  const res = spawnSync(
    "git",
    ["-C", REPO_DIR, "for-each-ref", `--format=${format}`, "refs/tags"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 }
  );
  if (res.status !== 0) {
    throw new Error(`git for-each-ref failed: ${res.stderr || res.status}`);
  }
  const tags = [];
  for (const raw of (res.stdout || "").split(RS)) {
    // git writes a newline after each record; it lands at the start of the next
    // RS-split chunk, so drop one leading newline before parsing.
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const parts = record.split(US);
    if (parts.length < 9) continue;
    const [name, objType, objName, derefName, dateRaw, taggerName, taggerEmail, subject] =
      parts;
    const body = parts.slice(8).join(US);
    // Annotated tags dereference to the underlying commit (*objectname); a
    // lightweight tag already points straight at the commit (objectname).
    const targetSha = SHA_RE.test(derefName) ? derefName : objName;
    if (!name || !SHA_RE.test(targetSha)) continue;
    const date = Number.parseInt(dateRaw, 10);
    const isAnnotated = objType === "tag";
    // Mirror a PR description: an annotated tag's full message is its subject +
    // body. Lightweight tags have no annotation of their own, so for-each-ref
    // reports the target commit's subject there; keep that as the fallback.
    const message = isAnnotated
      ? [subject, body].map((part) => (part || "").trimEnd()).filter(Boolean).join("\n\n")
      : subject || "";
    tags.push({
      name,
      targetSha,
      isAnnotated: isAnnotated ? 1 : 0,
      taggedAt: Number.isFinite(date) ? date : null,
      // Only annotated tags carry a tagger; lightweight tags leave it null.
      taggerName: isAnnotated ? taggerName || null : null,
      taggerEmail: isAnnotated ? taggerEmail || null : null,
      message: message || null,
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
          `${t.taggedAt ?? "NULL"}, ${nullableStr(t.taggerName)}, ${nullableStr(t.taggerEmail)}, ` +
          `${messageStr(t.message)}, ${runTs}, NULL)`
      )
      .join(",");
    await d1(
      `INSERT INTO tags (name, target_sha, is_annotated, tagged_at, tagger_name, tagger_email, message, first_seen_at, deleted_at) ` +
        `VALUES ${values} ` +
        `ON CONFLICT(name) DO UPDATE SET ` +
        `target_sha = excluded.target_sha, is_annotated = excluded.is_annotated, ` +
        `tagged_at = excluded.tagged_at, tagger_name = excluded.tagger_name, ` +
        `tagger_email = excluded.tagger_email, message = excluded.message, deleted_at = NULL;`
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
