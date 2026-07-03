# Log Search

Cloudflare Worker that hosts the Log Search tool.

Upload/pick a log folder and search every line of every file for terms like
`ERROR` and `FATAL`. The scan runs **entirely in the browser** using the File
API and streaming reads, so no log file is ever uploaded to the Worker. That
also means it handles large folders without hitting any request-size limits.

Compressed archives are expanded automatically, in the browser, using the
native `DecompressionStream` API -- so a folder full of `.tar.gz` bundles (or a
single `.zip`) is searched just like a plain folder, and the archives are never
uploaded either.

The Worker itself only does two things:

- Gate access with the shared company password (`companyAuthResponse`, reused
  from `../github-dashboard/src/company-auth.js`).
- Serve the static app in `./public` (`GET /`, `GET /config.js`, and a
  `GET /health` check).

## Features

- Pick a folder or drag & drop one onto the page (or choose archive files
  directly).
- Expands compressed archives automatically and searches the files inside:
  `.zip`, `.tar`, `.tar.gz` / `.tgz`, and single-file `.gz`. Matches inside an
  archive are shown with an archive-qualified path (e.g.
  `logs.tgz/app/server.log`).
- Comma-separated search terms (default `ERROR, FATAL`), with quick-add chips
  for `WARN`, `CRITICAL`, `Exception`, etc.
- Case-sensitive and regular-expression toggles.
- Streams each file line-by-line, skips binary files (NUL sniff), and shows
  live progress + a cancel button.
- Summary counts, per-term filter chips, a results filter box, and a
  "Download CSV" export of all matches.

### Archive handling

`public/archives.js` reads archives with no external dependencies:

- **ZIP**: parses the central directory (including ZIP64) and reads each entry's
  bytes via `Blob.slice`, so only the needed ranges are touched. Stored (method
  0) and DEFLATE (method 8) entries are supported; encrypted or otherwise
  unsupported entries are reported and skipped.
- **TAR / TAR.GZ / TGZ**: streamed and parsed block-by-block (ustar + GNU long
  names + pax `path`), decompressing `.gz` on the fly.
- **GZIP**: a single `.gz` file is decompressed to one logical file.

Corrupt archives and unsupported entries are counted and surfaced in a note
under the results summary rather than aborting the whole scan.

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

Automatic archive expansion additionally needs the `DecompressionStream` API
with `deflate-raw` support (Chrome/Edge 103+, Firefox 113+, Safari 16.4+). On
older browsers, plain-folder scanning still works and archives are simply
skipped with a note.
