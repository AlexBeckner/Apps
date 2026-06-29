# Apps

Static launcher pages for internal tools. The tools themselves are served from
Cloudflare Workers so the Workers can enforce company-only email-code auth before
any private GitHub or Buildkite data is returned.

## Apps

- [dataspeedhashfinder](./dataspeedhashfinder/)
- [buildkitedeploymentdashboard](./buildkitedeploymentdashboard/)
- [githubdashboard](./githubdashboard/)

## Company Access

Production Worker URLs use an app-level shared-password flow. Users enter the
access password and get a signed session cookie after verification. Each Worker
needs an `ACCESS_PASSWORD` secret and an `AUTH_SECRET` secret.

Tools that read private GitHub repositories should use a hosted backend proxy or
pre-generated static data; GitHub tokens must not be embedded in the browser app.
