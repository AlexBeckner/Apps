import { requireCloudflareAccess } from "./access.js";

const BUILDKITE_API_BASE = "https://api.buildkite.com/v2";
const DEFAULT_ORG_SLUG = "mosaic";
const DEFAULT_DEPLOYMENT_PIPELINE = "core-stack-deployment-pipeline";
const DEFAULT_FLASHING_PIPELINE = "core-stack-aaos-flashing";
const GITHUB_OWNER = "AppliedNeuron";
const GITHUB_REPO = "core-stack";
const HISTORY_SIZE = 10;
const DEFAULT_CACHE_SECONDS = 10;
const BACKFILL_PER_PAGE = 100;
const DEFAULT_BACKFILL_PAGES = 50;
const MAX_BACKFILL_PAGES = 200;
const MAX_STALE_ACTIVE_RECHECKS = 10;
const AWAITING_DEPLOY = "awaiting_deploy";

const PR_NUMBER_RE = /\(#(\d+)\)/g;
const CANONICAL_RIG_RE = /^(?:cosmo|wanda|(?:rog|mce|dmx)\d{3})$/;
const AAOS_IMAGE_VERSION_RE = /(\d+)\.tgz/;
const PURE_DIGITS_RE = /^\d+$/;
const RIG_ALIASES = new Map([
  ["mce101", "cosmo"],
  ["mce102", "wanda"],
]);
const AAOS_VERSION_KEYS = new Set([
  "aaos_version",
  "aaos_build_number",
  "aaos_build",
  "flashing_version",
  "version",
]);
const HIDDEN_JOB_TYPES = new Set(["wait", "waiter"]);
const FINISHED_BUILD_STATES = new Set(["passed", "failed", "canceled", "skipped"]);
const ACTIVE_JOB_STATES = new Set([
  "accepted",
  "assigned",
  "creating",
  "limited",
  "limiting",
  "running",
  "scheduled",
  "timing_out",
]);
const NON_TERMINAL_STATES = [
  "creating",
  "scheduled",
  "running",
  "blocked",
  "blocked_failed",
  "failing",
  "canceling",
];
const IN_PROGRESS_STATES = new Set([
  "creating",
  "scheduled",
  "running",
  "blocked",
  "failing",
  "canceling",
  AWAITING_DEPLOY,
]);

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, env),
        });
      }

      const accessError = await requireCloudflareAccess(request, env);
      if (accessError) {
        return accessError;
      }

      await ensureSchema(env);

      const originError = validateOrigin(request, env);
      if (originError) {
        return jsonResponse(
          request,
          env,
          { error: originError },
          { status: 403 }
        );
      }

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(dashboardHtml(), request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse(request, env, await handleHealth(env));
      }
      if (request.method === "GET" && url.pathname === "/api/sources") {
        return jsonResponse(request, env, { default: defaultSourceKey(env), sources: sourceSummaries(env) });
      }
      if (request.method === "GET" && url.pathname === "/api/client-context") {
        return jsonResponse(request, env, {
          is_operator: requestCanWrite(request, env),
          restrict_writes_to_localhost: false,
          write_auth: env.ADMIN_TOKEN ? "admin_token" : "disabled",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/stats") {
        const source = resolveSource(env, url.searchParams.get("source"));
        return jsonResponse(request, env, await storeStats(env, source.key));
      }
      if (request.method === "GET" && url.pathname === "/api/known-rigs") {
        return jsonResponse(request, env, {
          rigs: await knownRigs(env),
          source: "cloudflare-d1",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/rigs") {
        const source = resolveSource(env, url.searchParams.get("source"));
        const historySize = snapshotHistorySize(url);
        return jsonResponse(
          request,
          env,
          await getSnapshot(env, source, { force: false, historySize })
        );
      }

      const historyMatch = url.pathname.match(/^\/api\/rigs\/([^/]+)\/history$/);
      if (request.method === "GET" && historyMatch) {
        const source = resolveSource(env, url.searchParams.get("source"));
        const force = parseBoolean(url.searchParams.get("force_refresh")) && requestCanWrite(request, env);
        return jsonResponse(
          request,
          env,
          await getRigHistory(env, source, decodeURIComponent(historyMatch[1]), { force })
        );
      }

      const rigMatch = url.pathname.match(/^\/api\/rigs\/([^/]+)$/);
      if (request.method === "GET" && rigMatch) {
        const source = resolveSource(env, url.searchParams.get("source"));
        const snapshot = await getSnapshot(env, source, { force: false });
        const rigName = normalizeRig(decodeURIComponent(rigMatch[1]));
        const rig = snapshot.rigs.find((item) => item.name === rigName);
        if (!rig) {
          return jsonResponse(
            request,
            env,
            { detail: `No recent deploys found for rig '${rigName}'` },
            { status: 404 }
          );
        }
        return jsonResponse(request, env, rig);
      }

      const attemptsMatch = url.pathname.match(/^\/api\/builds\/(\d+)\/attempts$/);
      if (request.method === "GET" && attemptsMatch) {
        const source = resolveSource(env, url.searchParams.get("source"));
        const force = parseBoolean(url.searchParams.get("force_refresh")) && requestCanWrite(request, env);
        return jsonResponse(
          request,
          env,
          await getBuildAttempts(env, source, Number(attemptsMatch[1]), { force })
        );
      }

      if (request.method === "POST" && url.pathname === "/api/refresh") {
        const authError = requireWrite(request, env);
        if (authError) return jsonResponse(request, env, { detail: authError }, { status: 403 });
        const source = resolveSource(env, url.searchParams.get("source"));
        const historySize = snapshotHistorySize(url);
        return jsonResponse(
          request,
          env,
          await getSnapshot(env, source, { force: true, historySize })
        );
      }

      if (request.method === "POST" && url.pathname === "/api/backfill") {
        const authError = requireWrite(request, env);
        if (authError) return jsonResponse(request, env, { detail: authError }, { status: 403 });
        const source = resolveSource(env, url.searchParams.get("source"));
        const maxPages = normalizePageCap(url.searchParams.get("max_pages"));
        return jsonResponse(request, env, await backfill(env, source, maxPages));
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
    ctx.waitUntil(refreshAllSources(env));
  },
};

async function handleHealth(env) {
  const sources = [];
  for (const source of configuredSources(env)) {
    const stats = await storeStats(env, source.key);
    sources.push({
      ...sourceSummary(source, source.key === defaultSourceKey(env)),
      db_total_builds: stats.total_builds,
      last_event_at: stats.last_event_at,
      last_refresh_at: await getMeta(env, metaKey(source.key, "last_refresh_at")),
    });
  }

  const primary = sources[0];
  return {
    status: "ok",
    organization_slug: primary?.organization_slug || DEFAULT_ORG_SLUG,
    pipeline_slug: primary?.pipeline_slug || DEFAULT_DEPLOYMENT_PIPELINE,
    pipeline_url: primary?.pipeline_url || pipelineUrl(DEFAULT_ORG_SLUG, DEFAULT_DEPLOYMENT_PIPELINE),
    snapshot_size: snapshotSize(env),
    cache_seconds: cacheSeconds(env),
    rigs_dir: null,
    db_path: "cloudflare-d1",
    db_total_builds: primary?.db_total_builds || 0,
    restrict_writes_to_localhost: false,
    default_source: defaultSourceKey(env),
    sources,
  };
}

async function refreshAllSources(env) {
  await ensureSchema(env);
  const errors = [];
  for (const source of configuredSources(env)) {
    try {
      await refreshSource(env, source);
    } catch (error) {
      errors.push(`${source.key}: ${error.message || error}`);
    }
  }
  if (errors.length) {
    throw new Error(errors.join("; "));
  }
}

async function getSnapshot(env, source, { force, historySize = HISTORY_SIZE }) {
  const errors = [];
  let rateLimitedUntil = null;
  const stale = await sourceNeedsRefresh(env, source.key);

  if ((force || stale) && env.BUILDKITE_API_TOKEN) {
    const refresh = await refreshSource(env, source);
    errors.push(...refresh.errors);
    rateLimitedUntil = refresh.rate_limited_until;
  } else if ((force || stale) && !env.BUILDKITE_API_TOKEN) {
    errors.push("Worker secret BUILDKITE_API_TOKEN is not configured.");
  }

  const aggregate = await aggregateSnapshot(env, source.key, historySize);
  const fetchedAt =
    Number(await getMeta(env, metaKey(source.key, "last_refresh_at"))) ||
    Math.floor(Date.now() / 1000);
  return {
    rigs: aggregate.rigs,
    fetched_at: fetchedAt,
    pipeline_url: pipelineUrl(source.organization_slug, source.pipeline_slug),
    organization_slug: source.organization_slug,
    pipeline_slug: source.pipeline_slug,
    unassigned_build_count: aggregate.unassigned_build_count,
    errors,
    rate_limited_until: rateLimitedUntil,
  };
}

async function refreshSource(env, source) {
  const errors = [];
  let rateLimitedUntil = null;
  let builds = [];

  try {
    builds = await fetchRecentBuilds(env, source);
  } catch (error) {
    errors.push(buildkiteErrorMessage(error));
    rateLimitedUntil = error.rateLimitedUntil || null;
  }

  if (builds.length) {
    const rescue = await refreshStaleActiveBuilds(env, source, builds);
    builds = builds.concat(rescue.builds);
    errors.push(...rescue.errors);
    if (!rateLimitedUntil && rescue.rate_limited_until) {
      rateLimitedUntil = rescue.rate_limited_until;
    }
    await saveBuildsWithSummary(env, source.key, builds);
  }

  await setMeta(env, metaKey(source.key, "last_refresh_at"), String(Math.floor(Date.now() / 1000)));
  await setMeta(env, metaKey(source.key, "last_refresh_errors"), JSON.stringify(errors));
  return { errors, rate_limited_until: rateLimitedUntil };
}

async function fetchRecentBuilds(env, source) {
  return buildkiteJson(env, `${buildsUrl(source)}?${new URLSearchParams({
    per_page: String(snapshotSize(env)),
    page: "1",
    include_retried_jobs: "true",
  })}`);
}

async function fetchBuildDetail(env, source, buildNumber) {
  return buildkiteJson(env, `${buildsUrl(source)}/${buildNumber}?include_retried_jobs=true`);
}

async function buildkiteJson(env, url) {
  if (!env.BUILDKITE_API_TOKEN) {
    throw httpError(500, "Worker secret BUILDKITE_API_TOKEN is not configured.");
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${env.BUILDKITE_API_TOKEN}`,
      "User-Agent": "rig-deployment-dashboard-worker/0.1",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = httpError(response.status, `${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    error.bodyText = text;
    error.rateLimitedUntil = response.status === 429 ? parseRateLimitReset(response, text) : null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(502, "Unexpected Buildkite response shape: invalid JSON");
  }
}

async function refreshStaleActiveBuilds(env, source, snapshotBuilds) {
  const snapshotNumbers = new Set(
    snapshotBuilds
      .map((build) => build?.number)
      .filter((number) => Number.isInteger(number))
  );
  const activeNumbers = await getActiveBuildNumbers(env, source.key, MAX_STALE_ACTIVE_RECHECKS);
  const builds = [];
  const errors = [];
  let rateLimitedUntil = null;

  for (const number of activeNumbers) {
    if (snapshotNumbers.has(number)) continue;
    try {
      builds.push(await fetchBuildDetail(env, source, number));
    } catch (error) {
      errors.push(buildkiteErrorMessage(error));
      if (!rateLimitedUntil && error.rateLimitedUntil) {
        rateLimitedUntil = error.rateLimitedUntil;
      }
      if (error.rateLimitedUntil) break;
    }
  }

  return { builds, errors, rate_limited_until: rateLimitedUntil };
}

async function backfill(env, source, maxPages) {
  const cap = Math.max(1, Math.min(maxPages || DEFAULT_BACKFILL_PAGES, MAX_BACKFILL_PAGES));
  let pagesFetched = 0;
  let buildsSeen = 0;
  let buildsWritten = 0;
  let buildsNew = 0;
  let buildsUpdated = 0;
  let buildsUnchanged = 0;
  const errors = [];
  let rateLimitedUntil = null;
  let stoppedReason = "completed";

  for (let page = 1; page <= cap; page += 1) {
    let data;
    try {
      data = await buildkiteJson(env, `${buildsUrl(source)}?${new URLSearchParams({
        per_page: String(BACKFILL_PER_PAGE),
        page: String(page),
        include_retried_jobs: "true",
      })}`);
    } catch (error) {
      errors.push(`Buildkite API returned on page ${page}: ${error.message || error}`);
      stoppedReason = error.rateLimitedUntil ? "rate_limited" : "http_error";
      rateLimitedUntil = error.rateLimitedUntil || null;
      break;
    }

    if (!Array.isArray(data)) {
      errors.push(`Unexpected Buildkite response shape on page ${page}: ${typeof data}`);
      stoppedReason = "bad_response";
      break;
    }

    pagesFetched += 1;
    if (!data.length) {
      stoppedReason = "empty_page";
      break;
    }

    buildsSeen += data.length;
    const summary = await saveBuildsWithSummary(env, source.key, data);
    buildsWritten += summary.total;
    buildsNew += summary.new;
    buildsUpdated += summary.updated;
    buildsUnchanged += summary.unchanged;

    if (data.length < BACKFILL_PER_PAGE) {
      stoppedReason = "end_of_history";
      break;
    }
    if (summary.new === 0 && summary.updated === 0) {
      stoppedReason = "caught_up";
      break;
    }
  }

  await setMeta(env, metaKey(source.key, "last_refresh_at"), String(Math.floor(Date.now() / 1000)));

  return {
    ok: errors.length === 0,
    stopped_reason: stoppedReason,
    pages_fetched: pagesFetched,
    builds_seen: buildsSeen,
    builds_written: buildsWritten,
    builds_new: buildsNew,
    builds_updated: buildsUpdated,
    builds_unchanged: buildsUnchanged,
    errors,
    rate_limited_until: rateLimitedUntil,
    max_pages: cap,
    stats: await storeStats(env, source.key),
  };
}

async function getRigHistory(env, source, rigName, { force }) {
  const normalized = normalizeRig(rigName);
  if (!normalized) {
    throw httpError(400, "rig_name must not be empty");
  }

  const snapshot = await getSnapshot(env, source, { force });
  const stored = await getRigBuilds(env, source.key, normalized);
  const merged = new Map();
  for (const build of stored) {
    if (Number.isInteger(build?.number)) merged.set(build.number, build);
  }

  const snapshotBuilds = await getLatestBuildRows(env, source.key, HISTORY_SIZE * 100);
  for (const build of snapshotBuilds) {
    if (extractRig(build) === normalized && Number.isInteger(build?.number)) {
      merged.set(build.number, build);
    }
  }

  const deploys = [...merged.values()]
    .map((build) => buildToDeploy(build, source.key))
    .sort((left, right) => compareDesc(left.last_event_at, right.last_event_at));

  return {
    rig: normalized,
    deploys,
    stats: computeStats(deploys),
    source: "local_history",
    fetched_at: Math.floor(Date.now() / 1000),
    errors: snapshot.errors,
    rate_limited_until: snapshot.rate_limited_until,
  };
}

async function getBuildAttempts(env, source, buildNumber, { force }) {
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw httpError(400, "build_number must be a positive integer");
  }

  let raw = force ? null : await getBuild(env, source.key, buildNumber);
  const errors = [];
  let rateLimitedUntil = null;
  if (!raw || !Array.isArray(raw.jobs) || finishedBuildHasActiveJobs(raw)) {
    try {
      raw = await fetchBuildDetail(env, source, buildNumber);
      await saveBuildsWithSummary(env, source.key, [raw]);
    } catch (error) {
      errors.push(buildkiteErrorMessage(error));
      rateLimitedUntil = error.rateLimitedUntil || null;
    }
  }

  if (!raw) {
    return {
      build_number: buildNumber,
      build_url: "",
      rig: null,
      state: "unknown",
      branch: "",
      commit: "",
      commit_short: "",
      jobs: [],
      fetched_at: Math.floor(Date.now() / 1000),
      errors,
      rate_limited_until: rateLimitedUntil,
    };
  }

  return {
    ...buildToAttempts(raw),
    errors,
    rate_limited_until: rateLimitedUntil,
  };
}

async function aggregateSnapshot(env, sourceKey, historySize) {
  const latestByRig = await getLatestPerRig(env, sourceKey, historySize);
  const totals = await rigTotals(env, sourceKey);
  const rigs = [];

  for (const [name, builds] of latestByRig.entries()) {
    if (!isCanonicalRig(name)) continue;
    const deploys = builds
      .map((build) => buildToDeploy(build, sourceKey))
      .sort((left, right) => compareDesc(left.last_event_at, right.last_event_at));
    rigs.push({
      name,
      history: deploys.slice(0, historySize),
      total_deploys: totals.get(name) || deploys.length,
      last_deploy_at: deploys[0]?.last_event_at || null,
    });
  }

  rigs.sort((left, right) => compareDesc(left.last_deploy_at || "", right.last_deploy_at || ""));
  return {
    rigs,
    unassigned_build_count: Number(await getMeta(env, metaKey(sourceKey, "unassigned_build_count"))) || 0,
  };
}

async function saveBuildsWithSummary(env, sourceKey, builds) {
  const rows = [];
  let unassigned = 0;
  for (const build of builds) {
    if (!build || typeof build !== "object") continue;
    const number = build.number;
    if (!Number.isInteger(number) || number <= 0) continue;
    const rig = extractRig(build);
    if (!rig) unassigned += 1;
    rows.push({
      source: sourceKey,
      build_number: number,
      rig,
      state: deriveState(build),
      created_at: stringOrNull(build.created_at),
      last_event_at: lastEventAt(build) || null,
      raw_json: JSON.stringify(build),
    });
  }

  if (!rows.length) {
    return { total: 0, new: 0, updated: 0, unchanged: 0 };
  }

  const existing = await existingBuildState(env, sourceKey, rows.map((row) => row.build_number));
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  for (const row of rows) {
    const prior = existing.get(row.build_number);
    if (!prior) {
      newCount += 1;
    } else if (prior.state !== row.state || prior.last_event_at !== row.last_event_at) {
      updatedCount += 1;
    } else {
      unchangedCount += 1;
    }
  }

  const now = Date.now() / 1000;
  for (const chunk of chunked(rows, 10)) {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunk.flatMap((row) => [
      row.source,
      row.build_number,
      row.rig,
      row.state,
      row.created_at,
      row.last_event_at,
      row.raw_json,
      now,
      now,
    ]);
    await env.DB.prepare(
      `INSERT INTO builds (
        source, build_number, rig, state, created_at, last_event_at,
        raw_json, stored_at, updated_at
      ) VALUES ${placeholders}
      ON CONFLICT(source, build_number) DO UPDATE SET
        rig = excluded.rig,
        state = excluded.state,
        created_at = excluded.created_at,
        last_event_at = excluded.last_event_at,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`
    ).bind(...values).run();
  }

  await setMeta(env, metaKey(sourceKey, "unassigned_build_count"), String(unassigned));
  return {
    total: rows.length,
    new: newCount,
    updated: updatedCount,
    unchanged: unchangedCount,
  };
}

async function existingBuildState(env, sourceKey, numbers) {
  const out = new Map();
  for (const chunk of chunked(numbers, 90)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `SELECT build_number, state, last_event_at
       FROM builds
       WHERE source = ? AND build_number IN (${placeholders})`
    ).bind(sourceKey, ...chunk).all();
    for (const row of result.results || []) {
      out.set(Number(row.build_number), {
        state: row.state || null,
        last_event_at: row.last_event_at || null,
      });
    }
  }
  return out;
}

async function getLatestPerRig(env, sourceKey, historySize) {
  const result = await env.DB.prepare(
    `SELECT rig, raw_json
     FROM (
       SELECT
         rig,
         raw_json,
         ROW_NUMBER() OVER (
           PARTITION BY rig
           ORDER BY last_event_at DESC, build_number DESC
         ) AS rn
       FROM builds
       WHERE source = ? AND rig IS NOT NULL
     ) sub
     WHERE rn <= ?
     ORDER BY rig, rn`
  ).bind(sourceKey, historySize).all();

  const out = new Map();
  for (const row of result.results || []) {
    const build = decodeRawBuild(row.raw_json);
    if (!build) continue;
    if (!out.has(row.rig)) out.set(row.rig, []);
    out.get(row.rig).push(build);
  }
  return out;
}

async function getLatestBuildRows(env, sourceKey, limit) {
  const result = await env.DB.prepare(
    `SELECT raw_json
     FROM builds
     WHERE source = ?
     ORDER BY last_event_at DESC, build_number DESC
     LIMIT ?`
  ).bind(sourceKey, limit).all();
  return (result.results || []).map((row) => decodeRawBuild(row.raw_json)).filter(Boolean);
}

async function getRigBuilds(env, sourceKey, rig) {
  const result = await env.DB.prepare(
    `SELECT raw_json
     FROM builds
     WHERE source = ? AND rig = ?
     ORDER BY last_event_at DESC, build_number DESC`
  ).bind(sourceKey, rig).all();
  return (result.results || []).map((row) => decodeRawBuild(row.raw_json)).filter(Boolean);
}

async function getBuild(env, sourceKey, buildNumber) {
  const row = await env.DB.prepare(
    `SELECT raw_json FROM builds WHERE source = ? AND build_number = ?`
  ).bind(sourceKey, buildNumber).first();
  return row ? decodeRawBuild(row.raw_json) : null;
}

async function getActiveBuildNumbers(env, sourceKey, limit) {
  const placeholders = NON_TERMINAL_STATES.map(() => "?").join(", ");
  const result = await env.DB.prepare(
    `SELECT build_number
     FROM builds
     WHERE source = ? AND state IN (${placeholders})
     ORDER BY last_event_at DESC, build_number DESC
     LIMIT ?`
  ).bind(sourceKey, ...NON_TERMINAL_STATES, limit).all();
  return (result.results || []).map((row) => Number(row.build_number)).filter(Number.isInteger);
}

async function rigTotals(env, sourceKey) {
  const result = await env.DB.prepare(
    `SELECT rig, COUNT(*) AS total
     FROM builds
     WHERE source = ? AND rig IS NOT NULL
     GROUP BY rig`
  ).bind(sourceKey).all();
  return new Map((result.results || []).map((row) => [row.rig, Number(row.total || 0)]));
}

async function knownRigs(env) {
  const result = await env.DB.prepare(
    `SELECT DISTINCT rig
     FROM builds
     WHERE rig IS NOT NULL
     ORDER BY rig`
  ).all();
  return (result.results || [])
    .map((row) => row.rig)
    .filter((rig) => rig && isCanonicalRig(rig));
}

async function storeStats(env, sourceKey) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total_builds,
       COUNT(DISTINCT rig) AS total_rigs,
       MIN(last_event_at) AS first_event_at,
       MAX(last_event_at) AS last_event_at
     FROM builds
     WHERE source = ?`
  ).bind(sourceKey).first();
  return {
    enabled: true,
    total_builds: Number(row?.total_builds || 0),
    total_rigs: Number(row?.total_rigs || 0),
    first_event_at: row?.first_event_at || null,
    last_event_at: row?.last_event_at || null,
    db_path: "cloudflare-d1",
  };
}

async function countBuilds(env, sourceKey) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM builds WHERE source = ?`
  ).bind(sourceKey).first();
  return Number(row?.total || 0);
}

async function sourceNeedsRefresh(env, sourceKey) {
  if ((await countBuilds(env, sourceKey)) === 0) return true;
  const lastRefresh = Number(await getMeta(env, metaKey(sourceKey, "last_refresh_at"))) || 0;
  return Date.now() / 1000 - lastRefresh >= cacheSeconds(env);
}

async function ensureSchema(env) {
  if (!env.DB) {
    throw httpError(500, "D1 binding DB is not configured.");
  }
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS builds (
      source TEXT NOT NULL,
      build_number INTEGER NOT NULL,
      rig TEXT,
      state TEXT,
      created_at TEXT,
      last_event_at TEXT,
      raw_json TEXT NOT NULL,
      stored_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (source, build_number)
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_builds_source_rig_last_event
     ON builds(source, rig, last_event_at DESC)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_builds_source_last_event
     ON builds(source, last_event_at DESC)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_builds_source_state_last_event
     ON builds(source, state, last_event_at DESC)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at REAL NOT NULL
    )`
  ).run();
}

async function getMeta(env, key) {
  const row = await env.DB.prepare("SELECT value FROM metadata WHERE key = ?").bind(key).first();
  return row?.value || "";
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO metadata (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).bind(key, value, Date.now() / 1000).run();
}

function configuredSources(env) {
  const org = env.BUILDKITE_ORG_SLUG || DEFAULT_ORG_SLUG;
  const deploymentPipeline = env.BUILDKITE_PIPELINE_SLUG || DEFAULT_DEPLOYMENT_PIPELINE;
  const flashingPipeline = env.BUILDKITE_FLASHING_PIPELINE_SLUG || DEFAULT_FLASHING_PIPELINE;
  const sources = [
    {
      key: "deployment",
      label: "Deployments",
      organization_slug: org,
      pipeline_slug: deploymentPipeline,
      ref_label: "Branch",
    },
  ];
  if (!parseBoolean(env.DASHBOARD_DISABLE_FLASHING) && flashingPipeline) {
    sources.push({
      key: "flashing",
      label: "AAOS Flashing",
      organization_slug: org,
      pipeline_slug: flashingPipeline,
      ref_label: "AAOS Version",
    });
  }
  return sources;
}

function defaultSourceKey(env) {
  return configuredSources(env)[0].key;
}

function resolveSource(env, requested) {
  const sources = configuredSources(env);
  if (!requested) return sources[0];
  const found = sources.find((source) => source.key === requested);
  if (!found) throw httpError(400, `Unknown source: ${requested}`);
  return found;
}

function sourceSummaries(env) {
  const def = defaultSourceKey(env);
  return configuredSources(env).map((source) => sourceSummary(source, source.key === def));
}

function sourceSummary(source, isDefault) {
  return {
    key: source.key,
    label: source.label,
    organization_slug: source.organization_slug,
    pipeline_slug: source.pipeline_slug,
    pipeline_url: pipelineUrl(source.organization_slug, source.pipeline_slug),
    is_default: isDefault,
    ref_label: source.ref_label,
  };
}

function buildsUrl(source) {
  return `${BUILDKITE_API_BASE}/organizations/${encodeURIComponent(source.organization_slug)}/pipelines/${encodeURIComponent(source.pipeline_slug)}/builds`;
}

function pipelineUrl(org, pipeline) {
  return `https://buildkite.com/${org}/${pipeline}`;
}

function buildToDeploy(build, sourceKey) {
  const commit = String(build.commit || "");
  const commitMessage = String(build.message || "");
  const commitSubject = commitMessage.split(/\r?\n/, 1)[0] || "";
  const prNumber = parsePrNumber(commitMessage);
  const branch = String(build.branch || "");
  const triggered = triggeredBy(build);
  return {
    build_number: Number(build.number || 0),
    build_url: String(build.web_url || ""),
    state: deriveState(build),
    branch,
    branch_url: branch
      ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`
      : "",
    version: extractAaosVersion(build),
    commit,
    commit_short: shortSha(commit),
    commit_url: commit ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${commit}` : "",
    commit_message: commitMessage,
    commit_subject: commitSubject,
    pr_number: prNumber,
    pr_url: prNumber ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/${prNumber}` : null,
    created_at: String(build.created_at || ""),
    scheduled_at: stringOrNull(build.scheduled_at),
    started_at: stringOrNull(build.started_at),
    finished_at: stringOrNull(build.finished_at),
    last_event_at: lastEventAt(build),
    triggered_by: triggered.name,
    triggered_by_email: triggered.email,
    source: sourceKey,
  };
}

function buildToAttempts(build) {
  const commit = String(build.commit || "");
  const jobs = Array.isArray(build.jobs) ? build.jobs : [];
  return {
    build_number: Number(build.number || 0),
    build_url: String(build.web_url || ""),
    rig: extractRig(build),
    state: deriveState(build),
    branch: String(build.branch || ""),
    commit,
    commit_short: shortSha(commit),
    jobs: jobsToAttempts(jobs),
    fetched_at: Math.floor(Date.now() / 1000),
  };
}

function jobsToAttempts(jobs) {
  const attemptNumbers = buildAttemptChains(jobs);
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const jobType = String(job.type || "");
    if (HIDDEN_JOB_TYPES.has(jobType)) continue;
    const id = String(job.id || "");
    out.push(jobToAttempt(job, attemptNumbers.get(id) || 1));
  }
  return out;
}

function jobToAttempt(job, attemptNumber) {
  const retrySource = job.retry_source && typeof job.retry_source === "object" ? job.retry_source : {};
  const agent = job.agent && typeof job.agent === "object" ? job.agent : {};
  return {
    id: String(job.id || ""),
    name: jobDisplayName(job),
    step_key: job.step_key ? String(job.step_key) : null,
    type: String(job.type || "unknown"),
    state: String(job.state || "unknown"),
    web_url: stringOrNull(job.web_url),
    log_url: stringOrNull(job.log_url),
    created_at: stringOrNull(job.created_at),
    scheduled_at: stringOrNull(job.scheduled_at),
    started_at: stringOrNull(job.started_at),
    finished_at: stringOrNull(job.finished_at),
    duration_ms: jobDurationMs(job),
    exit_status: Number.isFinite(job.exit_status) ? Number(job.exit_status) : null,
    retried: Boolean(job.retried),
    retried_in_job_id: stringOrNull(job.retried_in_job_id),
    retries_count: Number.isFinite(job.retries_count) ? Number(job.retries_count) : 0,
    retry_source_job_id: retrySource.job_id ? String(retrySource.job_id) : null,
    retry_type: retrySource.retry_type ? String(retrySource.retry_type) : null,
    attempt_number: attemptNumber,
    agent_name: agent.name ? String(agent.name) : null,
  };
}

function buildAttemptChains(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    if (job && typeof job === "object" && job.id) {
      byId.set(String(job.id), job);
    }
  }
  const attempt = new Map();
  const resolve = (jobId, depth = 0) => {
    if (attempt.has(jobId)) return attempt.get(jobId);
    if (depth > 1000) {
      attempt.set(jobId, 1);
      return 1;
    }
    const job = byId.get(jobId);
    if (!job) {
      attempt.set(jobId, 1);
      return 1;
    }
    const retrySource = job.retry_source && typeof job.retry_source === "object" ? job.retry_source : {};
    if (!retrySource.job_id) {
      attempt.set(jobId, 1);
      return 1;
    }
    const n = resolve(String(retrySource.job_id), depth + 1) + 1;
    attempt.set(jobId, n);
    return n;
  };
  for (const id of byId.keys()) resolve(id);
  return attempt;
}

function deriveState(build) {
  const raw = String(build.state || "unknown");
  const jobs = build.jobs;
  if (Array.isArray(jobs)) {
    return jobs.some(isPendingProceedBlock) ? AWAITING_DEPLOY : raw;
  }
  return raw === "blocked" || raw === "blocked_failed" ? AWAITING_DEPLOY : raw;
}

function isPendingProceedBlock(job) {
  if (!job || typeof job !== "object") return false;
  if (job.type !== "manual" || job.state !== "blocked") return false;
  return !String(job.label || "").toLowerCase().includes("force unlock");
}

function finishedBuildHasActiveJobs(build) {
  if (!FINISHED_BUILD_STATES.has(String(build.state || ""))) return false;
  const jobs = build.jobs;
  return Array.isArray(jobs) && jobs.some((job) => ACTIVE_JOB_STATES.has(String(job?.state || "")));
}

function extractRig(build) {
  const meta = build.meta_data && typeof build.meta_data === "object" ? build.meta_data : {};
  if (meta.rig) {
    const normalized = normalizeRig(String(meta.rig));
    if (normalized) return normalized;
  }
  const env = build.env && typeof build.env === "object" ? build.env : {};
  if (env.RIG || env.rig) {
    const normalized = normalizeRig(String(env.RIG || env.rig));
    if (normalized) return normalized;
  }
  return null;
}

function normalizeRig(raw) {
  let normalized = String(raw || "").trim().toLowerCase().replace(/-/g, "");
  let previous = null;
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(/^['"]+|['"]+$/g, "");
  }
  return RIG_ALIASES.get(normalized) || normalized;
}

function isCanonicalRig(name) {
  return Boolean(name) && CANONICAL_RIG_RE.test(name);
}

function extractAaosVersion(build) {
  const mappings = [build.meta_data, build.env];
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    for (const value of Object.values(mapping)) {
      const match = AAOS_IMAGE_VERSION_RE.exec(String(value));
      if (match) return match[1];
    }
  }
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    const lowered = new Map(Object.entries(mapping).map(([key, value]) => [String(key).trim().toLowerCase(), value]));
    for (const key of AAOS_VERSION_KEYS) {
      const value = lowered.get(key);
      if (value != null && PURE_DIGITS_RE.test(String(value).trim())) {
        return String(value).trim();
      }
    }
  }
  const match = AAOS_IMAGE_VERSION_RE.exec(String(build.message || ""));
  return match ? match[1] : null;
}

function lastEventAt(build) {
  const candidates = [
    build.finished_at,
    build.started_at,
    build.scheduled_at,
    build.created_at,
  ].filter(Boolean).map(String);
  const jobs = Array.isArray(build.jobs) ? build.jobs : [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    for (const key of ["finished_at", "started_at", "scheduled_at", "created_at"]) {
      if (job[key]) candidates.push(String(job[key]));
    }
  }
  return candidates.sort().at(-1) || "";
}

function triggeredBy(build) {
  for (const key of ["creator", "author"]) {
    const person = build[key];
    if (person && typeof person === "object" && person.name) {
      return { name: String(person.name), email: person.email ? String(person.email) : null };
    }
  }
  const pullRequest = build.pull_request;
  if (pullRequest && typeof pullRequest === "object" && pullRequest.username) {
    return { name: String(pullRequest.username), email: null };
  }
  return { name: "unknown", email: null };
}

function parsePrNumber(message) {
  let found = null;
  for (const match of String(message || "").matchAll(PR_NUMBER_RE)) {
    found = Number(match[1]);
  }
  return Number.isInteger(found) ? found : null;
}

function computeStats(deploys) {
  const stats = { total: deploys.length, passed: 0, failed: 0, canceled: 0, in_progress: 0, other: 0 };
  for (const deploy of deploys) {
    if (deploy.state === "passed") stats.passed += 1;
    else if (deploy.state === "failed") stats.failed += 1;
    else if (deploy.state === "canceled") stats.canceled += 1;
    else if (IN_PROGRESS_STATES.has(deploy.state)) stats.in_progress += 1;
    else stats.other += 1;
  }
  return stats;
}

function jobDisplayName(job) {
  for (const key of ["name", "label", "step_key"]) {
    if (job[key]) return String(job[key]);
  }
  if (job.command) return String(job.command).split(/\r?\n/, 1)[0].slice(0, 80);
  return String(job.type || "(unnamed)");
}

function jobDurationMs(job) {
  if (!job.started_at || !job.finished_at) return null;
  const started = Date.parse(job.started_at);
  const finished = Date.parse(job.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return null;
  return finished - started;
}

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : "";
}

function stringOrNull(value) {
  return value ? String(value) : null;
}

function compareDesc(left, right) {
  return String(right || "").localeCompare(String(left || ""));
}

function decodeRawBuild(rawJson) {
  try {
    const value = JSON.parse(rawJson);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function parseRateLimitReset(response, bodyText) {
  const normalize = (value) => {
    const now = Date.now() / 1000;
    return value > now ? value : now + value;
  };
  try {
    const data = JSON.parse(bodyText);
    if (Number.isFinite(data?.reset) && data.reset > 0) return normalize(Number(data.reset));
  } catch {
    // Fall through to headers.
  }
  for (const header of ["RateLimit-Reset", "X-RateLimit-Reset"]) {
    const value = Number(response.headers.get(header));
    if (Number.isFinite(value) && value > 0) return normalize(value);
  }
  const retryAfter = Number(response.headers.get("Retry-After"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() / 1000 + retryAfter : null;
}

function buildkiteErrorMessage(error) {
  const status = Number.isInteger(error.status) ? error.status : "?";
  return `Buildkite API returned ${status}: ${error.bodyText || error.message || error}`.slice(0, 300);
}

function requestCanWrite(request, env) {
  if (parseBoolean(env.ALLOW_UNAUTHENTICATED_WRITES)) return true;
  if (!env.ADMIN_TOKEN) return false;
  const bearer = request.headers.get("Authorization") || "";
  const token = request.headers.get("X-Dashboard-Admin-Token") || "";
  return token === env.ADMIN_TOKEN || bearer === `Bearer ${env.ADMIN_TOKEN}`;
}

function requireWrite(request, env) {
  if (requestCanWrite(request, env)) return "";
  if (!env.ADMIN_TOKEN && !parseBoolean(env.ALLOW_UNAUTHENTICATED_WRITES)) {
    return "Write endpoints require ADMIN_TOKEN or ALLOW_UNAUTHENTICATED_WRITES=true.";
  }
  return "Not authorized.";
}

function validateOrigin(request, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  if (allowedOrigin === "*") return "";
  const origin = request.headers.get("Origin");
  if (!origin) return "";
  const allowedOrigins = allowedOrigin.split(",").map((value) => value.trim()).filter(Boolean);
  return allowedOrigins.includes(origin) ? "" : "Origin is not allowed.";
}

function corsHeaders(request, env) {
  const configuredOrigin = env.ALLOWED_ORIGIN || "*";
  const allowOrigin = configuredOrigin === "*"
    ? "*"
    : originForRequest(request, configuredOrigin);
  return {
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dashboard-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": allowOrigin,
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function originForRequest(request, configuredOrigin) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = configuredOrigin.split(",").map((value) => value.trim()).filter(Boolean);
  return origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "*";
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

function htmlResponse(html, request, env) {
  return new Response(html, {
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "text/html;charset=utf-8",
    },
  });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function snapshotSize(env) {
  const value = Number(env.SNAPSHOT_SIZE || 10);
  return Math.max(1, Math.min(100, Number.isFinite(value) ? Math.floor(value) : 10));
}

function snapshotHistorySize(url) {
  if (parseBoolean(url.searchParams.get("compact"))) return 1;
  const value = Number(url.searchParams.get("history_size") || HISTORY_SIZE);
  return Math.max(1, Math.min(HISTORY_SIZE, Number.isFinite(value) ? Math.floor(value) : HISTORY_SIZE));
}

function cacheSeconds(env) {
  const value = Number(env.CACHE_SECONDS || DEFAULT_CACHE_SECONDS);
  return Math.max(10, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CACHE_SECONDS);
}

function normalizePageCap(value) {
  const number = Number(value || DEFAULT_BACKFILL_PAGES);
  return Math.max(1, Math.min(MAX_BACKFILL_PAGES, Number.isFinite(number) ? Math.floor(number) : DEFAULT_BACKFILL_PAGES));
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function metaKey(sourceKey, name) {
  return `${sourceKey}:${name}`;
}

function chunked(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>buildkitedeploymentdashboard</title>
    <style>
      * { box-sizing: border-box; }
      body {
        background: #000;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        margin: 0;
      }
      main { margin: 0 auto; max-width: 1180px; padding: 24px 16px; }
      a { color: inherit; }
      header { align-items: baseline; display: flex; gap: 16px; justify-content: space-between; margin-bottom: 16px; }
      h1 { font-size: 22px; margin: 0; }
      p { color: #aaa; margin: 6px 0 0; }
      button, select { background: #000; border: 1px solid #333; color: #fff; padding: 8px 10px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #222; padding: 8px; text-align: left; vertical-align: top; }
      th { color: #aaa; font-weight: 500; }
      .muted { color: #aaa; }
      .error { border: 1px solid #633; color: #fbb; margin: 12px 0; padding: 12px; }
      .controls { align-items: center; display: flex; gap: 8px; }
      .state { color: #aaa; white-space: nowrap; }
      .state-passed { color: #8f8; }
      .state-failed, .state-canceled { color: #f99; }
      .state-running, .state-awaiting_deploy { color: #ff8; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>buildkitedeploymentdashboard</h1>
          <p id="subtitle">Loading deployments...</p>
        </div>
        <div class="controls">
          <select id="source"></select>
          <button id="reload" type="button">Reload</button>
        </div>
      </header>
      <div id="errors"></div>
      <table>
        <thead>
          <tr>
            <th>Rig</th>
            <th>State</th>
            <th id="refHeader">Branch</th>
            <th>Commit</th>
            <th>Build</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </main>
    <script>
      const sourceEl = document.getElementById("source");
      const rowsEl = document.getElementById("rows");
      const subtitleEl = document.getElementById("subtitle");
      const errorsEl = document.getElementById("errors");
      const refHeaderEl = document.getElementById("refHeader");
      let sources = [];
      let source = "";

      document.getElementById("reload").addEventListener("click", () => loadSnapshot());
      sourceEl.addEventListener("change", () => {
        source = sourceEl.value;
        loadSnapshot();
      });

      function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[ch]);
      }

      function relativeTime(iso) {
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) return "";
        const seconds = Math.round((Date.now() - ms) / 1000);
        if (seconds < 90) return seconds + "s ago";
        const minutes = Math.round(seconds / 60);
        if (minutes < 90) return minutes + "m ago";
        const hours = Math.round(minutes / 60);
        if (hours < 36) return hours + "h ago";
        return Math.round(hours / 24) + "d ago";
      }

      async function loadSources() {
        const resp = await fetch("/api/sources");
        const data = await resp.json();
        sources = data.sources || [];
        source = data.default || (sources[0] && sources[0].key) || "";
        sourceEl.innerHTML = sources.map((item) =>
          '<option value="' + escapeHtml(item.key) + '">' + escapeHtml(item.label) + '</option>'
        ).join("");
        sourceEl.value = source;
      }

      function activeSource() {
        return sources.find((item) => item.key === source) || {};
      }

      async function loadSnapshot() {
        rowsEl.innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';
        errorsEl.innerHTML = "";
        const resp = await fetch("/api/rigs?source=" + encodeURIComponent(source));
        const data = await resp.json();
        const meta = activeSource();
        refHeaderEl.textContent = meta.ref_label || "Branch";
        subtitleEl.innerHTML =
          '<a href="' + escapeHtml(data.pipeline_url) + '/builds">' +
          escapeHtml(data.organization_slug + "/" + data.pipeline_slug) +
          '</a> · updated ' + relativeTime(new Date((data.fetched_at || Date.now() / 1000) * 1000).toISOString());
        if (data.errors && data.errors.length) {
          errorsEl.innerHTML = '<div class="error">' + data.errors.map(escapeHtml).join("<br>") + '</div>';
        }
        const rows = (data.rigs || []).map((rig) => {
          const deploy = (rig.history || [])[0] || {};
          const refText = meta.ref_label && meta.ref_label !== "Branch"
            ? (deploy.version || "")
            : (deploy.branch || "");
          const refHref = meta.ref_label && meta.ref_label !== "Branch" ? "" : deploy.branch_url;
          const state = deploy.state || "unknown";
          return '<tr>' +
            '<td><strong>' + escapeHtml(rig.name) + '</strong><br><span class="muted">' + escapeHtml(rig.total_deploys || 0) + ' deploys</span></td>' +
            '<td class="state state-' + escapeHtml(state) + '">' + escapeHtml(state) + '</td>' +
            '<td>' + (refHref ? '<a href="' + escapeHtml(refHref) + '">' + escapeHtml(refText) + '</a>' : escapeHtml(refText)) + '</td>' +
            '<td>' + (deploy.commit_url ? '<a href="' + escapeHtml(deploy.commit_url) + '">' + escapeHtml(deploy.commit_short) + '</a>' : escapeHtml(deploy.commit_short || "")) +
            '<br><span class="muted">' + escapeHtml(deploy.commit_subject || "") + '</span></td>' +
            '<td>' + (deploy.build_url ? '<a href="' + escapeHtml(deploy.build_url) + '">#' + escapeHtml(deploy.build_number) + '</a>' : "") + '</td>' +
            '<td>' + escapeHtml(relativeTime(deploy.last_event_at)) + '</td>' +
          '</tr>';
        }).join("");
        rowsEl.innerHTML = rows || '<tr><td colspan="6" class="muted">No deployments recorded yet.</td></tr>';
      }

      loadSources().then(loadSnapshot).catch((error) => {
        errorsEl.innerHTML = '<div class="error">' + escapeHtml(error.message || error) + '</div>';
      });
      setInterval(loadSnapshot, 10000);
    </script>
  </body>
</html>`;
}
