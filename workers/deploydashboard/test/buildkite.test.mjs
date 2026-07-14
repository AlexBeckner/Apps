import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAITING_DEPLOY,
  deriveState,
  parseRateLimitReset,
  parseRetryAfterMs,
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
