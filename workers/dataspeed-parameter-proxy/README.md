# Dataspeed Parameter Proxy

Cloudflare Worker backend for the Dataspeed Parameter Hash Viewer.

The Worker keeps the GitHub token server-side and exposes only two narrow
endpoints for the static GitHub Pages app:

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

4. Set `ALLOWED_ORIGIN` in `wrangler.toml` to the GitHub Pages origin that will
   host the viewer. `*` is convenient for testing, but the deployed Worker
   should use the real Pages origin.

5. Deploy the Worker:

   ```sh
   npx wrangler deploy
   ```

6. Copy the deployed Worker URL into
   `apps/dataspeed-parameter-viewer/config.js` as `apiBaseUrl`.

## Local Development

Create a local `.dev.vars` file:

```sh
GITHUB_TOKEN=github_pat_...
ALLOWED_ORIGIN=*
```

Then run:

```sh
npm run dev
```

Do not commit `.dev.vars`; it contains the GitHub token.
