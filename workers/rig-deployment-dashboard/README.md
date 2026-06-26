# Rig Deployment Dashboard Worker

Cloudflare Worker backend for the rig deployment dashboard.

The Worker keeps `BUILDKITE_API_TOKEN` server-side, stores deployment history in
D1, refreshes snapshots on a cron trigger, and serves the JSON API used by the
static GitHub Pages dashboard.

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

6. Set `ALLOWED_ORIGIN` in `wrangler.toml` to the GitHub Pages origin that will
   host the launcher. `*` is convenient for testing, but the deployed Worker
   should use the real Pages origin.

7. Deploy:

   ```sh
   npm run deploy
   ```

8. Copy the deployed Worker URL into
   `apps/rig-deployment-dashboard/config.js` as `dashboardUrl`.

## Local Development

Create a local `.dev.vars` file:

```sh
BUILDKITE_API_TOKEN=bkua_...
ADMIN_TOKEN=local-admin-token
ALLOWED_ORIGIN=*
```

Then run:

```sh
npm run migrate:local
npm run dev
```

Do not commit `.dev.vars`; it contains secrets.
