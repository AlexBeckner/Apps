# Dataspeed Parameter Proxy

Cloudflare Worker backend for dataspeedhashfinder.

The Worker keeps the GitHub token server-side, serves the dataspeedhashfinder UI
from `/`, and exposes two narrow API endpoints from the same protected origin:

- `GET /`
- `GET /parameter-file?ref=<ref>&file=<fileName>`
- `GET /branch-suggestions?prefix=<branchPrefix>`

Only these parameter files are allowed:

- `FORD_GE1 Gateway.json`
- `FORD_GE1 Shift.json`
- `FORD_GE1 Throttle.json`

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a fine-grained GitHub token with read-only contents access to
   `AppliedNeuron/core-stack`.

3. Store the token as a Cloudflare Worker secret:

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   ```

4. Enable Cloudflare Access for the production Worker URL:

   - In Cloudflare, open Workers & Pages > `dataspeed-parameter-proxy` >
     Settings > Domains & Routes.
   - Enable Cloudflare Access for
     `https://dataspeed-parameter-proxy.dataspeedhashfinder.workers.dev/`.
   - Configure an Allow policy for emails ending in `@applied.co` or
     `@ext.applied.co`.
   - Require the One-Time PIN login method.
   - Copy the Access team domain and Application Audience (AUD) tag into
     `TEAM_DOMAIN` and `POLICY_AUD` for this Worker.

5. Keep `ALLOWED_ORIGIN` set to the Worker-hosted URL in `wrangler.toml`.
   Override it to `*` in local `.dev.vars` if needed.

6. Deploy the Worker after confirming the public target:

   ```sh
   npx wrangler deploy
   ```

   If `TEAM_DOMAIN` and `POLICY_AUD` were set in the Cloudflare dashboard
   instead of `wrangler.toml`, deploy with `npx wrangler deploy --keep-vars`.

7. Point GitHub Pages launchers at the deployed Worker URL.

## Local Development

Create a local `.dev.vars` file:

```sh
GITHUB_TOKEN=github_pat_...
ALLOWED_ORIGIN=*
```

Leave `TEAM_DOMAIN` and `POLICY_AUD` unset for localhost development. Non-local
requests fail closed unless those Cloudflare Access values are configured.

Then run:

```sh
npm run dev
```

Do not commit `.dev.vars`; it contains the GitHub token.
