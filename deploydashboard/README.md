# deploydashboard

Static GitHub Pages version of the Buildkite deployment dashboard.

The UI is copied from `~/deploydashboard/static/index.html` and runs
as a static page. The Cloudflare Worker in `workers/deploydashboard`
keeps `BUILDKITE_API_TOKEN` server-side and stores deployment history in D1.

## Configure

Edit `config.js` when the dashboard URL changes:

```js
window.deployDashboardConfig = {
  apiBaseUrl: "https://deploydashboard.appliedapps.workers.dev",
};
```

Replace the URL if Wrangler reports a different `workers.dev` subdomain.

## Backend

```bash
cd workers/deploydashboard
npm install
npm run deploy
```

Keep `BUILDKITE_API_TOKEN` and `ADMIN_TOKEN` in Worker secrets. Do not copy
tokens into this static site.

## Refresh and Sync

The GitHub Pages UI is read-only until you click **Unlock controls** and enter
the Worker `ADMIN_TOKEN`. The token is saved in this browser's `localStorage`
and sent as `X-Dashboard-Admin-Token` only to the Cloudflare Worker.

For this machine, the current admin token is also stored in the gitignored
`workers/deploydashboard/.dev.vars` file.
