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
  const jobs = build?.jobs;
  const pendingProceedBlock =
    Array.isArray(jobs) && jobs.some(isPendingProceedBlock);

  if (raw === "passed" && build?.blocked === true && pendingProceedBlock) {
    return AWAITING_DEPLOY;
  }
  if (FINISHED_BUILD_STATES.has(raw)) {
    return raw;
  }

  if (Array.isArray(jobs)) {
    return pendingProceedBlock ? AWAITING_DEPLOY : raw;
  }
  return raw === "blocked" || raw === "blocked_failed"
    ? AWAITING_DEPLOY
    : raw;
}

export function buildSummaryFingerprint(build) {
  const metaData =
    build?.meta_data && typeof build.meta_data === "object"
      ? stableValue(build.meta_data)
      : null;
  return JSON.stringify({
    state: String(build?.state || "unknown"),
    blocked: Boolean(build?.blocked),
    created_at: stringOrNull(build?.created_at),
    scheduled_at: stringOrNull(build?.scheduled_at),
    started_at: stringOrNull(build?.started_at),
    finished_at: stringOrNull(build?.finished_at),
    canceled_at: stringOrNull(build?.canceled_at),
    meta_data: metaData,
  });
}

export function buildNumbersMissingFromResponse(
  candidateNumbers,
  builds,
  limit = Number.POSITIVE_INFINITY
) {
  const returnedNumbers = new Set(
    (builds || [])
      .map((build) => build?.number)
      .filter((number) => Number.isInteger(number) && number > 0)
  );
  const cap = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  if (cap === 0) return [];
  const missing = [];
  const seen = new Set();
  for (const number of candidateNumbers || []) {
    if (
      !Number.isInteger(number) ||
      number <= 0 ||
      seen.has(number) ||
      returnedNumbers.has(number)
    ) {
      continue;
    }
    seen.add(number);
    missing.push(number);
    if (missing.length >= cap) break;
  }
  return missing;
}

export function parseBuildkiteSignatureHeader(value) {
  if (!value) return null;
  const parts = new Map();
  for (const rawPart of String(value).split(",")) {
    const separator = rawPart.indexOf("=");
    if (separator <= 0) return null;
    const key = rawPart.slice(0, separator).trim();
    const partValue = rawPart.slice(separator + 1).trim();
    if (!key || !partValue || parts.has(key)) return null;
    parts.set(key, partValue);
  }

  const timestampText = parts.get("timestamp") || "";
  const signature = parts.get("signature") || "";
  if (!/^\d+$/.test(timestampText) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return null;
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return { timestamp, signature: signature.toLowerCase() };
}

export async function verifyBuildkiteWebhookSignature({
  rawBody,
  header,
  secret,
  nowSeconds = Date.now() / 1000,
  maxAgeSeconds = 300,
  subtle = globalThis.crypto?.subtle,
}) {
  const parsed = parseBuildkiteSignatureHeader(header);
  if (!parsed || !secret || !subtle) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > maxAgeSeconds) return false;
  if (typeof subtle.timingSafeEqual !== "function") {
    throw new Error("A native timing-safe comparison is required.");
  }

  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${parsed.timestamp}.${String(rawBody)}`)
  );
  return subtle.timingSafeEqual(expected, hexToBytes(parsed.signature));
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

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function stringOrNull(value) {
  return value == null || value === "" ? null : String(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}
