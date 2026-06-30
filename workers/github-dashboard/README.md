# github-dashboard Worker

Cloudflare Worker backend for `githubdashboard`.

The Worker keeps `GITHUB_TOKEN` server-side, syncs GitHub metadata into D1, and
serves the dashboard UI plus JSON API from the same protected origin. Manual
syncs require `ADMIN_TOKEN`; scheduled syncs run every 15 minutes.

## Endpoints

- `GET /` - dashboard UI
- `GET /api/health`
- `GET /api/summary`
- `GET /api/search?q=<query>&limit=<n>`
- `GET /api/branches?limit=<n>&offset=<n>&sort=name|last_commit_at`
- `GET /api/tags?limit=<n>&offset=<n>`
- `GET /api/commits?limit=<n>&offset=<n>`
- `GET /api/prs?state=all|open|closed|merged&limit=<n>&offset=<n>`
- `GET /api/sync/status`
- `POST /api/sync` - requires `X-Dashboard-Admin-Token`

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create the D1 database:

   ```sh
   npx wrangler d1 create github-dashboard
   ```

3. Copy the returned database id into `wrangler.toml`.

4. Apply the migration:

   ```sh
   npm run migrate:remote
   ```

5. Store secrets:

   ```sh
   npx wrangler secret put GITHUB_TOKEN
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
GITHUB_TOKEN=ghp_...
ADMIN_TOKEN=local-admin-token
AUTH_SECRET=local-dev-auth-secret-at-least-32-chars
ACCESS_PASSWORD=local-dev-access-password
ALLOWED_ORIGIN=*
GITHUB_REPO=AppliedNeuron/core-stack
```

Then run:

```sh
npm run migrate:local
npm run dev
```

Do not commit `.dev.vars`; it contains secrets.

## Sync Scope

Cloudflare Workers cannot use the local filesystem git mirror, native
`better-sqlite3`, or the `git` CLI used by the Next.js dashboard. This Worker
uses GitHub's HTTP API instead and stores the cache in D1. Each sync refreshes
the newest pages first:

- `SYNC_BRANCH_PAGES` pages of branches, default 5
- `SYNC_TAG_PAGES` pages of tags, default 3
- `SYNC_COMMIT_PAGES` pages of recent commits on the default branch, default 3
- `SYNC_PR_PAGES` pages of pull requests sorted by update time, default 5

After that fresh pass, the Worker marks `last_sync_at` so the UI reflects that
the newest GitHub data is cached, then seeds older GitHub pages using D1 `meta`
cursors named `seed_<kind>_next_page`. The historical pass keeps advancing
within the same sync until GitHub returns the end of each list or the
`SYNC_SEED_PAGE_BUDGET` is reached. The default budget is 1,000 pages per
resource, which is intended to fully seed `AppliedNeuron/core-stack` from the
beginning instead of waiting for many 15-minute cron ticks. The Worker also
stores a `seed_plan_version`; when that version changes, it resets the
historical cursors to the first page after each fresh window so existing partial
D1 state cannot skip older pages.

Set `SYNC_HISTORY_PAGES` in `wrangler.toml` to control the page batch size for
each historical backfill request loop; if unset, it uses the resource's normal
page count. Set `SYNC_SEED_PAGE_BUDGET` to cap the total historical pages a
single sync can backfill per resource.

Once all `seed_<kind>_complete` flags are set, scheduled syncs stay incremental:
recent commits stop after the first already-known page, and pull requests stop
after reaching rows older than the previous successful sync. If a Worker run is
left marked as running longer than `SYNC_RUNNING_TTL_SECONDS`, status calls show
it as timed out and the next manual or scheduled sync resumes from the saved
cursors.
