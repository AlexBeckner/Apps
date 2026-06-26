# Rig Deployment Dashboard

Static launcher for the Cloudflare-hosted deployment dashboard.

The dashboard itself is not hosted by GitHub Pages. The Cloudflare Worker in
`workers/rig-deployment-dashboard` keeps `BUILDKITE_API_TOKEN` server-side,
stores deployment history in D1, and serves the live dashboard UI.

## Configure

Edit `config.js` when the dashboard URL changes:

```js
window.rigDeploymentDashboardConfig = {
  dashboardUrl: "https://rig-deployment-dashboard.dataspeedhashfinder.workers.dev",
};
```

Replace the URL if Wrangler reports a different `workers.dev` subdomain.

## Backend

```bash
cd workers/rig-deployment-dashboard
npm install
npm run deploy
```

Keep `BUILDKITE_API_TOKEN` and `ADMIN_TOKEN` in Worker secrets. Do not copy
tokens into this static site.
