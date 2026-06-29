# Apps

Static web tools hosted with GitHub Pages.

## Apps

- [dataspeedhashfinder](./dataspeedhashfinder/)
- [buildkitedeploymentdashboard](./buildkitedeploymentdashboard/)
- [githubdashboard](./githubdashboard/)

## Notes

These tools are static pages. Tools that read private GitHub repositories should
use a hosted backend proxy or pre-generated static data; GitHub tokens must not
be embedded in the browser app.

`githubdashboard` is a static GitHub Pages app backed by the Cloudflare Worker
in `workers/github-dashboard`; its GitHub token and D1 cache stay on the server
side.
