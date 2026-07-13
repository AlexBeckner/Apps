import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("route UI exposes every element required by route.js", async () => {
  const [html, routeScript] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
  ]);
  const requiredIds = Array.from(
    routeScript.matchAll(/byId\("([^"]+)"\)/g),
    (match) => match[1]
  );

  assert.ok(requiredIds.length > 10);
  for (const id of requiredIds) {
    assert.match(
      html,
      new RegExp(`\\bid=["']${escapeRegex(id)}["']`),
      `missing #${id}`
    );
  }
});

test("route dependencies load before the main inline application", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  const archives = html.indexOf('<script src="archives.js"></script>');
  const core = html.indexOf('<script src="route-core.js"></script>');
  const route = html.indexOf('<script src="route.js"></script>');
  const inline = html.indexOf("<script>", route);

  assert.ok(archives >= 0);
  assert.ok(archives < core);
  assert.ok(core < route);
  assert.ok(route < inline);
});

test("map layer control defaults to OSM and offers satellite imagery", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);
  const control = html.match(
    /<select id="route-map-style"[\s\S]*?<\/select>/
  )?.[0];

  assert.ok(control);
  assert.match(control, /<option value="osm" selected>Street \(OSM\)<\/option>/);
  assert.match(control, /<option value="satellite">Satellite<\/option>/);
  assert.match(control, /<option value="local">Local plot<\/option>/);
  assert.match(routeScript, /USGSImageryOnly\/MapServer\/tile/);
  assert.match(
    routeScript,
    /mapStyleSelect\.addEventListener\("change", changeMapStyle\)/
  );
  assert.match(html, /USDA, USGS The National Map/);
  assert.match(css, /\.route-map-buttons select\s*\{/);
});

test("route workspace places events before an interactive map", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);
  const workspace = html.indexOf('id="route-workspace"');
  const events = html.indexOf('id="route-events"', workspace);
  const map = html.indexOf('id="route-map-frame"', workspace);

  assert.ok(workspace >= 0);
  assert.ok(events > workspace);
  assert.ok(map > events);
  assert.match(routeScript, /addEventListener\("pointerdown"/);
  assert.match(routeScript, /addEventListener\("wheel"/);
  assert.match(routeScript, /event\.ctrlKey \? 0\.01 : 0\.0025/);
  assert.match(
    routeScript,
    /event\.target\.closest\("\.route-event-marker"\)/
  );
  assert.match(routeScript, /Math\.log2\(next\.distance \/ previous\.distance\)/);
  assert.match(routeScript, /selectEvent\(index, true\)/);
  assert.match(routeScript, /setHoveredEvent\(index, true\)/);
  assert.match(routeScript, /showEventTooltip\(eventIndex, event\)/);
  assert.match(routeScript, /class: "route-engaged-path"/);
  assert.match(
    routeScript,
    /state\.currentMarker = svgElement\("path",[\s\S]*currentMarkerTransform/
  );
  assert.match(html, /id="route-engaged-legend" hidden/);
  assert.match(css, /\.route-workspace\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.route-map-frame\s*\{[^}]*touch-action:\s*none/s);
  assert.match(css, /\.route-engaged-path\s*\{[^}]*stroke:\s*#52d273/s);
  assert.match(css, /\.route-current-marker\s*\{[^}]*fill:\s*#fff/s);
  assert.match(css, /\.route-event-button\.is-active/);
  assert.match(css, /\.route-event-button\.is-hovered/);
});

test("timestamped viewer lines can create manual route events", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);

  assert.match(html, /data-event-timestamp=/);
  assert.match(html, /window\.LogRoute\.addEventFromLog\(/);
  assert.match(html, /class="viewer-event-status"/);
  assert.match(html, /\.v-line\.v-eventable/);
  assert.match(html, /\.v-line\.v-event-added/);
  assert.match(routeScript, /function addEventFromLog\(/);
  assert.match(routeScript, /addEventFromLog, hasEventFromLog, setSelection/);
  assert.match(routeScript, /function removeManualEvent\(/);
  assert.match(routeScript, /removeButton\.className = "route-event-remove"/);
  assert.match(routeScript, /if \(event\.source === "manual"\)/);
  assert.match(css, /\.route-event-remove/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
