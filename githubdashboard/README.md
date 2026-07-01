# githubdashboard

Static GitHub Pages version of the GitHub dashboard.

The UI runs as a static page and calls the Cloudflare Worker in
`workers/github-dashboard`. The Worker keeps `GITHUB_TOKEN` server-side and
caches GitHub metadata in D1.

## Configure

Edit `config.js` when the Worker URL changes:

```js
window.githubDashboardConfig = {
  apiBaseUrl: "https://github-dashboard.appliedapps.workers.dev",
};
```

## Backend

```bash
cd workers/github-dashboard
npm install
```

Create the D1 database, copy the returned database id into `wrangler.toml`, then
apply migrations:

```bash
npx wrangler d1 create github-dashboard
npm run migrate:remote
```

Store secrets in Cloudflare, never in this static site:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Deploy only after confirming the public target:

```bash
npm run deploy
```

## Notes

The hosted Worker caches repository branches, tags, recent default-branch
commits, and PR metadata from the GitHub API. It does not use the local git clone
from `/Users/alexbeckner/github-dashboard`, so local-only graph features like
full branch containment are intentionally not part of this static version.
