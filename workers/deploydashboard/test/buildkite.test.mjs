import assert from "node:assert/strict";
import { createHmac, timingSafeEqual, webcrypto } from "node:crypto";
import test from "node:test";

import {
  AWAITING_DEPLOY,
  buildSummaryFingerprint,
  deriveState,
  parseBuildkiteSignatureHeader,
  parseRateLimitReset,
  parseRetryAfterMs,
  verifyBuildkiteWebhookSignature,
} from "../src/buildkite.js";

const pendingDeployJob = {
  type: "manual",
  state: "blocked",
  label: "Proceed with deploy",
};

test("terminal build state takes precedence over leftover manual blocks", () => {
  for (const state of ["passed", "failed", "canceled", "skipped", "not_run"]) {
    assert.equal(
      deriveState({ state, jobs: [pendingDeployJob] }),
      state
    );
  }
});

test("a pending deploy block is shown as awaiting deploy", () => {
  assert.equal(
    deriveState({ state: "blocked", jobs: [pendingDeployJob] }),
    AWAITING_DEPLOY
  );
});

test("force-unlock blocks do not look like deploy gates", () => {
  assert.equal(
    deriveState({
      state: "blocked",
      jobs: [{ ...pendingDeployJob, label: "Force unlock rig" }],
    }),
    "blocked"
  );
});

test("builds without job details still normalize blocked states", () => {
  assert.equal(deriveState({ state: "blocked" }), AWAITING_DEPLOY);
  assert.equal(deriveState({ state: "blocked_failed" }), AWAITING_DEPLOY);
});

test("rate-limit reset uses the most conservative quota header", () => {
  const before = Date.now() / 1000;
  const response = new Response(null, {
    status: 429,
    headers: {
      "RateLimit-Reset": "5",
      "RateLimit-User-Reset": "30",
      "Retry-After": "10",
    },
  });

  const resetAt = parseRateLimitReset(response, "{}");
  assert.ok(resetAt >= before + 29);
  assert.ok(resetAt <= before + 31);
});

test("retry-after accepts HTTP dates", () => {
  const at = new Date(Date.now() + 5000).toUTCString();
  const delay = parseRetryAfterMs(at);
  assert.ok(delay >= 3000);
  assert.ok(delay <= 5000);
});

test("build summary fingerprints detect lifecycle changes without job payloads", () => {
  const base = {
    state: "failed",
    created_at: "2026-07-17T06:43:40.319Z",
    started_at: "2026-07-17T06:50:09.672Z",
    finished_at: "2026-07-17T07:55:15.842Z",
    meta_data: { rig: "cosmo" },
  };
  assert.equal(
    buildSummaryFingerprint({ ...base, jobs: [{ state: "failed" }] }),
    buildSummaryFingerprint({ ...base, jobs: [{ state: "running" }] })
  );
  assert.equal(
    buildSummaryFingerprint({
      ...base,
      meta_data: { use_vpn: "false", rig: "cosmo" },
    }),
    buildSummaryFingerprint({
      ...base,
      meta_data: { rig: "cosmo", use_vpn: "false" },
    })
  );
  assert.notEqual(
    buildSummaryFingerprint(base),
    buildSummaryFingerprint({
      ...base,
      state: "running",
      started_at: "2026-07-17T13:27:15.489Z",
      finished_at: null,
    })
  );
});

test("Buildkite signature headers reject malformed or duplicate fields", () => {
  assert.deepEqual(
    parseBuildkiteSignatureHeader(
      `timestamp=123,signature=${"ab".repeat(32)}`
    ),
    { timestamp: 123, signature: "ab".repeat(32) }
  );
  assert.equal(
    parseBuildkiteSignatureHeader(
      `timestamp=123,timestamp=124,signature=${"ab".repeat(32)}`
    ),
    null
  );
  assert.equal(parseBuildkiteSignatureHeader("timestamp=123"), null);
});

test("Buildkite webhook signatures verify the raw body and timestamp", async () => {
  const rawBody = JSON.stringify({ event: "build.running", build: { number: 6416 } });
  const secret = "test-webhook-secret";
  const timestamp = 1_784_295_000;
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const subtle = {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    sign: (...args) => webcrypto.subtle.sign(...args),
    timingSafeEqual: (left, right) => {
      const leftBytes = Buffer.from(left);
      const rightBytes = Buffer.from(right);
      return (
        leftBytes.length === rightBytes.length &&
        timingSafeEqual(leftBytes, rightBytes)
      );
    },
  };
  const options = {
    rawBody,
    header: `timestamp=${timestamp},signature=${signature}`,
    secret,
    nowSeconds: timestamp + 10,
    subtle,
  };

  assert.equal(await verifyBuildkiteWebhookSignature(options), true);
  assert.equal(
    await verifyBuildkiteWebhookSignature({
      ...options,
      rawBody: `${rawBody} `,
    }),
    false
  );
  assert.equal(
    await verifyBuildkiteWebhookSignature({
      ...options,
      nowSeconds: timestamp + 301,
    }),
    false
  );
});
