# dataspeedhashfinder

Compares Ford GE1 Dataspeed parameter hashes across two Git refs.

Source in `AppliedNeuron/core-stack`:

`onroad/controls/dbw/dataspeed_v2/parameters/dataspeed_parameter_viewer.html`

Because `AppliedNeuron/core-stack` is private, the page reads data through the
Cloudflare Worker in `workers/dataspeed-parameter-proxy`. The GitHub token is a
Worker secret and must not be added to this static page.

After deploying the Worker, set its public URL in `config.js`:

```js
window.dataspeedHashFinderConfig = {
  apiBaseUrl: "https://dataspeedhashfinder.<account>.workers.dev",
};
```
