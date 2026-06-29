# buildkitedeploymentdashboard Worker

Cloudflare Worker backend for buildkitedeploymentdashboard.

The Worker keeps `BUILDKITE_API_TOKEN` server-side, stores deployment history in
D1, refreshes snapshots on a cron trigger, and serves the dashboard UI plus JSON
API from the same protected origin.

`GET /api/rigs` automatically refreshes Buildkite data when the stored snapshot
is older than `CACHE_SECONDS` (10 seconds in `wrangler.toml`). The cron trigger
runs every minute as a fallback when no dashboard client is open.

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
- `POST /api/refresh?source=<source>`
- `POST /api/backfill?source=<source>&max_pages=<n>`

Read endpoints are available to the configured `ALLOWED_ORIGIN`. Write endpoints
require `ADMIN_TOKEN` by default.

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
   npx wrangler d1 create rig-deployment-dashboard
   ```

3. Copy the returned database id into `wrangler.toml`.

4. Apply the migration:

   ```sh
   npm run migrate:remote
   ```

5. Store secrets:

   ```sh
   npx wrangler secret put BUILDKITE_API_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   ```

6. Enable Cloudflare Access for the production Worker URL:

   - In Cloudflare, open Workers & Pages > `rig-deployment-dashboard` >
     Settings > Domains & Routes.
   - Enable Cloudflare Access for
     `https://rig-deployment-dashboard.dataspeedhashfinder.workers.dev/`.
   - Configure an Allow policy for emails ending in `@applied.co` or
     `@ext.applied.co`.
   - Require the One-Time PIN login method.
   - Copy the Access team domain and Application Audience (AUD) tag into
     `TEAM_DOMAIN` and `POLICY_AUD` for this Worker.

7. Keep `ALLOWED_ORIGIN` set to the Worker-hosted URL in `wrangler.toml`.
   Override it to `*` in local `.dev.vars` if needed.

8. Deploy after confirming the public target:

   ```sh
   npm run deploy
   ```

   If `TEAM_DOMAIN` and `POLICY_AUD` were set in the Cloudflare dashboard
   instead of `wrangler.toml`, deploy with `npm run deploy -- --keep-vars`.

9. Point GitHub Pages launchers at the deployed Worker URL.

## Local Development

Create a local `.dev.vars` file:

```sh
BUILDKITE_API_TOKEN=bkua_...
ADMIN_TOKEN=local-admin-token
ALLOWED_ORIGIN=*
```

Leave `TEAM_DOMAIN` and `POLICY_AUD` unset for localhost development. Non-local
requests fail closed unless those Cloudflare Access values are configured.

Then run:

```sh
npm run migrate:local
npm run dev
```

Do not commit `.dev.vars`; it contains secrets.
