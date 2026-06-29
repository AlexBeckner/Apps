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
   ```

6. Enable Cloudflare Access for the production Worker URL:

   - In Cloudflare, open Workers & Pages > `github-dashboard` > Settings >
     Domains & Routes.
   - Enable Cloudflare Access for
     `https://github-dashboard.dataspeedhashfinder.workers.dev/`.
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
GITHUB_TOKEN=ghp_...
ADMIN_TOKEN=local-admin-token
ALLOWED_ORIGIN=*
GITHUB_REPO=AppliedNeuron/core-stack
```

Leave `TEAM_DOMAIN` and `POLICY_AUD` unset for localhost development. Non-local
requests fail closed unless those Cloudflare Access values are configured.

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

After that fresh pass, the Worker seeds older GitHub pages using D1 `meta`
cursors named `seed_<kind>_next_page`. The historical pass advances on every
manual or scheduled sync until GitHub returns the end of each list, so the cache
can fill in the rest of the repository history without re-fetching the same
bounded window forever. Set `SYNC_HISTORY_PAGES` in `wrangler.toml` to control
how many older pages each resource backfills per sync; if unset, it uses the
resource's normal page count.
