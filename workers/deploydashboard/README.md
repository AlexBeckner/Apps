# deploydashboard Worker

Cloudflare Worker backend for deploydashboard.

The Worker keeps `BUILDKITE_API_TOKEN` server-side, stores deployment history in
D1, receives signed Buildkite lifecycle webhooks through a Cloudflare Queue, and
serves the dashboard UI plus JSON API from the same protected origin.

Webhooks are the fast path: the public webhook endpoint verifies Buildkite's
HMAC signature and replay timestamp, then durably enqueues the build number.
Queue batches coalesce repeated job events, fetch the exact build with every job
and retry attempt, and upsert the result into D1.

Reconciliation remains page-independent and requires no manual sync:

- every 30 seconds, fetch every active build (paginated, with all jobs);
- every five minutes, fetch every build finished since the prior scan, with a
  one-minute overlap;
- every minute, inspect one 100-build summary page and fetch full details only
  for changed builds. The rolling audit eventually covers the entire pipeline.

The cron trigger is a watchdog for the Durable Object alarm. The dashboard's
10-second browser poll only reads D1 and does not consume Buildkite API quota.
A remembered Buildkite rate limit pauses upstream requests until the reset time.

## Endpoints

- `GET /` - minimal dashboard UI
- `GET /api/health`
- `GET /api/sources`
- `GET /api/client-context`
- `GET /api/stats?source=<source>`
- `GET /api/rigs?source=<source>`
- `GET /api/known-rigs`
- `GET /api/rigs/<rig>/history?source=<source>`
- `GET /api/builds/<build>/attempts?source=<source>`
- `POST /api/webhooks/buildkite` - public, HMAC-authenticated Buildkite receiver
- `POST /api/refresh?source=<source>`
- `POST /api/backfill?source=<source>&max_pages=<n>`

Read endpoints are available to the configured `ALLOWED_ORIGIN`. Write endpoints
require `ADMIN_TOKEN` by default. The webhook endpoint bypasses dashboard login
and requires a valid, fresh `X-Buildkite-Signature`.

The static dashboard sends `ADMIN_TOKEN` as `X-Dashboard-Admin-Token` after a
user clicks **Unlock controls** and enters the token. Do not put this token in
`config.js`.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create the D1 database:

   ```sh
   npx wrangler d1 create deploydashboard
   ```

3. Create the webhook queue:

   ```sh
   npx wrangler queues create deploydashboard-buildkite-events
   ```

   The configured dead-letter queue is created automatically if needed.

4. Copy the returned database id into `wrangler.toml`.

5. Apply the migration:

   ```sh
   npm run migrate:remote
   ```

6. Generate one strong random webhook secret. Store it in the Worker and use
   the same value as the Buildkite webhook's HMAC token:

   ```sh
   npx wrangler secret put BUILDKITE_API_TOKEN
   npx wrangler secret put BUILDKITE_WEBHOOK_SECRET
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put ACCESS_PASSWORD
   ```

   `AUTH_SECRET` should be a long random string, at least 32 characters.
   `ACCESS_PASSWORD` is the shared password for the app login page.

7. Keep `ALLOWED_ORIGIN` set to the Worker-hosted URL in `wrangler.toml`.
   Override it to `*` in local `.dev.vars` if needed.

8. Deploy after confirming the public target:

   ```sh
   npm run deploy
   ```

9. Add a Buildkite Pipelines webhook targeting:

   `https://deploydashboard.appliedapps.workers.dev/api/webhooks/buildkite`

   Configure HMAC signatures with the same `BUILDKITE_WEBHOOK_SECRET`, select
   only `core-stack-deployment-pipeline` and `core-stack-aaos-flashing`, and
   subscribe to:

   - `build.scheduled`, `build.running`, `build.failing`, `build.finished`,
     `build.skipped`
   - `job.scheduled`, `job.started`, `job.finished`, `job.activated`

10. Point GitHub Pages launchers at the deployed Worker URL.

## Local Development

Create a local `.dev.vars` file:

```sh
BUILDKITE_API_TOKEN=bkua_...
BUILDKITE_WEBHOOK_SECRET=local-webhook-secret
ADMIN_TOKEN=local-admin-token
AUTH_SECRET=local-dev-auth-secret-at-least-32-chars
ACCESS_PASSWORD=local-dev-access-password
ALLOWED_ORIGIN=*
```

Then run:

```sh
npm run migrate:local
npm run dev
```

Do not commit `.dev.vars`; it contains secrets.
