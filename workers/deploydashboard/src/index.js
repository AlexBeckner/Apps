import { DurableObject } from "cloudflare:workers";
import { companyAuthResponse } from "../../githubdashboard/src/company-auth.js";
import {
  AWAITING_DEPLOY,
  FINISHED_BUILD_STATES,
  buildSummaryFingerprint,
  deriveState,
  parseRateLimitReset,
  parseRetryAfterMs,
  verifyBuildkiteWebhookSignature,
} from "./buildkite.js";

const BUILDKITE_API_BASE = "https://api.buildkite.com/v2";
const DEFAULT_ORG_SLUG = "mosaic";
const DEFAULT_DEPLOYMENT_PIPELINE = "core-stack-deployment-pipeline";
const DEFAULT_FLASHING_PIPELINE = "core-stack-aaos-flashing";
const GITHUB_OWNER = "AppliedNeuron";
const GITHUB_REPO = "core-stack";
const HISTORY_SIZE = 10;
const DEFAULT_CACHE_SECONDS = 10;
const DEFAULT_REFRESH_LEASE_SECONDS = 120;
const DEFAULT_BUILD_DETAIL_LEASE_SECONDS = 60;
const DEFAULT_FINISHED_RECHECK_SECONDS = 300;
const DEFAULT_AUDIT_RECHECK_SECONDS = 300;
const DEFAULT_FINISHED_SCAN_OVERLAP_SECONDS = 60;
const DEFAULT_BUILDKITE_FETCH_TIMEOUT_MS = 8000;
const BUILDKITE_MAX_ATTEMPTS = 2;
const BUILDKITE_RETRY_BASE_MS = 250;
const MAX_BUILDKITE_BODY_BYTES = 20 * 1024 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const WEBHOOK_MAX_AGE_SECONDS = 300;
const RECONCILE_PER_PAGE = 100;
const MAX_ACTIVE_PAGES = 200;
const MAX_AUDIT_DETAIL_FETCHES = 10;
const BACKFILL_PER_PAGE = 100;
const DEFAULT_BACKFILL_PAGES = 50;
const MAX_BACKFILL_PAGES = 200;
const REFRESH_SCHEDULER_NAME = "global-refresh-scheduler";
const BUILDKITE_WEBHOOK_PATH = "/api/webhooks/buildkite";

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
const ACTIVE_BUILD_STATES = [
  "creating",
  "scheduled",
  "running",
  "failing",
  "canceling",
];
const BUILDKITE_WEBHOOK_EVENTS = new Set([
  "build.scheduled",
  "build.running",
  "build.failing",
  "build.finished",
  "build.skipped",
  "job.scheduled",
  "job.started",
  "job.finished",
  "job.activated",
]);
const RETRYABLE_BUILDKITE_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const IN_PROGRESS_STATES = new Set([
  "creating",
  "scheduled",
  "running",
  "blocked",
  "failing",
  "canceling",
  AWAITING_DEPLOY,
]);

export class RefreshScheduler extends DurableObject {
  async start() {
    const intervalMs = refreshIntervalMs(this.env);
    const currentAlarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (
      !currentAlarm ||
      currentAlarm < now - intervalMs ||
      currentAlarm > now + intervalMs * 2
    ) {
      await this.ctx.storage.setAlarm(now + 1000);
    }
    return {
      configured: true,
      interval_seconds: cacheSeconds(this.env),
      alarm_at: await this.ctx.storage.getAlarm(),
    };
  }

  async status() {
    return {
      configured: true,
      interval_seconds: cacheSeconds(this.env),
      alarm_at: await this.ctx.storage.getAlarm(),
      last_started_at: await getMeta(this.env, schedulerMetaKey("last_started_at")),
      last_finished_at: await getMeta(this.env, schedulerMetaKey("last_finished_at")),
      last_error: await getMeta(this.env, schedulerMetaKey("last_error")),
    };
  }

  async alarm() {
    await runRefreshSchedulerAlarm(this.ctx, this.env);
  }
}

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
        return jsonResponse(
          request,
          env,
          { error: originError },
          { status: 403 }
        );
      }

      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === BUILDKITE_WEBHOOK_PATH
      ) {
        return handleBuildkiteWebhook(request, env);
      }

      const authResponse = await companyAuthResponse(
        request,
        env,
        "Deployment Dashboard"
      );
      if (authResponse) {
        return authResponse;
      }

      if (request.method === "GET" && isAssetRoute(url.pathname)) {
        return assetResponse(request, env);
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
        ctx.waitUntil(ensureRefreshScheduler(env));
        return jsonResponse(
          request,
          env,
          await getCachedSnapshot(env, source, historySize)
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
      console.error("deploydashboard request failed", {
        status,
        message: error.message || String(error),
        stack: error.stack || null,
      });
      return jsonResponse(
        request,
        env,
        { error: error.message || "Unexpected error" },
        { status }
      );
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureRefreshScheduler(env, { fallbackToRefresh: true }));
  },

  async queue(batch, env) {
    await handleBuildkiteQueue(batch, env);
  },
};

async function handleBuildkiteWebhook(request, env) {
  if (!env.BUILDKITE_WEBHOOK_SECRET) {
    throw httpError(503, "BUILDKITE_WEBHOOK_SECRET is not configured.");
  }
  if (!env.BUILDKITE_EVENTS) {
    throw httpError(503, "BUILDKITE_EVENTS queue binding is not configured.");
  }
  if (!String(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
    throw httpError(415, "Buildkite webhook must use application/json.");
  }

  const rawBody = await requestTextWithinLimit(request, MAX_WEBHOOK_BODY_BYTES);
  const validSignature = await verifyBuildkiteWebhookSignature({
    rawBody,
    header: request.headers.get("X-Buildkite-Signature"),
    secret: env.BUILDKITE_WEBHOOK_SECRET,
    maxAgeSeconds: WEBHOOK_MAX_AGE_SECONDS,
  });
  if (!validSignature) {
    return jsonResponse(
      request,
      env,
      { accepted: false, error: "Invalid or expired Buildkite signature." },
      { status: 401 }
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw httpError(400, "Buildkite webhook body is not valid JSON.");
  }

  const headerEvent = String(request.headers.get("X-Buildkite-Event") || "");
  const event = String(payload?.event || headerEvent);
  if (!event || (headerEvent && payload?.event && headerEvent !== payload.event)) {
    throw httpError(400, "Buildkite webhook event headers do not match the body.");
  }
  if (event === "ping") {
    return jsonResponse(request, env, { accepted: true, event });
  }
  if (!BUILDKITE_WEBHOOK_EVENTS.has(event)) {
    return jsonResponse(request, env, {
      accepted: true,
      ignored: true,
      event,
    });
  }

  const buildNumber = Number(payload?.build?.number);
  const pipelineSlug = String(payload?.pipeline?.slug || "");
  const source = sourceForPipeline(env, pipelineSlug);
  if (!source || !Number.isInteger(buildNumber) || buildNumber <= 0) {
    return jsonResponse(request, env, {
      accepted: true,
      ignored: true,
      event,
    });
  }

  await env.BUILDKITE_EVENTS.send({
    source_key: source.key,
    build_number: buildNumber,
    event,
    received_at: Math.floor(Date.now() / 1000),
  });
  console.log({
    event: "deploydashboard_webhook_enqueued",
    buildkite_event: event,
    source: source.key,
    build_number: buildNumber,
  });
  return jsonResponse(
    request,
    env,
    { accepted: true, event, build_number: buildNumber },
    { status: 202 }
  );
}

async function handleBuildkiteQueue(batch, env) {
  const groups = new Map();
  for (const message of batch.messages) {
    const sourceKey = String(message.body?.source_key || "");
    const buildNumber = Number(message.body?.build_number);
    const source = configuredSources(env).find((item) => item.key === sourceKey);
    if (!source || !Number.isInteger(buildNumber) || buildNumber <= 0) {
      console.error({
        event: "deploydashboard_webhook_message_invalid",
        message_id: message.id,
      });
      message.ack();
      continue;
    }
    const key = `${sourceKey}:${buildNumber}`;
    if (!groups.has(key)) {
      groups.set(key, { source, buildNumber, messages: [] });
    }
    groups.get(key).messages.push(message);
  }

  for (const group of groups.values()) {
    const { source, buildNumber, messages } = group;
    try {
      const rateLimitedUntil = await currentRateLimitUntil(env, source.key);
      if (rateLimitedUntil > Date.now() / 1000) {
        retryQueueMessages(messages, rateLimitedUntil);
        continue;
      }

      const build = await fetchBuildDetail(env, source, buildNumber);
      await saveBuildsWithSummary(env, source.key, [build]);
      const receivedAt = Math.max(
        ...messages.map((message) => Number(message.body?.received_at) || 0)
      );
      await setMeta(
        env,
        metaKey(source.key, "last_webhook_event_at"),
        String(receivedAt || Math.floor(Date.now() / 1000))
      );
      await setMeta(
        env,
        metaKey(source.key, "last_refresh_at"),
        String(Math.floor(Date.now() / 1000))
      );
      await writeCachedSnapshot(env, source);
      for (const message of messages) message.ack();
      console.log({
        event: "deploydashboard_webhook_processed",
        source: source.key,
        build_number: buildNumber,
        messages: messages.length,
      });
    } catch (error) {
      if (error.rateLimitedUntil) {
        await rememberRateLimit(env, source.key, error.rateLimitedUntil);
      }
      retryQueueMessages(messages, error.rateLimitedUntil);
      console.error({
        event: "deploydashboard_webhook_processing_failed",
        source: source.key,
        build_number: buildNumber,
        attempts: Math.max(...messages.map((message) => message.attempts || 1)),
        message: error.message || String(error),
      });
    }
  }
}

function retryQueueMessages(messages, rateLimitedUntil = null) {
  const until = Number(rateLimitedUntil) || 0;
  const delaySeconds = until > Date.now() / 1000
    ? Math.max(30, Math.min(43200, Math.ceil(until - Date.now() / 1000)))
    : 30;
  for (const message of messages) {
    message.retry({ delaySeconds });
  }
}

async function handleHealth(env) {
  const sources = [];
  for (const source of configuredSources(env)) {
    const stats = await storeStats(env, source.key);
    sources.push({
      ...sourceSummary(source, source.key === defaultSourceKey(env)),
      db_total_builds: stats.total_builds,
      last_event_at: stats.last_event_at,
      last_refresh_at: await getMeta(env, metaKey(source.key, "last_refresh_at")),
      last_refresh_attempt_at: await getMeta(
        env,
        metaKey(source.key, "last_refresh_attempt_at")
      ),
      last_webhook_event_at: await getMeta(
        env,
        metaKey(source.key, "last_webhook_event_at")
      ),
      last_finished_scan_at: await getMeta(
        env,
        metaKey(source.key, "last_finished_scan_at")
      ),
      last_audit_scan_at: await getMeta(
        env,
        metaKey(source.key, "last_audit_scan_at")
      ),
      audit_page: await getMeta(env, metaKey(source.key, "audit_page")),
      rate_limited_until: await currentRateLimitUntil(env, source.key),
    });
  }

  const primary = sources[0];
  return {
    status: "ok",
    organization_slug: primary?.organization_slug || DEFAULT_ORG_SLUG,
    pipeline_slug: primary?.pipeline_slug || DEFAULT_DEPLOYMENT_PIPELINE,
    pipeline_url: primary?.pipeline_url || pipelineUrl(DEFAULT_ORG_SLUG, DEFAULT_DEPLOYMENT_PIPELINE),
    cache_seconds: cacheSeconds(env),
    webhook: {
      path: BUILDKITE_WEBHOOK_PATH,
      secret_configured: Boolean(env.BUILDKITE_WEBHOOK_SECRET),
      queue_configured: Boolean(env.BUILDKITE_EVENTS),
    },
    refresh_scheduler: await refreshSchedulerStatus(env),
    rigs_dir: null,
    db_path: "cloudflare-d1",
    db_total_builds: primary?.db_total_builds || 0,
    restrict_writes_to_localhost: false,
    default_source: defaultSourceKey(env),
    sources,
  };
}

async function refreshAllSources(env) {
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

async function ensureRefreshScheduler(env, { fallbackToRefresh = false } = {}) {
  const stub = refreshSchedulerStub(env);
  if (!stub) {
    if (fallbackToRefresh) {
      await refreshAllSources(env);
    }
    return { configured: false };
  }

  try {
    return await stub.start();
  } catch (error) {
    console.error("deploydashboard refresh scheduler start failed", {
      message: error.message || String(error),
      stack: error.stack || null,
    });
    if (fallbackToRefresh) {
      await refreshAllSources(env);
    }
    return { configured: true, error: error.message || String(error) };
  }
}

async function refreshSchedulerStatus(env) {
  const stub = refreshSchedulerStub(env);
  if (!stub) {
    return { configured: false, interval_seconds: cacheSeconds(env) };
  }

  try {
    return await stub.status();
  } catch (error) {
    return {
      configured: true,
      interval_seconds: cacheSeconds(env),
      error: error.message || String(error),
    };
  }
}

function refreshSchedulerStub(env) {
  return env.REFRESH_SCHEDULER
    ? env.REFRESH_SCHEDULER.getByName(REFRESH_SCHEDULER_NAME)
    : null;
}

async function runRefreshSchedulerAlarm(ctx, env) {
  try {
    await setMeta(env, schedulerMetaKey("last_started_at"), String(Math.floor(Date.now() / 1000)));
    await refreshAllSources(env);
    await setMeta(env, schedulerMetaKey("last_finished_at"), String(Math.floor(Date.now() / 1000)));
    await setMeta(env, schedulerMetaKey("last_error"), "");
  } catch (error) {
    console.error("deploydashboard scheduled refresh failed", {
      message: error.message || String(error),
      stack: error.stack || null,
    });
    try {
      await setMeta(env, schedulerMetaKey("last_error"), String(error.message || error).slice(0, 300));
    } catch (metaError) {
      console.error("deploydashboard scheduler metadata write failed", {
        message: metaError.message || String(metaError),
      });
    }
  } finally {
    await ctx.storage.setAlarm(Date.now() + refreshIntervalMs(env));
  }
}

async function getSnapshot(env, source, { force, historySize = HISTORY_SIZE }) {
  const errors = [];
  let rateLimitedUntil = null;

  if (force && env.BUILDKITE_API_TOKEN) {
    const refresh = await refreshSource(env, source, { force: true });
    errors.push(...refresh.errors);
    rateLimitedUntil = refresh.rate_limited_until;
    const cached = await readCachedSnapshot(env, source.key, historySize);
    if (cached) {
      return {
        ...cached,
        errors: cached.errors || errors,
        rate_limited_until: rateLimitedUntil || cached.rate_limited_until || null,
      };
    }
  } else if (force && !env.BUILDKITE_API_TOKEN) {
    errors.push("Worker secret BUILDKITE_API_TOKEN is not configured.");
  }

  return buildSnapshotPayload(env, source, {
    historySize,
    errors,
    rateLimitedUntil,
  });
}

async function buildSnapshotPayload(
  env,
  source,
  { historySize = HISTORY_SIZE, errors = [], rateLimitedUntil = null } = {}
) {
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
    errors: [...errors],
    rate_limited_until: rateLimitedUntil,
  };
}

async function getCachedSnapshot(env, source, historySize = HISTORY_SIZE) {
  const cached = await readCachedSnapshot(env, source.key, historySize);
  if (cached) {
    const rateLimitedUntil = await currentRateLimitUntil(env, source.key);
    return {
      ...cached,
      rate_limited_until:
        rateLimitedUntil > Date.now() / 1000 ? rateLimitedUntil : null,
    };
  }

  return {
    rigs: [],
    fetched_at:
      Number(await getMeta(env, metaKey(source.key, "last_refresh_at"))) ||
      Math.floor(Date.now() / 1000),
    pipeline_url: pipelineUrl(source.organization_slug, source.pipeline_slug),
    organization_slug: source.organization_slug,
    pipeline_slug: source.pipeline_slug,
    unassigned_build_count: 0,
    errors: ["Snapshot cache is warming up. Data will appear after the next refresh."],
    rate_limited_until: null,
  };
}

async function readCachedSnapshot(env, sourceKey, historySize = HISTORY_SIZE) {
  const raw = await getMeta(env, snapshotCacheKey(sourceKey));
  if (!raw) return null;

  try {
    return trimSnapshotHistory(JSON.parse(raw), historySize);
  } catch (error) {
    console.error("deploydashboard cached snapshot decode failed", {
      source: sourceKey,
      message: error.message || String(error),
    });
    return null;
  }
}

async function writeCachedSnapshot(env, source, errors = [], rateLimitedUntil = null) {
  const snapshot = await buildSnapshotPayload(env, source, {
    historySize: HISTORY_SIZE,
    errors,
    rateLimitedUntil,
  });
  await setMeta(env, snapshotCacheKey(source.key), JSON.stringify(snapshot));
  return snapshot;
}

function trimSnapshotHistory(snapshot, historySize = HISTORY_SIZE) {
  const limit = Math.max(1, Math.min(HISTORY_SIZE, Number(historySize) || HISTORY_SIZE));
  return {
    ...snapshot,
    rigs: Array.isArray(snapshot.rigs)
      ? snapshot.rigs.map((rig) => ({
          ...rig,
          history: Array.isArray(rig.history) ? rig.history.slice(0, limit) : [],
        }))
      : [],
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
    rate_limited_until: snapshot.rate_limited_until || null,
  };
}

async function refreshSource(env, source, { force = false } = {}) {
  const knownRateLimitUntil = await currentRateLimitUntil(env, source.key);
  if (knownRateLimitUntil > Date.now() / 1000) {
    return {
      errors: [],
      rate_limited_until: knownRateLimitUntil,
      skipped: true,
    };
  }

  const lease = await acquireRefreshLease(env, source.key);
  if (!lease.acquired) {
    return { errors: [], rate_limited_until: null, skipped: true };
  }

  const errors = [];
  let rateLimitedUntil = null;
  const buildsByNumber = new Map();
  const metadataUpdates = [];
  let fetchSucceeded = false;
  let storeSucceeded = true;
  const refreshStartedAt = Math.floor(Date.now() / 1000);

  try {
    try {
      mergeBuildsByNumber(
        buildsByNumber,
        await fetchAllActiveBuilds(env, source)
      );
      fetchSucceeded = true;
    } catch (error) {
      errors.push(buildkiteErrorMessage(error));
      rateLimitedUntil = error.rateLimitedUntil || null;
    }

    if (
      !rateLimitedUntil &&
      (force ||
        await reconciliationDue(
          env,
          source.key,
          "last_finished_scan_at",
          finishedRecheckSeconds(env)
        ))
    ) {
      const previousScan =
        Number(await getMeta(env, metaKey(source.key, "last_finished_scan_at"))) ||
        refreshStartedAt - finishedRecheckSeconds(env);
      const finishedFrom = Math.max(
        0,
        previousScan - finishedScanOverlapSeconds(env)
      );
      try {
        mergeBuildsByNumber(
          buildsByNumber,
          await fetchRecentlyFinishedBuilds(env, source, finishedFrom)
        );
        metadataUpdates.push([
          metaKey(source.key, "last_finished_scan_at"),
          String(refreshStartedAt),
        ]);
        fetchSucceeded = true;
      } catch (error) {
        errors.push(buildkiteErrorMessage(error));
        rateLimitedUntil = error.rateLimitedUntil || null;
      }
    }

    if (
      !rateLimitedUntil &&
      (force ||
        await reconciliationDue(
          env,
          source.key,
          "last_audit_scan_at",
          auditRecheckSeconds(env)
        ))
    ) {
      try {
        const audit = await auditNextBuildPage(env, source);
        mergeBuildsByNumber(buildsByNumber, audit.builds);
        metadataUpdates.push(
          [metaKey(source.key, "audit_page"), String(audit.next_page)],
          [
            metaKey(source.key, "last_audit_scan_at"),
            String(refreshStartedAt),
          ]
        );
        fetchSucceeded = true;
      } catch (error) {
        errors.push(buildkiteErrorMessage(error));
        rateLimitedUntil = error.rateLimitedUntil || null;
      }
    }

    try {
      const builds = [...buildsByNumber.values()];
      if (builds.length) {
        await saveBuildsWithSummary(env, source.key, builds);
      }
      for (const [key, value] of metadataUpdates) {
        await setMeta(env, key, value);
      }
    } catch (error) {
      storeSucceeded = false;
      const message = `D1 write failed during refresh: ${error.message || error}`;
      console.error({
        event: "deploydashboard_refresh_store_failed",
        source: source.key,
        message,
      });
      errors.push(message.slice(0, 300));
    }

    const attemptedAt = Math.floor(Date.now() / 1000);
    await setMeta(env, metaKey(source.key, "last_refresh_attempt_at"), String(attemptedAt));
    if (fetchSucceeded && storeSucceeded) {
      await setMeta(env, metaKey(source.key, "last_refresh_at"), String(attemptedAt));
    }
    if (rateLimitedUntil) {
      await rememberRateLimit(env, source.key, rateLimitedUntil);
    } else if (fetchSucceeded) {
      await rememberRateLimit(env, source.key, 0);
    }
    await setMeta(env, metaKey(source.key, "last_refresh_errors"), JSON.stringify(errors));
    await writeCachedSnapshot(env, source, errors, rateLimitedUntil);
    return { errors, rate_limited_until: rateLimitedUntil };
  } finally {
    await releaseRefreshLease(env, source.key, lease);
  }
}

async function fetchAllActiveBuilds(env, source) {
  const params = new URLSearchParams({
    per_page: String(RECONCILE_PER_PAGE),
    include_retried_jobs: "true",
    exclude_pipeline: "true",
  });
  for (const state of ACTIVE_BUILD_STATES) {
    params.append("state[]", state);
  }
  return fetchBuildPages(env, source, params, MAX_ACTIVE_PAGES);
}

async function fetchRecentlyFinishedBuilds(env, source, finishedFrom) {
  const params = new URLSearchParams({
    per_page: String(RECONCILE_PER_PAGE),
    include_retried_jobs: "true",
    exclude_pipeline: "true",
    finished_from: new Date(finishedFrom * 1000).toISOString(),
  });
  return fetchBuildPages(env, source, params, MAX_BACKFILL_PAGES);
}

async function fetchBuildPages(env, source, baseParams, maxPages) {
  const builds = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(page));
    const data = await buildkiteJson(env, `${buildsUrl(source)}?${params}`);
    if (!Array.isArray(data)) {
      throw httpError(502, `Unexpected Buildkite response shape: ${typeof data}`);
    }
    builds.push(...data);
    if (data.length < RECONCILE_PER_PAGE) return builds;
  }
  throw httpError(
    502,
    `Buildkite reconciliation exceeded ${maxPages} pages for ${source.key}.`
  );
}

async function auditNextBuildPage(env, source) {
  const configuredPage =
    Number(await getMeta(env, metaKey(source.key, "audit_page"))) || 1;
  const page = Math.max(1, Math.floor(configuredPage));
  const params = new URLSearchParams({
    per_page: String(RECONCILE_PER_PAGE),
    page: String(page),
    exclude_jobs: "true",
    exclude_pipeline: "true",
  });

  let summaries;
  try {
    summaries = await buildkiteJson(env, `${buildsUrl(source)}?${params}`);
  } catch (error) {
    if (error.status === 400 && page > 1) {
      return { builds: [], next_page: 1 };
    }
    throw error;
  }
  if (!Array.isArray(summaries)) {
    throw httpError(
      502,
      `Unexpected Buildkite audit response shape: ${typeof summaries}`
    );
  }
  if (!summaries.length) {
    return { builds: [], next_page: 1 };
  }

  const fingerprints = await getStoredBuildFingerprints(
    env,
    source.key,
    summaries.map((build) => build?.number)
  );
  const changedNumbers = summaries
    .filter((build) => {
      const number = build?.number;
      return (
        Number.isInteger(number) &&
        fingerprints.get(number) !== buildSummaryFingerprint(build)
      );
    })
    .map((build) => build.number);
  const builds = [];
  for (const number of changedNumbers.slice(0, MAX_AUDIT_DETAIL_FETCHES)) {
    builds.push(await fetchBuildDetail(env, source, number));
  }

  const pageHasPendingDetails =
    changedNumbers.length > MAX_AUDIT_DETAIL_FETCHES;
  const reachedEnd = summaries.length < RECONCILE_PER_PAGE;
  return {
    builds,
    next_page: pageHasPendingDetails ? page : reachedEnd ? 1 : page + 1,
  };
}

function mergeBuildsByNumber(target, builds) {
  for (const build of builds || []) {
    if (Number.isInteger(build?.number) && build.number > 0) {
      target.set(build.number, build);
    }
  }
}

async function fetchBuildDetail(env, source, buildNumber) {
  return buildkiteJson(
    env,
    `${buildsUrl(source)}/${buildNumber}?${new URLSearchParams({
      include_retried_jobs: "true",
      exclude_pipeline: "true",
    })}`
  );
}

async function buildkiteJson(env, url) {
  if (!env.BUILDKITE_API_TOKEN) {
    throw httpError(500, "Worker secret BUILDKITE_API_TOKEN is not configured.");
  }

  let lastError = null;
  for (let attempt = 0; attempt < BUILDKITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await buildkiteJsonAttempt(env, url);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt + 1 >= BUILDKITE_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(buildkiteRetryDelayMs(error, attempt));
    }
  }
  throw lastError || httpError(502, "Buildkite request failed.");
}

async function buildkiteJsonAttempt(env, url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    buildkiteFetchTimeoutMs(env)
  );
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.BUILDKITE_API_TOKEN}`,
        "User-Agent": "deploydashboard-worker/0.1",
      },
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(timeout);
    const error = httpError(
      502,
      controller.signal.aborted
        ? "Buildkite request timed out."
        : `Buildkite request failed: ${cause?.message || cause}`
    );
    error.retryable = true;
    throw error;
  }

  let text;
  try {
    text = await responseTextWithinLimit(response);
  } catch (cause) {
    const error = httpError(
      502,
      controller.signal.aborted
        ? "Buildkite response timed out."
        : cause?.message || "Buildkite response could not be read."
    );
    error.retryable = cause?.retryable !== false;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const error = httpError(response.status, `${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    error.bodyText = text;
    error.rateLimitedUntil = response.status === 429 ? parseRateLimitReset(response, text) : null;
    error.retryable = RETRYABLE_BUILDKITE_STATUSES.has(response.status);
    error.retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = httpError(502, "Unexpected Buildkite response shape: invalid JSON");
    error.retryable = true;
    throw error;
  }
}

async function responseTextWithinLimit(response) {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BUILDKITE_BODY_BYTES) {
    throw nonRetryableBuildkiteError(
      "Buildkite response exceeded the dashboard size limit."
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_BUILDKITE_BODY_BYTES) {
      await reader.cancel();
      throw nonRetryableBuildkiteError(
        "Buildkite response exceeded the dashboard size limit."
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function requestTextWithinLimit(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw httpError(413, "Buildkite webhook payload is too large.");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel();
      throw httpError(413, "Buildkite webhook payload is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function nonRetryableBuildkiteError(message) {
  const error = httpError(502, message);
  error.retryable = false;
  return error;
}

function buildkiteRetryDelayMs(error, attempt) {
  const exponential = BUILDKITE_RETRY_BASE_MS * 2 ** attempt;
  const retryAfter = Number(error.retryAfterMs) || 0;
  return Math.min(5000, Math.max(exponential, retryAfter));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function backfill(env, source, maxPages) {
  const cap = Math.max(1, Math.min(maxPages || DEFAULT_BACKFILL_PAGES, MAX_BACKFILL_PAGES));
  const knownRateLimitUntil = await currentRateLimitUntil(env, source.key);
  if (knownRateLimitUntil > Date.now() / 1000) {
    return {
      ok: false,
      stopped_reason: "rate_limited",
      pages_fetched: 0,
      builds_seen: 0,
      builds_written: 0,
      builds_new: 0,
      builds_updated: 0,
      builds_unchanged: 0,
      errors: ["Buildkite rate limit is still active."],
      rate_limited_until: knownRateLimitUntil,
      max_pages: cap,
      stats: await storeStats(env, source.key),
    };
  }

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
      if (rateLimitedUntil) {
        await rememberRateLimit(env, source.key, rateLimitedUntil);
      }
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

  const attemptedAt = Math.floor(Date.now() / 1000);
  await setMeta(env, metaKey(source.key, "last_refresh_attempt_at"), String(attemptedAt));
  if (pagesFetched > 0) {
    await setMeta(env, metaKey(source.key, "last_refresh_at"), String(attemptedAt));
  }
  if (!rateLimitedUntil && pagesFetched > 0) {
    await rememberRateLimit(env, source.key, 0);
  }
  await setMeta(env, metaKey(source.key, "last_refresh_errors"), JSON.stringify(errors));
  await writeCachedSnapshot(env, source, errors, rateLimitedUntil);

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

  let raw = await getBuild(env, source.key, buildNumber);
  const errors = [];
  let rateLimitedUntil = null;
  const needsDetailFetch =
    !raw ||
    !Array.isArray(raw.jobs) ||
    finishedBuildHasActiveJobs(raw) ||
    (force && !(await buildDetailLeaseActive(env, source.key, buildNumber)));

  if (needsDetailFetch) {
    const knownRateLimitUntil = await currentRateLimitUntil(env, source.key);
    if (knownRateLimitUntil > Date.now() / 1000) {
      errors.push("Buildkite rate limit is still active.");
      rateLimitedUntil = knownRateLimitUntil;
      return raw
        ? {
            ...buildToAttempts(raw),
            errors,
            rate_limited_until: rateLimitedUntil,
          }
        : emptyBuildAttempts(buildNumber, errors, rateLimitedUntil);
    }

    const lease = await acquireBuildDetailLease(env, source.key, buildNumber);
    if (!lease.acquired) {
      return raw
        ? {
            ...buildToAttempts(raw),
            errors,
            rate_limited_until: rateLimitedUntil,
          }
        : emptyBuildAttempts(buildNumber, errors, rateLimitedUntil);
    }
    try {
      raw = await fetchBuildDetail(env, source, buildNumber);
      await saveBuildsWithSummary(env, source.key, [raw]);
      await markBuildsChecked(env, source.key, [buildNumber]);
    } catch (error) {
      errors.push(buildkiteErrorMessage(error));
      rateLimitedUntil = error.rateLimitedUntil || null;
      if (rateLimitedUntil) {
        await rememberRateLimit(env, source.key, rateLimitedUntil);
      }
    }
  }

  if (!raw) {
    return emptyBuildAttempts(buildNumber, errors, rateLimitedUntil);
  }

  return {
    ...buildToAttempts(raw),
    errors,
    rate_limited_until: rateLimitedUntil,
  };
}

function emptyBuildAttempts(buildNumber, errors, rateLimitedUntil) {
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
        updated_at = excluded.updated_at
      WHERE (
        builds.rig IS NOT excluded.rig
        OR builds.state IS NOT excluded.state
        OR builds.created_at IS NOT excluded.created_at
        OR builds.last_event_at IS NOT excluded.last_event_at
        OR builds.raw_json IS NOT excluded.raw_json
      )
      AND COALESCE(excluded.last_event_at, '') >= COALESCE(builds.last_event_at, '')`
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

async function getStoredBuildFingerprints(env, sourceKey, numbers) {
  const out = new Map();
  const validNumbers = [...new Set(numbers)]
    .filter((number) => Number.isInteger(number) && number > 0);
  for (const chunk of chunked(validNumbers, 90)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `SELECT build_number, raw_json
       FROM builds
       WHERE source = ? AND build_number IN (${placeholders})`
    ).bind(sourceKey, ...chunk).all();
    for (const row of result.results || []) {
      const build = decodeRawBuild(row.raw_json);
      if (build) {
        out.set(Number(row.build_number), buildSummaryFingerprint(build));
      }
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

async function markBuildsChecked(env, sourceKey, buildNumbers) {
  const numbers = [...new Set(buildNumbers)].filter(Number.isInteger);
  if (!numbers.length) return;

  const checkedAt = Date.now() / 1000;
  for (const chunk of chunked(numbers, 90)) {
    const placeholders = chunk.map(() => "?").join(", ");
    await env.DB.prepare(
      `UPDATE builds
       SET updated_at = ?
       WHERE source = ? AND build_number IN (${placeholders})`
    ).bind(checkedAt, sourceKey, ...chunk).run();
  }
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

async function acquireRefreshLease(env, sourceKey) {
  if (await refreshLeaseActive(env, sourceKey)) {
    return { acquired: false };
  }
  const startedAt = String(Math.floor(Date.now() / 1000));
  await setMeta(env, metaKey(sourceKey, "refresh_started_at"), startedAt);
  return { acquired: true, started_at: startedAt };
}

async function refreshLeaseActive(env, sourceKey) {
  const startedAt = Number(await getMeta(env, metaKey(sourceKey, "refresh_started_at"))) || 0;
  return Date.now() / 1000 - startedAt < refreshLeaseSeconds(env);
}

async function releaseRefreshLease(env, sourceKey, lease) {
  if (!lease?.started_at) return;
  try {
    const key = metaKey(sourceKey, "refresh_started_at");
    if ((await getMeta(env, key)) === lease.started_at) {
      await setMeta(env, key, "0");
    }
  } catch (error) {
    console.error("deploydashboard refresh lease release failed", {
      source: sourceKey,
      message: error.message || String(error),
    });
  }
}

async function acquireBuildDetailLease(env, sourceKey, buildNumber) {
  if (await buildDetailLeaseActive(env, sourceKey, buildNumber)) {
    return { acquired: false };
  }
  await setMeta(
    env,
    metaKey(sourceKey, `build:${buildNumber}:detail_started_at`),
    String(Math.floor(Date.now() / 1000))
  );
  return { acquired: true };
}

async function buildDetailLeaseActive(env, sourceKey, buildNumber) {
  const startedAt =
    Number(await getMeta(env, metaKey(sourceKey, `build:${buildNumber}:detail_started_at`))) || 0;
  return Date.now() / 1000 - startedAt < buildDetailLeaseSeconds(env);
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

async function currentRateLimitUntil(env, _sourceKey) {
  return Number(await getMeta(env, buildkiteRateLimitKey())) || 0;
}

async function rememberRateLimit(env, _sourceKey, until) {
  const current = Number(await getMeta(env, buildkiteRateLimitKey())) || 0;
  const requested = Number(until) || 0;
  let next = Math.max(current, requested);
  if (requested <= 0 && current <= Date.now() / 1000) {
    next = 0;
  }
  if (current !== next) {
    await setMeta(env, buildkiteRateLimitKey(), String(next));
  }
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

function sourceForPipeline(env, pipelineSlug) {
  return configuredSources(env).find(
    (source) => source.pipeline_slug === pipelineSlug
  ) || null;
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

async function assetResponse(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
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

function snapshotHistorySize(url) {
  if (parseBoolean(url.searchParams.get("compact"))) return 1;
  const value = Number(url.searchParams.get("history_size") || HISTORY_SIZE);
  return Math.max(1, Math.min(HISTORY_SIZE, Number.isFinite(value) ? Math.floor(value) : HISTORY_SIZE));
}

function cacheSeconds(env) {
  const value = Number(env.CACHE_SECONDS || DEFAULT_CACHE_SECONDS);
  return Math.max(10, Number.isFinite(value) ? Math.floor(value) : DEFAULT_CACHE_SECONDS);
}

function refreshIntervalMs(env) {
  return cacheSeconds(env) * 1000;
}

function refreshLeaseSeconds(env) {
  const value = Number(env.REFRESH_LEASE_SECONDS || Math.max(cacheSeconds(env), DEFAULT_REFRESH_LEASE_SECONDS));
  return Math.max(5, Math.min(300, Number.isFinite(value) ? Math.floor(value) : DEFAULT_REFRESH_LEASE_SECONDS));
}

function buildDetailLeaseSeconds(env) {
  const value = Number(env.BUILD_DETAIL_LEASE_SECONDS || DEFAULT_BUILD_DETAIL_LEASE_SECONDS);
  return Math.max(10, Math.min(300, Number.isFinite(value) ? Math.floor(value) : DEFAULT_BUILD_DETAIL_LEASE_SECONDS));
}

function finishedRecheckSeconds(env) {
  const value = Number(
    env.FINISHED_RECHECK_SECONDS || DEFAULT_FINISHED_RECHECK_SECONDS
  );
  return Math.max(
    60,
    Math.min(
      3600,
      Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_FINISHED_RECHECK_SECONDS
    )
  );
}

function auditRecheckSeconds(env) {
  const value = Number(
    env.AUDIT_RECHECK_SECONDS || DEFAULT_AUDIT_RECHECK_SECONDS
  );
  return Math.max(
    30,
    Math.min(
      3600,
      Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_AUDIT_RECHECK_SECONDS
    )
  );
}

function finishedScanOverlapSeconds(env) {
  const value = Number(
    env.FINISHED_SCAN_OVERLAP_SECONDS ||
      DEFAULT_FINISHED_SCAN_OVERLAP_SECONDS
  );
  return Math.max(
    0,
    Math.min(
      600,
      Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_FINISHED_SCAN_OVERLAP_SECONDS
    )
  );
}

async function reconciliationDue(
  env,
  sourceKey,
  metadataName,
  intervalSeconds
) {
  const lastRun =
    Number(await getMeta(env, metaKey(sourceKey, metadataName))) || 0;
  return Date.now() / 1000 - lastRun >= intervalSeconds;
}

function buildkiteFetchTimeoutMs(env) {
  const value = Number(
    env.BUILDKITE_FETCH_TIMEOUT_MS || DEFAULT_BUILDKITE_FETCH_TIMEOUT_MS
  );
  return Math.max(
    1000,
    Math.min(
      30000,
      Number.isFinite(value)
        ? Math.floor(value)
        : DEFAULT_BUILDKITE_FETCH_TIMEOUT_MS
    )
  );
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

function snapshotCacheKey(sourceKey) {
  return metaKey(sourceKey, "snapshot_json");
}

function buildkiteRateLimitKey() {
  return metaKey("buildkite", "rate_limited_until");
}

function schedulerMetaKey(name) {
  return metaKey("refresh_scheduler", name);
}

function chunked(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function isAssetRoute(pathname) {
  return pathname === "/" || !pathname.startsWith("/api/");
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>deploydashboard</title>
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
          <h1>deploydashboard</h1>
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
