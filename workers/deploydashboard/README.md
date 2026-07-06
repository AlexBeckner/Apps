# deploydashboard Worker

Cloudflare Worker backend for deploydashboard.

The Worker keeps `BUILDKITE_API_TOKEN` server-side, stores deployment history in
D1, refreshes snapshots from a Durable Object alarm every `CACHE_SECONDS`, and
serves the dashboard UI plus JSON API from the same protected origin.

Automatic Buildkite refreshes are page-independent. The cron trigger runs every
minute only as a watchdog to arm the Durable Object alarm if needed; the
dashboard's 10-second browser poll only reads the latest cached snapshot.

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
   npx wrangler d1 create deploydashboard
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
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put ACCESS_PASSWORD
   ```

   `AUTH_SECRET` should be a long random string, at least 32 characters.
   `ACCESS_PASSWORD` is the shared password for the app login page.

6. Keep `ALLOWED_ORIGIN` set to the Worker-hosted URL in `wrangler.toml`.
   Override it to `*` in local `.dev.vars` if needed.

7. Deploy after confirming the public target:

   ```sh
   npm run deploy
   ```

8. Point GitHub Pages launchers at the deployed Worker URL.

## Local Development

Create a local `.dev.vars` file:

```sh
BUILDKITE_API_TOKEN=bkua_...
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
