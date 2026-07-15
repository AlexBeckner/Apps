import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  const persistence = html.indexOf('<script src="persistence.js"></script>');
  const core = html.indexOf('<script src="route-core.js"></script>');
  const route = html.indexOf('<script src="route.js"></script>');
  const inline = html.indexOf("<script>", route);

  assert.ok(archives >= 0);
  assert.ok(archives < persistence);
  assert.ok(persistence < core);
  assert.ok(core < route);
  assert.ok(route < inline);
});

test("main inline application has valid JavaScript syntax", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  const start = html.lastIndexOf("<script>") + "<script>".length;
  const end = html.indexOf("</script>", start);

  assert.ok(start >= "<script>".length);
  assert.ok(end > start);
  assert.doesNotThrow(() => new vm.Script(html.slice(start, end)));
});

test("uploaded files and search state persist in IndexedDB", async () => {
  const [html, persistenceScript] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/persistence.js", root), "utf8"),
  ]);

  assert.match(persistenceScript, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(persistenceScript, /createObjectStore\(FILE_STORE/);
  assert.match(persistenceScript, /createObjectStore\(STATE_STORE/);
  assert.match(persistenceScript, /async function replaceSession\(/);
  assert.match(persistenceScript, /async function saveState\(/);
  assert.match(persistenceScript, /async function loadSession\(/);
  assert.match(persistenceScript, /new root\.File\(\[record\.blob\]/);
  assert.match(html, /function captureSessionState\(/);
  assert.match(html, /async function restoreCachedSession\(/);
  assert.match(html, /await runSearch\(\{ restoreState: snapshot \}\)/);
  assert.match(html, /void restoreCachedSession\(\)/);
  assert.match(html, /id="clear-cache"/);
});

test("uploads can replace or add files by picker and drag position", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");

  assert.match(html, /id="new-file"/);
  assert.match(html, /id="new-folder"/);
  assert.match(html, /id="add-file"/);
  assert.match(html, /id="add-folder"/);
  assert.match(
    html,
    /class="dropzone-group" role="group" aria-label="New selection"/
  );
  assert.match(
    html,
    /class="dropzone-group" role="group" aria-label="Add to selection"/
  );
  assert.doesNotMatch(html, /id="source-picker"/);
  assert.match(html, /<input id="files" type="file" multiple>/);
  assert.match(
    html,
    /<input id="folder" type="file" webkitdirectory directory multiple>/
  );
  assert.match(html, /function pickFiles\(mode = "replace"\)/);
  assert.match(html, /function pickFolder\(mode = "replace"\)/);
  assert.match(
    html,
    /newFileBtn\.addEventListener\("click", \(\) => pickFiles\("replace"\)\)/
  );
  assert.match(
    html,
    /newFolderBtn\.addEventListener\("click", \(\) => pickFolder\("replace"\)\)/
  );
  assert.match(
    html,
    /addFileBtn\.addEventListener\("click", \(\) => pickFiles\("add"\)\)/
  );
  assert.match(
    html,
    /addFolderBtn\.addEventListener\("click", \(\) => pickFolder\("add"\)\)/
  );
  assert.match(html, /data-drop-mode="replace"/);
  assert.match(html, /data-drop-mode="add"/);
  assert.match(html, /function mergeSelections\(existing, incoming\)/);
  assert.match(
    html,
    /mode === "add"\s*\?\s*mergeSelections\(selected, files\)/
  );
  assert.match(
    html,
    /return clientX < window\.innerWidth \/ 2 \? "replace" : "add"/
  );
  assert.match(
    html,
    /ingestDataTransfer\(event\.dataTransfer, selectionMode\)/
  );
});

test("map layer control defaults to satellite and offers dark streets", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);
  const control = html.match(
    /<select id="route-map-style"[\s\S]*?<\/select>/
  )?.[0];

  assert.ok(control);
  assert.match(
    control,
    /<option value="satellite" selected>Satellite \(NAIP\)<\/option>/
  );
  assert.match(
    control,
    /<option value="dark">Dark streets \(OSM\)<\/option>/
  );
  assert.match(control, /<option value="osm">Street \(OSM\)<\/option>/);
  assert.match(control, /<option value="local">Local plot<\/option>/);
  assert.match(routeScript, /USGSNAIPPlus\/ImageServer\/exportImage/);
  assert.match(routeScript, /bboxSR: "3857"/);
  assert.match(
    routeScript,
    /dark:\s*\{[\s\S]*?tile\.openstreetmap\.org/
  );
  assert.match(routeScript, /tileStyle: "satellite"/);
  assert.match(
    routeScript,
    /mapStyleSelect\.addEventListener\("change", changeMapStyle\)/
  );
  assert.match(html, /USGS, USDA, The National Map/);
  assert.doesNotMatch(html, /carto\.com/);
  assert.match(css, /\.route-tiles\.is-dark\s*\{[^}]*filter:/s);
  assert.match(css, /\.route-map-buttons select\s*\{/);
  assert.match(
    routeScript,
    /mapFrame\.classList\.toggle\("is-dark-map", state\.tileStyle === "dark"\)/
  );
  assert.match(
    css,
    /\.route-map-frame\.is-dark-map \.route-progress-path\s*\{[^}]*stroke:\s*#fff/s
  );
});

test("point overlays are opt-in while route hit targets remain", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);
  const correctedInput = html.match(
    /<input id="route-include-corrected"[^>]*>/
  )?.[0];
  const propagatedInput = html.match(
    /<input id="route-include-propagated"[^>]*>/
  )?.[0];

  assert.ok(correctedInput);
  assert.ok(propagatedInput);
  assert.doesNotMatch(correctedInput, /\bchecked\b/);
  assert.doesNotMatch(propagatedInput, /\bchecked\b/);
  assert.match(html, /Show GPS-corrected points/);
  assert.match(html, /Show odometry points/);
  assert.match(
    routeScript,
    /state\.trace = core\.buildTrace\(state\.result, true\)/
  );
  assert.match(
    routeScript,
    /point\.kind === "corrected"[\s\S]*?correctedInput\.checked[\s\S]*?point\.kind === "propagated"[\s\S]*?propagatedInput\.checked/
  );
  assert.match(routeScript, /marker\.classList\.add\("is-hidden"\)/);
  assert.match(
    routeScript,
    /correctedInput\.addEventListener\("change", changePointMarkers\)/
  );
  assert.match(
    routeScript,
    /propagatedInput\.addEventListener\("change", changePointMarkers\)/
  );
  assert.match(
    css,
    /\.route-point-marker\.is-hidden\s*\{[^}]*opacity:\s*0/s
  );
  assert.match(
    css,
    /\.route-point-marker\.is-hidden:hover,[\s\S]*?\.route-point-marker\.is-hidden\.is-selected\s*\{[^}]*opacity:\s*1/s
  );
  assert.match(
    routeScript,
    /index === state\.selectedPointIndex[\s\S]*?classList\.add\("is-selected"\)/
  );
  assert.match(
    routeScript,
    /function selectPoint\(pointIndex\)[\s\S]*?setSelectedPoint\(pointIndex\)/
  );
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
  assert.match(routeScript, /state\.trace\.engagementSegments/);
  assert.match(routeScript, /"is-engaged"/);
  assert.match(
    routeScript,
    /state\.currentMarker = svgElement\("path",[\s\S]*currentMarkerTransform/
  );
  assert.match(html, /id="route-engaged-legend" hidden/);
  assert.match(css, /\.route-workspace\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.route-map-frame\s*\{[^}]*touch-action:\s*none/s);
  assert.match(
    css,
    /\.route-speed-path\.is-engaged\.speed-band-0\s*\{[^}]*stroke:/s
  );
  assert.match(css, /\.route-current-marker\s*\{[^}]*fill:\s*#fff/s);
  assert.match(css, /\.route-event-button\.is-active/);
  assert.match(css, /\.route-event-button\.is-hovered/);
});

test("route map and playback bar support keyboard playback", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);
  const mapFrame = html.match(
    /<div\s+class="route-map-frame"[\s\S]*?>/
  )?.[0];

  assert.ok(mapFrame);
  assert.match(mapFrame, /\btabindex="0"/);
  assert.match(mapFrame, /\baria-describedby="route-map-hint"/);
  assert.match(html, /left\/right arrows to step/);
  assert.match(routeScript, /function onMapKeyDown\(event\)/);
  assert.match(routeScript, /event\.key === "ArrowLeft"/);
  assert.match(routeScript, /event\.key === "ArrowRight"/);
  assert.match(routeScript, /if \(event\.key === " "\)/);
  assert.match(routeScript, /mapFrame\.focus\(\{ preventScroll: true \}\)/);
  assert.match(
    routeScript,
    /mapFrame\.addEventListener\("keydown", onMapKeyDown\)/
  );
  assert.match(
    routeScript,
    /rangeInput\.addEventListener\("keydown", onPlaybackSpace\)/
  );
  assert.match(routeScript, /applyTrace\(null, false\)/);
  assert.match(css, /\.route-map-frame:focus-visible/);
});

test("route viewer timestamps use a 24-hour clock", async () => {
  const routeScript = await readFile(
    new URL("public/route.js", root),
    "utf8"
  );

  assert.match(
    routeScript,
    /function formatClock\(timestamp\)[\s\S]*?hourCycle: "h23"/
  );
  assert.match(
    routeScript,
    /function formatDateTime\(timestamp\)[\s\S]*?hourCycle: "h23"/
  );
});

test("route tooltips require marker hover and selected details stay pinned", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);

  assert.match(html, /id="route-selection-details"/);
  assert.match(html, /aria-label="Selected route point or event details"/);
  assert.match(
    routeScript,
    /function onMapPointerMove\(event\)[\s\S]*?event\.target\.closest\("\.route-point-target"\)/
  );
  assert.match(routeScript, /function showPointTooltip\(pointIndex, pointerEvent\)/);
  assert.match(routeScript, /selectionDetails\.textContent = detailLines\.join/);
  assert.match(routeScript, /eventDetailLines\(selectedEvent\)/);
  assert.doesNotMatch(routeScript, /nearestDistance/);
  assert.doesNotMatch(routeScript, /drawNorthArrow/);
  assert.match(css, /\.route-selection-details\s*\{[^}]*right:\s*10px/s);
  assert.match(css, /\.route-selection-details\s*\{[^}]*top:\s*10px/s);
});

test("route plots small clickable markers for enabled trace points", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);

  assert.match(
    routeScript,
    /class: "route-point-marker route-point-target"/
  );
  assert.match(routeScript, /r: 2\.5/);
  assert.match(routeScript, /"data-point-index": index/);
  assert.match(routeScript, /kind === "propagated"/);
  assert.match(routeScript, /classList\.add\("is-odometry"\)/);
  assert.match(routeScript, /event\.target\.closest\("\.route-point-target"\)/);
  assert.match(routeScript, /selectPoint\(pointIndex\)/);
  assert.match(html, /Click a point to jump/);
  assert.match(css, /\.route-point-target\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(
    css,
    /\.route-point-marker\s*\{[^}]*stroke:\s*transparent[^}]*stroke-width:\s*8/s
  );
  assert.match(css, /\.route-point-marker\.is-odometry\s*\{[^}]*fill:/s);
});

test("route renders vehicle speed with a fixed-band gradient", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);

  assert.doesNotMatch(html, /Slow &rarr; fast/);
  assert.doesNotMatch(routeScript, /route-speed-legend/);
  assert.match(routeScript, /SPEED_BAND_LIMITS = \[2, 4, 6, 8, 10, 12\]/);
  assert.match(
    routeScript,
    /function buildSpeedPaths\(project, routeSegments, engagementClass\)/
  );
  assert.match(
    routeScript,
    /class: `route-speed-path \$\{engagementClass\} speed-band-\$\{segmentBand\}`/
  );
  assert.match(
    routeScript,
    /const disengagedSpeedPaths = buildSpeedPaths\([\s\S]*?"is-disengaged"[\s\S]*?const engagedSpeedPaths = buildSpeedPaths\([\s\S]*?"is-engaged"/
  );
  assert.match(routeScript, /formatSpeed\(point\.speed\)/);
  assert.match(css, /\.route-progress-path\s*\{[^}]*stroke:\s*#050505/s);
  assert.match(css, /\.route-progress-path\s*\{[^}]*stroke-width:\s*7/s);
  assert.match(css, /\.route-speed-path\s*\{[^}]*opacity:\s*1/s);
  assert.match(css, /\.route-speed-path\s*\{[^}]*stroke-width:\s*4/s);
  assert.match(
    css,
    /\.route-speed-path\.is-disengaged\.speed-band-6\s*\{[^}]*stroke:/s
  );
  assert.match(
    css,
    /\.route-speed-path\.is-engaged\.speed-band-6\s*\{[^}]*stroke:/s
  );
  assert.match(
    css,
    /\.route-swatch\.disengaged-speed\s*\{[^}]*linear-gradient/s
  );
  assert.match(
    css,
    /\.route-swatch\.engaged\s*\{[^}]*linear-gradient/s
  );
});

test("timestamped viewer lines can toggle manual route events", async () => {
  const [html, routeScript, css] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/route.js", root), "utf8"),
    readFile(new URL("public/route.css", root), "utf8"),
  ]);

  assert.match(html, /data-event-timestamp=/);
  assert.match(html, /route\.addEventFromLog\(/);
  assert.match(html, /route\.removeEventFromLog\(data\.path, ln\)/);
  assert.match(html, /Click to remove this line from the event timeline/);
  assert.match(html, /logroute:manual-event-removed/);
  assert.match(html, /class="viewer-event-status"/);
  assert.match(html, /\.v-line\.v-eventable/);
  assert.match(html, /\.v-line\.v-event-added/);
  assert.match(routeScript, /function addEventFromLog\(/);
  assert.match(routeScript, /function removeEventFromLog\(/);
  assert.match(routeScript, /function normalizeManualEvents\(/);
  assert.match(routeScript, /function getSessionState\(/);
  assert.match(routeScript, /logroute:session-state-changed/);
  assert.match(
    routeScript,
    /root\.LogRoute = \{[\s\S]*addEventFromLog,[\s\S]*getSessionState,[\s\S]*hasEventFromLog,[\s\S]*removeEventFromLog,[\s\S]*\}/
  );
  assert.match(routeScript, /function removeManualEvent\(/);
  assert.match(routeScript, /removeButton\.className = "route-event-remove"/);
  assert.match(routeScript, /if \(event\.source === "manual"\)/);
  assert.match(css, /\.route-event-remove/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
