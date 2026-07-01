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
the newest GitHub data is cached, then back-fills older GitHub pages using D1
`meta` cursors named `seed_<kind>_next_page`. The back-fill is **round-robin by
page**: it pulls `SYNC_SEED_PAGES_PER_TURN` pages (default 1) of branches, then
tags, then commits, then pull requests, then repeats, so every type advances
together instead of finishing one type before starting the next. The Worker also
stores a `seed_plan_version`; when that version changes, it resets the
historical cursors to the first page after each fresh window so existing partial
D1 state cannot skip older pages.

Every GitHub request in a sync is counted against a per-invocation budget,
`SYNC_MAX_GITHUB_REQUESTS` (default 30). When the budget is spent, the run saves
its cursors and finishes cleanly; the next 15-minute cron tick resumes the
back-fill from where it stopped. This keeps a single invocation under the
free-plan limit of 50 external subrequests. Raise the budget toward ~45 for
faster seeding, or lower it if you hit the free-plan 10 ms CPU limit
(`Error 1102`), but keep it above the fresh-pass total (`1 + SYNC_BRANCH_PAGES +
SYNC_TAG_PAGES + SYNC_COMMIT_PAGES + SYNC_PR_PAGES`, ~17 by default) so the
back-fill still receives requests each run. `SYNC_SEED_PAGE_BUDGET` is a
secondary per-type cap on how many history pages one type may pull per
invocation.

Once all `seed_<kind>_complete` flags are set, scheduled syncs stay incremental:
recent commits stop after the first already-known page, and pull requests stop
after reaching rows older than the previous successful sync. A running sync
writes a `sync_heartbeat_at` on every phase and back-fill page; if the heartbeat
goes stale for `SYNC_HEARTBEAT_STALE_SECONDS` (default 180, below the cron
interval), status calls report it as stalled and the next manual or scheduled
sync takes over from the saved cursors. `SYNC_RUNNING_TTL_SECONDS` is a hard
backstop for the same check.
