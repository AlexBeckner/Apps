export const AWAITING_DEPLOY = "awaiting_deploy";

export const FINISHED_BUILD_STATES = new Set([
  "passed",
  "failed",
  "canceled",
  "skipped",
  "not_run",
]);

export function deriveState(build) {
  const raw = String(build?.state || "unknown");
  if (FINISHED_BUILD_STATES.has(raw)) {
    return raw;
  }

  const jobs = build?.jobs;
  if (Array.isArray(jobs)) {
    return jobs.some(isPendingProceedBlock) ? AWAITING_DEPLOY : raw;
  }
  return raw === "blocked" || raw === "blocked_failed"
    ? AWAITING_DEPLOY
    : raw;
}

export function parseRateLimitReset(response, bodyText) {
  const now = Date.now() / 1000;
  const normalize = (value) => (value > now ? value : now + value);
  const candidates = [];

  try {
    const data = JSON.parse(bodyText);
    const reset = Number(data?.reset);
    if (Number.isFinite(reset) && reset > 0) {
      candidates.push(normalize(reset));
    }
  } catch {
    // Fall through to headers.
  }

  for (const header of [
    "RateLimit-Reset",
    "RateLimit-User-Reset",
    "X-RateLimit-Reset",
  ]) {
    const value = Number(response.headers.get(header));
    if (Number.isFinite(value) && value > 0) {
      candidates.push(normalize(value));
    }
  }

  const retryAfterMs = parseRetryAfterMs(
    response.headers.get("Retry-After")
  );
  if (retryAfterMs > 0) {
    candidates.push(now + retryAfterMs / 1000);
  }
  return candidates.length ? Math.max(...candidates) : now + 60;
}

export function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function isPendingProceedBlock(job) {
  if (!job || typeof job !== "object") return false;
  if (job.type !== "manual" || job.state !== "blocked") return false;
  return !String(job.label || "").toLowerCase().includes("force unlock");
}
