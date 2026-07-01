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
uses GitHub's HTTP API instead and stores the cache in D1. Commits, tags, and
pull requests refresh their newest pages first:

- `SYNC_TAG_PAGES` pages of tags, default 3
- `SYNC_COMMIT_PAGES` pages of recent commits on the default branch, default 3
- `SYNC_PR_PAGES` pages of pull requests sorted by update time, default 5

Branches are handled differently. GitHub has no "recently updated branches"
listing — the REST `/branches` endpoint is alphabetical and GraphQL cannot order
branches by commit date — so a fixed fresh pass would only ever re-check the
same alphabetical prefix and miss recently active branches. Instead, branches
use a **continuous rolling GraphQL sweep** (`syncBranches`): each request pulls
`SYNC_BRANCH_SWEEP_PAGES` × 100 branches (default 12 pages) along with each
branch's head SHA and head commit date, so `last_commit_at` is populated for
every branch. The sweep persists a GraphQL cursor (`branch_sweep_cursor`) and
resumes across cron ticks; when it wraps a full pass, any branch not observed
during that sweep is marked deleted (`deleted_at`), which is how branch
deletions are detected. Open pull-request heads are also upserted each run so
freshly opened branches appear immediately and are shielded from pruning before
the sweep reaches them.

After the commit/tag/PR fresh pass, the Worker marks `last_sync_at`, then
back-fills older GitHub pages for those three types using D1 `meta` cursors named
`seed_<kind>_next_page`. The back-fill is **round-robin by page**: it pulls
`SYNC_SEED_PAGES_PER_TURN` pages (default 1) of tags, then commits, then pull
requests, then repeats, so every type advances together instead of finishing one
type before starting the next. The Worker also stores a `seed_plan_version`;
when that version changes, it resets the historical cursors to the first page
after each fresh window so existing partial D1 state cannot skip older pages.

Every GitHub request in a sync is counted against a per-invocation budget,
`SYNC_MAX_GITHUB_REQUESTS` (default 30). When the budget is spent, the run saves
its cursors and finishes cleanly; the next 15-minute cron tick resumes the
back-fill from where it stopped. This keeps a single invocation under the
free-plan limit of 50 external subrequests. Raise the budget toward ~45 for
faster seeding and branch sweeping, or lower it if you hit the free-plan 10 ms
CPU limit (`Error 1102`), but keep it above the per-run total consumed by the
fresh pass and branch sweep (`1 + SYNC_TAG_PAGES + SYNC_COMMIT_PAGES +
SYNC_PR_PAGES + SYNC_BRANCH_SWEEP_PAGES`, ~24 by default) so the history
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

## Branch sync via git (recommended for large repos)

GitHub has no "recently updated branches" listing (REST `/branches` is
alphabetical; GraphQL cannot order branches by commit date), so for a repo with
tens of thousands of branches the in-Worker sweep can only refresh everything on
a slow rolling cycle. The faster, simpler source of truth is **git itself**: one
shallow, treeless fetch lists every branch tip with its commit date, and a
scheduled GitHub Action pushes that full snapshot into the same D1 table.

Files:

- `.github/workflows/sync-branches.yml` - runs every 30 min (and on demand). It
  does a `git fetch --depth=1 --filter=tree:0 --prune` of `refs/heads/*` (only
  branch-tip commit objects, no trees/blobs), then `git for-each-ref` to emit
  `<sha>\t<committerdate-unix>\t<name>`.
- `workers/github-dashboard/scripts/ingest-branches.mjs` - upserts that snapshot
  into D1 in batches, then mark-and-sweeps deletions (any branch not in the
  snapshot is set `deleted_at`). Because git returns the complete authoritative
  list every run, deletion detection is exact and immediate. Run with `DRY_RUN=1`
  to preview the SQL without touching D1.

Required Actions secrets (in the repo that hosts the workflow):

- `CORE_STACK_TOKEN` - fine-grained PAT with **contents:read** on the tracked
  repo (`AppliedNeuron/core-stack`), used for the git fetch. (If you instead
  place the workflow inside `core-stack`, the built-in `GITHUB_TOKEN` works and
  this secret is unnecessary.)
- `CLOUDFLARE_API_TOKEN` - token with **D1 edit** permission. The account id and
  D1 database id are non-secret and are inlined in the workflow `env`.

To hand branches off from the Worker to the Action, set `BRANCH_SYNC_MODE` to
`external` in `wrangler.toml` `[vars]` and redeploy. The Worker then stops
touching the `branches` table (its GraphQL sweep and PR fast-path are skipped)
and continues syncing commits, tags, and PRs; the UI/API keep reading the same
`branches` table the Action now populates. Leave `BRANCH_SYNC_MODE` unset to keep
the Worker's built-in sweep as the branch source.
