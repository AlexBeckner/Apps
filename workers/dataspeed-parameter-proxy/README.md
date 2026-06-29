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
   npx wrangler secret put AUTH_SECRET
   ```

   `AUTH_SECRET` should be a long random string, at least 32 characters.

4. Configure Cloudflare Email Service:

   - In Cloudflare, go to Compute > Email Service > Email Sending.
   - Onboard the sending domain you want to use.
   - Set `FROM_EMAIL` on the Worker to an address on that domain, for example
     `internal-tools@example.com`.
   - `wrangler.toml` already includes the `EMAIL` send binding.

5. Keep `ALLOWED_ORIGIN` set to the Worker-hosted URL in `wrangler.toml`.
   Override it to `*` in local `.dev.vars` if needed.

6. Deploy the Worker after confirming the public target:

   ```sh
   npx wrangler deploy
   ```

   If `FROM_EMAIL` was set in the Cloudflare dashboard instead of
   `wrangler.toml`, deploy with `npx wrangler deploy --keep-vars`.

7. Point GitHub Pages launchers at the deployed Worker URL.

## Local Development

Create a local `.dev.vars` file:

```sh
GITHUB_TOKEN=github_pat_...
AUTH_SECRET=local-dev-auth-secret-at-least-32-chars
FROM_EMAIL=internal-tools@example.com
ALLOWED_ORIGIN=*
```

Then run:

```sh
npm run dev
```

Do not commit `.dev.vars`; it contains the GitHub token.
