# github-dashboard Worker

Cloudflare Worker backend for `githubdashboard`.

The Worker serves the dashboard UI plus JSON API from a protected origin, reading
everything from D1. **It no longer syncs on its own** — all data is loaded into D1
by three git-based GitHub Actions (branches; commits + tags; PRs), each running
hourly. "Sync now" dispatches all three at once via the GitHub API. The Worker
still keeps `GITHUB_TOKEN` server-side for a few lazy request-time reads (PR
bodies, commit messages, live per-branch commit lists).

## Endpoints

- `GET /` - dashboard UI
- `GET /api/health`
- `GET /api/summary`
- `GET /api/search?q=<query>&limit=<n>`
- `GET /api/branches?limit=<n>&offset=<n>&sort=name|last_commit_at`
- `GET /api/tags?limit=<n>&offset=<n>`
- `GET /api/commits?limit=<n>&offset=<n>`
- `GET /api/prs?state=all|open|closed|merged&limit=<n>&offset=<n>`
- `GET /api/sync/status` - per-source last-synced times (from D1 `meta`)
- `POST /api/sync` - dispatches the three sync workflows via the GitHub API

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
   npx wrangler secret put ACTIONS_DISPATCH_TOKEN
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put ACCESS_PASSWORD
   ```

   - `GITHUB_TOKEN` needs read access to `GITHUB_REPO` (the lazy request-time reads).
   - `ACTIONS_DISPATCH_TOKEN` is a PAT with **Actions: read and write** on
     `ACTIONS_REPO` (the repo hosting the workflows, default `AlexBeckner/Apps`).
     It lets "Sync now" dispatch the three workflows. Without it the scheduled
     hourly runs still work; only the button is disabled.
   - `AUTH_SECRET` should be a long random string, at least 32 characters.
   - `ACCESS_PASSWORD` is the shared password for the app login page.

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
ACTIONS_DISPATCH_TOKEN=ghp_...
AUTH_SECRET=local-dev-auth-secret-at-least-32-chars
ACCESS_PASSWORD=local-dev-access-password
ALLOWED_ORIGIN=*
GITHUB_REPO=AppliedNeuron/core-stack
ACTIONS_REPO=AlexBeckner/Apps
```

Then run:

```sh
npm run migrate:local
npm run dev
```

Do not commit `.dev.vars`; it contains secrets.

## Syncing (git-based GitHub Actions)

Cloudflare Workers cannot run `git` or touch a filesystem, and the GitHub REST/
GraphQL APIs cannot enumerate a large monorepo (tens of thousands of branches,
hundreds of thousands of commits) within a Worker's subrequest/CPU limits. So the
Worker does **no syncing at all**. Three scheduled GitHub Actions own the data,
each taking one authoritative `git` snapshot per run and writing straight to D1:

| Workflow | Source | Writes to D1 | Cron |
| --- | --- | --- | --- |
| `sync-branches.yml` | `git for-each-ref refs/heads` | `branches` | hourly (`:25`) |
| `sync-commits.yml` | `git log --all` + `git for-each-ref refs/tags` | `commits`, `tags` | hourly (`:25`) |
| `sync-prs.yml` | REST `/pulls?state=all` | `prs` | hourly (`:25`) |

All three fire at the same time (`:25`) and run as independent, concurrent
workflow runs — the same simultaneous dispatch the "Sync now" button already
triggers. They touch disjoint tables, except that `sync-commits` also snapshots
branch heads (for DAG/branch consistency) using the same mark-and-sweep as
`sync-branches`; those two don't collide in practice because the commits run
reaches its branch-snapshot step only after a multi-minute blobless clone +
`git log --all`, long after the fast standalone branch run has finished.

Each ingest script records a per-source watermark in `meta`
(`branch_external_synced_at`, `commit_git_synced_at`, `tag_git_synced_at`,
`pr_git_synced_at`). `GET /api/sync/status` reports those as the per-source
"last synced" times (shown in the "Last synced" hover tooltip in the UI), so each
sync is independently verifiable.

**"Sync now"** (`POST /api/sync`) dispatches all three workflows at once via the
GitHub Actions REST API, using the `ACTIONS_DISPATCH_TOKEN` secret (a PAT with
`actions:read`+`write` on `ACTIONS_REPO`). The button then shows "running" until
every source reports a run newer than the dispatch (capped at 15 min). Scheduled
runs happen hourly regardless of the button.

The Worker still reads a few things from GitHub **lazily at request time** (never
on a schedule), using `GITHUB_TOKEN`: an off-branch commit's message, a PR's
body, and a non-default branch's live commit list/count. These are cached back
into D1 on first view.

Shared Actions secrets (in the repo that hosts the workflows, `ACTIONS_REPO`):

- `CORE_STACK_TOKEN` - fine-grained PAT on the tracked repo
  (`AppliedNeuron/core-stack`). Needs **contents:read** (git fetch for branches,
  commits, tags) and **pull-requests:read** (the PR sync). A classic PAT with
  `repo` scope also works. (If the workflows lived inside `core-stack`, the
  built-in `GITHUB_TOKEN` would cover this.)
- `CLOUDFLARE_API_TOKEN` - token with **D1 edit** permission. The account id and
  D1 database id are non-secret and are inlined in each workflow's `env`.

### Branch sync

- `.github/workflows/sync-branches.yml` - `git fetch --depth=1 --filter=tree:0
  --prune` of `refs/heads/*` (branch-tip commits only, no trees/blobs), then
  `git for-each-ref` emits `<sha>\t<committerdate-unix>\t<name>`.
- `workers/github-dashboard/scripts/ingest-branches.mjs` - upserts that snapshot
  into `branches` (with `last_commit_at` from the commit date), then mark-and-
  sweeps deletions via `last_seen_at` (any branch not in the snapshot is set
  `deleted_at`). git returns the complete authoritative list every run, so
  deletion detection is exact and immediate. `DRY_RUN=1 node …/ingest-branches.mjs
  snapshot.tsv` previews the SQL.

### Commit + tag sync

- `.github/workflows/sync-commits.yml` - keeps a cached, **blobless**
  (`--filter=blob:none`) bare clone of `refs/heads/*` **and** `refs/tags/*` (all
  commits + trees, no file blobs). Blobless (not treeless) is required so
  `git log --all` never lazily fetches a tree mid-walk (that fetch would fail
  because credentials aren't persisted on the cached repo).
- `workers/github-dashboard/scripts/ingest-commits.mjs` - streams `git log --all`
  and upserts every commit into `commits` (**metadata + subject only**, no message
  body, to keep D1 lean). It writes `default_commit_count` and
  `commit_total_count` to `meta` and advances a `commit_git_synced_at` watermark,
  so each run only enumerates commits since the last (`FULL=1` or the workflow's
  **full** input re-ingests everything).
- `workers/github-dashboard/scripts/ingest-tags.mjs` - runs
  `git for-each-ref refs/tags` on the same clone and upserts every tag into `tags`
  (dereferencing annotated tags to their commit), then prunes tags no longer
  present. Advances a `tag_git_synced_at` watermark. `DRY_RUN=1
  REPO_DIR=<clone> node …/ingest-tags.mjs` previews the SQL.

### PR sync

- `.github/workflows/sync-prs.yml` - the first run should use the **full** input
  to walk every page; scheduled hourly runs are incremental (bounded by a
  `pr_git_synced_at` watermark + a small overlap window).
- `workers/github-dashboard/scripts/ingest-prs.mjs` - paginates
  `/repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc` and upserts
  metadata into `prs` (`ON CONFLICT(number) DO UPDATE`, since PRs mutate). It
  stores **no body** (lazily fetched on first view, like commits) and advances the
  `pr_git_synced_at` watermark. `DRY_RUN=1 SINCE="2 days ago" GITHUB_TOKEN=…
  GITHUB_REPO=owner/name node …/ingest-prs.mjs` previews.

### Storage model (fitting D1's 500 MB free-plan cap)

A full monorepo (hundreds of thousands of commits, tens of thousands of branches
+ PRs) does not fit in the 500 MB free-plan database if we store a commit parent
DAG and full PR bodies. So the schema is deliberately lean:

- **No commit parent DAG.** The old `commit_parents` table (~100 MB with indexes)
  is dropped. Instead, commits carry an `on_default` flag, set for commits
  reachable from the default branch.
- **PR/commit bodies are not stored in bulk** (PR bodies alone were ~90 MB).
  Bodies and off-branch commit messages are fetched from GitHub and cached the
  first time an item is opened.

How it surfaces in the dashboard:

- The **Commits tab** and the home **commits** badge show **every commit across
  all branches** (`commit_total_count` for the count, `idx_commits_committed` for
  the list). The `on_default` flag still backs the default branch's page and the
  `default_commit_count` stat.
- **Branch pages**: the default branch is served from D1 (`on_default`); every
  other branch fetches its commit list live from the GitHub API (one request for
  the exact count via the `Link` header, one or two for the visible page).
- **Search** matches commit metadata on any branch (all are in the `commits`
  table). Per-branch search on non-default branches is best-effort over the
  fetched page, since GitHub's commits API has no text search.
- **Commit detail** for an off-branch commit and **PR detail** bodies are lazily
  fetched from GitHub on first view and cached back into D1.
