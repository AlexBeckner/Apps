# logsearch

Static GitHub Pages redirect to the Log Search tool.

This folder is just a redirect (`index.html`) to the Cloudflare Worker in
`workers/log-search`, which gates access with the shared company password and
then serves the app.

The tool reads a chosen log folder entirely in the browser and searches every
line of every file for terms like `ERROR` and `FATAL`. No file is uploaded.

If the Worker URL changes, update the redirect target in `index.html` and the
link in the repo-root `index.html`.
