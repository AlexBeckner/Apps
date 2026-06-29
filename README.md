# Apps

Static launcher pages for internal tools. The tools themselves are served from
Cloudflare Workers so the Workers can enforce company-only email-code auth before
any private GitHub or Buildkite data is returned.

## Apps

- [dataspeedhashfinder](./dataspeedhashfinder/)
- [buildkitedeploymentdashboard](./buildkitedeploymentdashboard/)
- [githubdashboard](./githubdashboard/)

## Company Access

Production Worker URLs use an app-level one-time code flow. Users enter an
`@applied.co` or `@ext.applied.co` email address, receive a code through
Cloudflare Email Service, and get a signed session cookie after verification.
Each Worker needs an `EMAIL` send binding, a `FROM_EMAIL` variable, and an
`AUTH_SECRET` secret.

Tools that read private GitHub repositories should use a hosted backend proxy or
pre-generated static data; GitHub tokens must not be embedded in the browser app.
