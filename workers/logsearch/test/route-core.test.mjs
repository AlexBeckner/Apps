import assert from "node:assert/strict";
import test from "node:test";

await import("../public/route-core.js");

const {
  buildTrace,
  createAccumulator,
  createFileParser,
  finalize,
  roleForPath,
  timestampFromLine,
  utmToLatLon,
} = globalThis.LogRouteCore;

test("detects route-related log files", () => {
  assert.equal(roleForPath("run/localization_stdout.txt"), "localization");
  assert.equal(roleForPath("run/controller_stdout.txt"), "engagement");
  assert.equal(
    roleForPath("run/navigation_rasterizer_stdout.txt"),
    "anchor"
  );
  assert.equal(
    roleForPath("run/annotation_notes_123.yaml"),
    "annotation-yaml"
  );
  assert.equal(roleForPath("run/planner_stdout.txt"), null);
});

test("parses localization, coordinate anchors, and annotations", () => {
  const accumulator = createAccumulator();
  const localization = createFileParser(
    "run/localization_stdout.txt",
    accumulator
  );
  localization.pushLine(
    "2026-07-13 17:10:31 [INFO] Initialized particles at Timestamp: 1783962630.9972, UTM coord: {585118.1860, 4137776.0395}}"
  );
  localization.pushLine(
    "2026-07-13 17:10:31 [INFO] Successfully Updated Estimation: {Timestamp: 1783962631.0477, UTM coord: {585118.0908, 4137775.8271}}"
  );
  localization.pushLine(
    "2026-07-13 17:10:32 [INFO] Propagated particle filter state: {Timestamp: 1783962632.4307, UTM coord: {585117.6989, 4137776.0038}}"
  );
  localization.finish();

  const anchor = createFileParser(
    "run/navigation_rasterizer_stdout.txt",
    accumulator
  );
  anchor.pushLine(
    "NavigationRasterizer: received /localization/global_state lat=37.3828 lon=-122.039"
  );
  anchor.finish();

  const annotations = createFileParser(
    "run/annotation_notes_123.yaml",
    accumulator
  );
  annotations.pushLine("notes:");
  annotations.pushLine("    - id: event-1");
  annotations.pushLine("      type: comfort:jerky_steering");
  annotations.pushLine("      disengagement_type: driver_takeover");
  annotations.pushLine("      severity: 4");
  annotations.pushLine("      timestamp_ns: 1783962631500000000");
  annotations.pushLine("      content: FAIL - DRIVER_TAKEOVER");
  annotations.finish();

  const result = finalize(accumulator);
  assert.equal(result.zone, 10);
  assert.equal(result.northern, true);
  assert.deepEqual(result.counts, {
    corrected: 1,
    propagated: 1,
    initial: 1,
    unknown: 0,
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].severity, 4);

  const correctedOnly = buildTrace(result, false);
  assert.equal(correctedOnly.points.length, 2);
  assert.equal(correctedOnly.events[0].pointIndex, 1);

  const withOdometry = buildTrace(result, true);
  assert.equal(withOdometry.points.length, 3);
  assert.ok(Math.abs(withOdometry.points[0].lat - 37.3828) < 0.001);
  assert.ok(Math.abs(withOdometry.points[0].lon - -122.039) < 0.001);
});

test("interpolates engaged route segments from DBW state transitions", () => {
  const accumulator = createAccumulator();
  const localization = createFileParser(
    "run/localization_stdout.txt",
    accumulator
  );
  localization.pushLine(
    "Successfully Updated Estimation: {Timestamp: 1783962760, UTM coord: {500000, 4100000}}"
  );
  localization.pushLine(
    "Successfully Updated Estimation: {Timestamp: 1783962770, UTM coord: {500010, 4100000}}"
  );
  localization.pushLine(
    "Successfully Updated Estimation: {Timestamp: 1783962780, UTM coord: {500020, 4100000}}"
  );
  localization.finish();

  const controller = createFileParser(
    "run/controller_stdout.txt",
    accumulator
  );
  controller.pushLine(
    "2026-07-13 17:12:45.000000000 [INFO] DBW system enabled"
  );
  controller.pushLine(
    "2026-07-13 17:12:55.000000000 [WARNING] DBW system disabled with reason:SteerRptOverride"
  );
  controller.finish();

  const result = finalize(accumulator, { zone: 10 });
  assert.deepEqual(
    result.engagementTransitions.map(({ timestamp, engaged, reason }) => ({
      timestamp,
      engaged,
      reason,
    })),
    [
      { timestamp: 1783962765, engaged: true, reason: "" },
      {
        timestamp: 1783962775,
        engaged: false,
        reason: "SteerRptOverride",
      },
    ]
  );

  const trace = buildTrace(result, false);
  assert.equal(trace.engagementSegments.length, 1);
  assert.equal(trace.engagementSegments[0].length, 3);
  assert.equal(trace.engagementSegments[0][0].timestamp, 1783962765);
  assert.equal(trace.engagementSegments[0][0].easting, 500005);
  assert.equal(trace.engagementSegments[0][2].timestamp, 1783962775);
  assert.equal(trace.engagementSegments[0][2].easting, 500015);
});

test("converts the sample UTM coordinate to its Mountain View location", () => {
  const point = utmToLatLon(585118.186, 4137776.0395, 10, true);
  assert.ok(Math.abs(point.lat - 37.3828) < 0.001);
  assert.ok(Math.abs(point.lon - -122.039) < 0.001);
});

test("extracts route-compatible timestamps from viewer lines", () => {
  assert.equal(
    timestampFromLine(
      "2026-07-13 17:10:31.052202064 [INFO] Successfully Updated Estimation: {Timestamp: 1783962631.0477, UTM coord: {585118.0908, 4137775.8271}}"
    ),
    1783962631.0477
  );
  assert.ok(
    Math.abs(
      timestampFromLine("2026-07-13 17:10:30.216135792 [INFO] ready") -
        1783962630.2161357
    ) < 1e-6
  );
  assert.equal(
    timestampFromLine(
      "2026-07-13T10:12:52-07:00 comfort.jerky_steering"
    ),
    1783962772
  );
  assert.equal(
    timestampFromLine("timestamp_ns: 1783962772020000000"),
    1783962772.02
  );
  assert.equal(Number.isNaN(timestampFromLine("no timestamp here")), true);
});

test("deduplicates text and YAML annotations at the same timestamp", () => {
  const accumulator = createAccumulator();
  const yaml = createFileParser("annotation_notes_test.yaml", accumulator);
  yaml.pushLine("    - id: event-1");
  yaml.pushLine("      severity: 3");
  yaml.pushLine("      timestamp_ns: 1783962772020000000");
  yaml.pushLine("      content: FAIL - DRIVER_TAKEOVER");
  yaml.finish();

  const text = createFileParser("annotation_notes_test.txt", accumulator);
  text.pushLine("#Disengagement:DriverTakeover");
  text.pushLine(
    "2026-07-13T10:12:52-07:00 comfort.jerky_steering: FAIL - DRIVER_TAKEOVER"
  );
  text.finish();

  const result = finalize(accumulator);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source, "yaml");
  assert.equal(result.events[0].severity, 3);
});

test("splits a trace at implausible coordinate jumps", () => {
  const accumulator = createAccumulator();
  const parser = createFileParser("localization_stdout.txt", accumulator);
  parser.pushLine(
    "Successfully Updated Estimation: {Timestamp: 1000, UTM coord: {500000, 4100000}}"
  );
  parser.pushLine(
    "Successfully Updated Estimation: {Timestamp: 1001, UTM coord: {501000, 4100000}}"
  );
  parser.finish();

  const trace = buildTrace(finalize(accumulator, { zone: 10 }), false);
  assert.equal(trace.points[1].breakBefore, true);
  assert.equal(trace.distanceMeters, 0);
});
