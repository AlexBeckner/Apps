import assert from "node:assert/strict";
import { createHmac, timingSafeEqual, webcrypto } from "node:crypto";
import test from "node:test";

import {
  AWAITING_DEPLOY,
  buildNumbersMissingFromResponse,
  buildSummaryFingerprint,
  deriveState,
  extractAaosVersion,
  parseBuildkiteSignatureHeader,
  parseRateLimitReset,
  parseRetryAfterMs,
  passedWithMpkValidationFailure,
  verifyBuildkiteWebhookSignature,
} from "../src/buildkite.js";

const pendingDeployJob = {
  type: "manual",
  state: "blocked",
  label: "Proceed with deploy",
};

test("a passed build still blocked at the deploy gate is awaiting deploy", () => {
  assert.equal(
    deriveState({
      state: "passed",
      blocked: true,
      jobs: [pendingDeployJob],
    }),
    AWAITING_DEPLOY
  );
});

test("other finished states take precedence over leftover manual blocks", () => {
  assert.equal(
    deriveState({
      state: "passed",
      blocked: false,
      jobs: [pendingDeployJob],
    }),
    "passed"
  );
  for (const state of ["failed", "canceled", "skipped", "not_run"]) {
    assert.equal(
      deriveState({ state, blocked: true, jobs: [pendingDeployJob] }),
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

test("passed builds flag an active MPK validation failure with exit code 40", () => {
  const validationFailure = {
    name: "Deploy and Validate MPKs are Started (vpn : False)",
    state: "failed",
    exit_status: 40,
    soft_failed: true,
    retried: false,
  };
  assert.equal(
    passedWithMpkValidationFailure({
      state: "passed",
      jobs: [validationFailure],
    }),
    true
  );
  assert.equal(
    passedWithMpkValidationFailure({
      state: "failed",
      jobs: [validationFailure],
    }),
    false
  );
  assert.equal(
    passedWithMpkValidationFailure({
      state: "passed",
      jobs: [{ ...validationFailure, exit_status: 1 }],
    }),
    false
  );
  assert.equal(
    passedWithMpkValidationFailure({
      state: "passed",
      jobs: [{ ...validationFailure, retried: true }],
    }),
    false
  );
});

test("AAOS image versions retain the full .tgz filename", () => {
  assert.equal(
    extractAaosVersion({
      meta_data: {
        aaos_image_s3_object:
          "aaos_images/14/applied_8295_adaptive/physical/hmi_someip_bridge_testing_v9.tgz",
      },
    }),
    "hmi_someip_bridge_testing_v9.tgz"
  );
  assert.equal(
    extractAaosVersion({
      env: {
        AAOS_IMAGE:
          "aaos_images/14/applied_8295_adaptive/physical/hmi_someip_bridge_testing_v9.tgz",
      },
    }),
    "hmi_someip_bridge_testing_v9.tgz"
  );
});

test("AAOS version extraction keeps numeric and message fallbacks", () => {
  assert.equal(
    extractAaosVersion({ meta_data: { aaos_build_number: "42" } }),
    "42"
  );
  assert.equal(
    extractAaosVersion({ message: "flashing hmi_someip_bridge_testing_v9.tgz" }),
    "hmi_someip_bridge_testing_v9.tgz"
  );
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

test("previously active builds missing from the active response are reconciled", () => {
  const activeResponse = [{ number: 6689 }, { number: 6687 }];
  assert.deepEqual(
    buildNumbersMissingFromResponse([6689, 6688, 6688, 6687], activeResponse),
    [6688]
  );
  assert.deepEqual(
    buildNumbersMissingFromResponse([6688, 6686], activeResponse, 1),
    [6688]
  );
  assert.deepEqual(
    buildNumbersMissingFromResponse([6688], activeResponse, 0),
    []
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
