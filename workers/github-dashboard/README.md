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

The Worker only syncs the **default branch's** commits (that is what the REST
`/commits` endpoint returns and what the "Commits" tab shows). Commits that live
only on other branches are ingested from git by a separate Action — see
[Commit sync via git](#commit-sync-via-git-all-branches). Pull requests are
already all-branch (the Worker lists `state=all`, covering every head/base ref).

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

## Commit sync via git (all branches)

The Worker only knows about default-branch commits. To surface commits that live
on other branches (so branch pages, PR pages, and search show real history
instead of just a branch tip), commit metadata for **every** branch is ingested
from git — the same "let git enumerate it" approach used for branches.

Files:

- `.github/workflows/sync-commits.yml` - runs hourly (and on demand). It keeps a
  cached, blobless (`--filter=blob:none`) bare clone of `refs/heads/*` (all
  commits + all trees, no file blobs) and runs `git log --all` to list every
  commit with its author, dates, and subject. Blobless (not treeless) is required
  so `git log` never has to lazily fetch a tree mid-walk - a treeless clone would,
  and that fetch fails because credentials aren't persisted on the cached repo.
- `workers/github-dashboard/scripts/ingest-commits.mjs` - streams that output and
  upserts it into the `commits` table in batches. It stores **metadata + subject
  only** (no message body, to keep D1 lean) and uses `INSERT ... ON CONFLICT DO
  NOTHING` so it never overwrites the richer rows the Worker writes for
  default-branch commits. It writes `default_commit_count` and `commit_total_count`
  to `meta`, and advances a `commit_git_synced_at` watermark so each run only
  enumerates commits since the last one (the first run, or `FULL=1` / the
  workflow's **full** input, ingests the entire history). Run with
  `DRY_RUN=1 REPO_DIR=<path-to-a-clone> GITHUB_REPO=owner/name` to preview the SQL
  without touching D1.

Required Actions secrets are the same as the branch sync (`CORE_STACK_TOKEN`,
`CLOUDFLARE_API_TOKEN`); the account id and D1 id are inlined in the workflow.

### PR back-fill via GitHub Actions

The Worker back-fills PRs only a few REST pages per cron tick (free-plan
subrequest cap), so for a repo with ~100k PRs the merged/closed counts stay
understated for hours. A dedicated Action walks the whole list in one run instead:

- `.github/workflows/sync-prs.yml` - runs every 6h (and on demand). The first run
  should use the **full** input to walk every page; scheduled runs are incremental.
- `workers/github-dashboard/scripts/ingest-prs.mjs` - paginates
  `/repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc` with the
  full authenticated budget and upserts metadata into `prs` (`ON CONFLICT(number)
  DO UPDATE`, since PRs mutate). It stores **no body** (lazily fetched on first
  view, like commits), advances a `pr_git_synced_at` watermark, and on a
  completed full walk sets `seed_prs_complete = 1` so the Worker stops its own
  slow back-fill (its fresh pass still keeps recently-updated PRs current). Run
  with `DRY_RUN=1 SINCE="2 days ago" GITHUB_TOKEN=... GITHUB_REPO=owner/name` to
  preview.

`CORE_STACK_TOKEN` must have **pull-requests:read** (fine-grained) or `repo`
scope (classic) - not just `contents:read` - for this workflow.

### Storage model (fitting D1's 500 MB free-plan cap)

A full monorepo (hundreds of thousands of commits, tens of thousands of branches
+ PRs) does not fit in the 500 MB free-plan database if we store a commit parent
DAG and full PR bodies. So the schema is deliberately lean:

- **No commit parent DAG.** The old `commit_parents` table (~100 MB with indexes)
  is dropped. Instead, commits carry an `on_default` flag: the Worker sets it for
  every default-branch commit it syncs, and the git ingest leaves it 0 for
  off-branch commits.
- **PR bodies are not stored in bulk** (they were ~90 MB). `upsertPrs` writes
  `NULL` for `body`; the body is fetched from GitHub and cached the first time a
  PR is opened.

How it surfaces in the dashboard:

- The **Commits tab** and the home **commits** badge show **every commit across
  all branches** (`commit_total_count` for the count, `idx_commits_committed` for
  the list). The `on_default` flag still backs the default branch's page and the
  `default_commit_count` stat, but the global list is the full cross-branch view.
- **Branch pages**: the default branch is served from D1 (`on_default`); every
  other branch fetches its commit list live from the GitHub API (one request for
  the exact count via the `Link` header, one or two for the visible page).
- **Search** matches commit metadata on any branch (all are in the `commits`
  table). Per-branch search on non-default branches is best-effort over the
  fetched page, since GitHub's commits API has no text search.
- **Commit detail** for an off-branch commit and **PR detail** bodies are lazily
  fetched from GitHub on first view and cached back into D1.

No Worker env changes are required: the Worker keeps syncing default-branch
commits for near-real-time freshness, and the Action fills in the rest.
