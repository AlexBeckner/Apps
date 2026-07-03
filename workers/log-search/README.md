# Log Search

Cloudflare Worker that hosts the Log Search tool.

Upload/pick a log folder and search every line of every file for terms like
`ERROR` and `FATAL`. The scan runs **entirely in the browser** using the File
API and streaming reads, so no log file is ever uploaded to the Worker. That
also means it handles large folders without hitting any request-size limits.

The Worker itself only does two things:

- Gate access with the shared company password (`companyAuthResponse`, reused
  from `../github-dashboard/src/company-auth.js`).
- Serve the static app in `./public` (`GET /`, `GET /config.js`, and a
  `GET /health` check).

## Features

- Pick a folder or drag & drop one onto the page.
- Comma-separated search terms (default `ERROR, FATAL`), with quick-add chips
  for `WARN`, `CRITICAL`, `Exception`, etc.
- Case-sensitive and regular-expression toggles.
- Streams each file line-by-line, skips binary files (NUL sniff), and shows
  live progress + a cancel button.
- Summary counts, per-term filter chips, a results filter box, and a
  "Download CSV" export of all matches.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Store the auth secrets as Cloudflare Worker secrets:

   ```sh
   npx wrangler secret put AUTH_SECRET
   npx wrangler secret put ACCESS_PASSWORD
   ```

   `AUTH_SECRET` should be a long random string, at least 32 characters.
   `ACCESS_PASSWORD` is the shared password for the app login page.

3. Deploy the Worker after confirming the public target:

   ```sh
   npm run deploy
   ```

4. The GitHub Pages launcher (repo-root `index.html` and `logsearch/`) already
   points at `https://log-search.appliedapps.workers.dev/`. Update those if the
   deployed Worker URL differs.

## Local Development

Create a local `.dev.vars` file:

```sh
AUTH_SECRET=local-dev-auth-secret-at-least-32-chars
ACCESS_PASSWORD=local-dev-access-password
```

Then run:

```sh
npm run dev
```

Do not commit `.dev.vars`.

## Browser support

The tool relies on directory selection (`webkitdirectory`) and
`TextDecoderStream`. Use a recent Chrome, Edge, or Safari. The page shows a
warning if `TextDecoderStream` is unavailable.
