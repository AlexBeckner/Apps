# Apps

A launcher plus a set of internal tools, all served from Cloudflare Workers so
the Workers can enforce company-only email-code auth before any private GitHub or
Buildkite data is returned. Source for each Worker lives under `workers/`; deploy
them all with `workers/deployall`.

## Launcher

- [home](https://home.appliedapps.workers.dev/) — `workers/home`

## Apps

- [dataspeedhashfinder](https://dataspeed-parameter-proxy.appliedapps.workers.dev/) — `workers/dataspeed-parameter-proxy`
- [deploydashboard](https://deploydashboard.appliedapps.workers.dev/) — `workers/deploydashboard`
- [githubdashboard](https://github-dashboard.appliedapps.workers.dev/) — `workers/github-dashboard`
- [logsearch](https://log-search.appliedapps.workers.dev/) — `workers/log-search`

## Company Access

Production Worker URLs use an app-level shared-password flow. Users enter the
access password and get a signed session cookie after verification. Each Worker
needs an `ACCESS_PASSWORD` secret and an `AUTH_SECRET` secret.

Tools that read private GitHub repositories should use a hosted backend proxy or
pre-generated static data; GitHub tokens must not be embedded in the browser app.
