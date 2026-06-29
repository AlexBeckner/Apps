# Apps

Static launcher pages for internal tools. The tools themselves are served from
Cloudflare Workers so Cloudflare Access can enforce company-only auth before any
private GitHub or Buildkite data is returned.

## Apps

- [dataspeedhashfinder](./dataspeedhashfinder/)
- [buildkitedeploymentdashboard](./buildkitedeploymentdashboard/)
- [githubdashboard](./githubdashboard/)

## Company Access

Production Worker URLs should be protected by Cloudflare Access with a one-time
PIN policy that allows only emails ending in `@applied.co` or
`@ext.applied.co`. Each Worker validates the `Cf-Access-Jwt-Assertion` header
with `TEAM_DOMAIN` and `POLICY_AUD`; leave those values unset only for local
development on `localhost`.

Tools that read private GitHub repositories should use a hosted backend proxy or
pre-generated static data; GitHub tokens must not be embedded in the browser app.
