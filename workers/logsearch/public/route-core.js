(function (root) {
  "use strict";

  const COORD_RE =
    /Timestamp:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?),\s*UTM coord:\s*\{\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?),\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*\}/;
  const LAT_LON_RE =
    /\blat(?:itude)?\s*[=:]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*,?\s*\blon(?:gitude)?\s*[=:]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/i;

  function basename(path) {
    const parts = String(path || "").split("/");
    return (parts[parts.length - 1] || "").toLowerCase();
  }

  function roleForPath(path) {
    const base = basename(path);
    if (/^annotation_notes_.*\.(?:ya?ml|txt)$/.test(base)) {
      return base.endsWith(".txt") ? "annotation-text" : "annotation-yaml";
    }
    if (
      /^localization(?:_[a-z0-9-]+)?_stdout\.(?:txt|log)$/.test(base) ||
      base === "localization_stdout.txt"
    ) {
      return "localization";
    }
    if (
      /^controller(?:_[a-z0-9-]+)?_stdout\.(?:txt|log)$/.test(base) ||
      base === "controller_stdout.txt"
    ) {
      return "engagement";
    }
    if (
      /^(?:navigation_rasterizer|stack_dds_bridge_driver).*_stdout\.(?:txt|log)$/.test(
        base
      )
    ) {
      return "anchor";
    }
    return null;
  }

  function createAccumulator() {
    return {
      points: [],
      anchors: [],
      events: [],
      engagementTransitions: [],
      files: new Set(),
    };
  }

  function createFileParser(path, accumulator, requestedRole) {
    const role = requestedRole || roleForPath(path);
    if (!role) return null;

    accumulator.files.add(path);
    let lineNo = 0;
    let yamlNote = null;
    let textCategory = "";

    function flushYamlNote() {
      if (!yamlNote || !Number.isFinite(yamlNote.timestamp)) {
        yamlNote = null;
        return;
      }
      accumulator.events.push({
        timestamp: yamlNote.timestamp,
        id: yamlNote.id || "",
        type: yamlNote.type || "",
        disengagementType: yamlNote.disengagement_type || "",
        severity: numberOrNull(yamlNote.severity),
        content: yamlNote.content || yamlNote.type || "Annotation",
        path,
        lineNo: yamlNote.lineNo || lineNo,
        source: "yaml",
      });
      yamlNote = null;
    }

    function parseYamlAnnotation(line) {
      const start = line.match(/^\s*-\s+id:\s*(.*)$/);
      if (start) {
        flushYamlNote();
        yamlNote = {
          id: cleanYamlValue(start[1]),
          lineNo,
        };
        return;
      }

      const field = line.match(/^\s+([a-z_]+):\s*(.*)$/i);
      if (!field) return;
      if (!yamlNote) yamlNote = { lineNo };
      const key = field[1].toLowerCase();
      const value = cleanYamlValue(field[2]);
      if (key === "timestamp_ns") {
        yamlNote.timestamp = nanosecondsToSeconds(value);
      } else if (
        key === "type" ||
        key === "disengagement_type" ||
        key === "severity" ||
        key === "content"
      ) {
        yamlNote[key] = value;
      }
    }

    function parseTextAnnotation(line) {
      const heading = line.match(/^#\s*(.+?)\s*$/);
      if (heading) {
        textCategory = heading[1];
        return;
      }
      const entry = line.match(
        /^(20\d{2}-\d{2}-\d{2}T\S+)\s+(.+?)\s*$/
      );
      if (!entry) return;
      const milliseconds = Date.parse(entry[1]);
      if (!Number.isFinite(milliseconds)) return;
      accumulator.events.push({
        timestamp: milliseconds / 1000,
        id: "",
        type: textCategory,
        disengagementType: "",
        severity: null,
        content: entry[2],
        path,
        lineNo,
        source: "text",
      });
    }

    function parseEngagementTransition(line) {
      let engaged;
      let reason = "";
      if (/\bDBW system enabled\b/i.test(line)) {
        engaged = true;
      } else {
        const disabled = line.match(
          /\bDBW system disabled(?:\s+with reason:\s*(.*))?/i
        );
        if (!disabled) return;
        engaged = false;
        reason = String(disabled[1] || "").trim();
      }

      const timestamp = timestampFromLine(line);
      if (!Number.isFinite(timestamp)) return;
      accumulator.engagementTransitions.push({
        timestamp,
        engaged,
        reason,
        path,
        lineNo,
      });
    }

    return {
      role,
      pushLine(line) {
        lineNo++;

        if (role === "localization") {
          const match = line.match(COORD_RE);
          if (match) {
            const timestamp = Number(match[1]);
            const easting = Number(match[2]);
            const northing = Number(match[3]);
            if (
              Number.isFinite(timestamp) &&
              Number.isFinite(easting) &&
              Number.isFinite(northing)
            ) {
              accumulator.points.push({
                timestamp,
                easting,
                northing,
                kind: pointKind(line),
                path,
                lineNo,
              });
            }
          }
        }

        if (role === "anchor" || role === "localization") {
          const anchor = line.match(LAT_LON_RE);
          if (anchor) {
            const lat = Number(anchor[1]);
            const lon = Number(anchor[2]);
            if (
              Number.isFinite(lat) &&
              Number.isFinite(lon) &&
              Math.abs(lat) <= 90 &&
              Math.abs(lon) <= 180
            ) {
              accumulator.anchors.push({
                lat,
                lon,
                priority: /\/localization\/global_state/i.test(line) ? 3 : 1,
                path,
                lineNo,
              });
            }
          }
        }

        if (role === "engagement") parseEngagementTransition(line);
        if (role === "annotation-yaml") parseYamlAnnotation(line);
        else if (role === "annotation-text") parseTextAnnotation(line);
      },
      finish() {
        if (role === "annotation-yaml") flushYamlNote();
      },
    };
  }

  function pointKind(line) {
    if (/Successfully Updated Estimation/i.test(line)) return "corrected";
    if (/Propagated particle filter state/i.test(line)) return "propagated";
    if (/Initialized particles/i.test(line)) return "initial";
    return "unknown";
  }

  function cleanYamlValue(value) {
    const trimmed = String(value || "").trim();
    if (
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  function nanosecondsToSeconds(value) {
    const digits = String(value || "").trim();
    if (!/^\d+$/.test(digits)) return Number.NaN;
    if (digits.length <= 9) return Number(digits) / 1e9;
    const whole = digits.slice(0, -9);
    const fraction = digits.slice(-9);
    return Number(whole) + Number(fraction) / 1e9;
  }

  function timestampFromLine(line) {
    const text = String(line || "");

    const nanoseconds = text.match(
      /\b(?:timestamp_ns|time_ns)\s*[:=]\s*(\d{12,20})\b/i
    );
    if (nanoseconds) return nanosecondsToSeconds(nanoseconds[1]);

    const microseconds = text.match(
      /\b(?:timestamp_us|time_us)\s*[:=]\s*(\d{12,18})\b/i
    );
    if (microseconds) return Number(microseconds[1]) / 1e6;

    const milliseconds = text.match(
      /\b(?:timestamp_ms|time_ms)\s*[:=]\s*(\d{12,16})\b/i
    );
    if (milliseconds) return Number(milliseconds[1]) / 1e3;

    // Prefer an explicit epoch timestamp inside the message over the logging
    // prefix. Localization lines contain both, and the message timestamp is
    // the one that aligns exactly with the route state.
    const epoch = text.match(
      /\bTimestamp:\s*(\d{10}(?:\.\d+)?)\b/
    );
    if (epoch) {
      const seconds = Number(epoch[1]);
      if (seconds >= 946684800 && seconds <= 4102444800) return seconds;
    }

    const calendar = text.match(
      /\b(20\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?/
    );
    if (!calendar) return Number.NaN;

    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const hour = Number(calendar[4]);
    const minute = Number(calendar[5]);
    const second = Number(calendar[6]);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 60
    ) {
      return Number.NaN;
    }

    const fraction = calendar[7] ? Number(`0.${calendar[7]}`) : 0;
    let timestamp =
      Date.UTC(year, month - 1, day, hour, minute, second) / 1000 +
      fraction;
    const zone = calendar[8];
    if (zone && zone !== "Z") {
      const sign = zone.startsWith("-") ? -1 : 1;
      const compact = zone.slice(1).replace(":", "");
      const offsetMinutes =
        Number(compact.slice(0, 2)) * 60 + Number(compact.slice(2, 4));
      timestamp -= sign * offsetMinutes * 60;
    }
    return timestamp;
  }

  function numberOrNull(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function finalize(accumulator, options) {
    const opts = options || {};
    const points = dedupePoints(accumulator.points);
    const engagementTransitions = dedupeEngagementTransitions(
      accumulator.engagementTransitions || []
    );
    const anchors = accumulator.anchors
      .filter(
        (anchor) =>
          Number.isFinite(anchor.lat) && Number.isFinite(anchor.lon)
      )
      .sort((a, b) => b.priority - a.priority);
    const anchor = anchors[0] || null;

    let zone = Number(opts.zone);
    if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
      zone = anchor ? utmZoneForLongitude(anchor.lon) : null;
    }
    const northern =
      typeof opts.northern === "boolean"
        ? opts.northern
        : anchor
          ? anchor.lat >= 0
          : true;

    if (zone) {
      for (const point of points) {
        const converted = utmToLatLon(
          point.easting,
          point.northing,
          zone,
          northern
        );
        point.lat = converted.lat;
        point.lon = converted.lon;
      }
    }

    return {
      points,
      events: dedupeEvents(accumulator.events),
      engagementTransitions,
      anchor,
      zone,
      northern,
      files: Array.from(accumulator.files).sort(),
      counts: countPointKinds(points),
    };
  }

  function dedupePoints(input) {
    const sorted = input
      .filter(
        (point) =>
          Number.isFinite(point.timestamp) &&
          Number.isFinite(point.easting) &&
          Number.isFinite(point.northing)
      )
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp || kindRank(b.kind) - kindRank(a.kind));
    const seen = new Set();
    const output = [];
    for (const point of sorted) {
      const key =
        point.timestamp.toFixed(6) +
        "|" +
        point.easting.toFixed(4) +
        "|" +
        point.northing.toFixed(4);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ ...point });
    }
    return output;
  }

  function dedupeEngagementTransitions(input) {
    const sorted = input
      .filter(
        (transition) =>
          Number.isFinite(transition.timestamp) &&
          typeof transition.engaged === "boolean"
      )
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp);
    const output = [];
    for (const transition of sorted) {
      const prior = output[output.length - 1];
      if (prior && prior.engaged === transition.engaged) continue;
      output.push({ ...transition });
    }
    return output;
  }

  function dedupeEvents(input) {
    const sorted = input
      .filter((event) => Number.isFinite(event.timestamp))
      .slice()
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp ||
          eventRank(b) - eventRank(a)
      );
    const output = [];
    for (const event of sorted) {
      const prior = output[output.length - 1];
      if (prior && Math.abs(prior.timestamp - event.timestamp) < 0.75) {
        if (eventRank(event) > eventRank(prior)) {
          output[output.length - 1] = { ...event };
        }
        continue;
      }
      output.push({ ...event });
    }
    return output;
  }

  function eventRank(event) {
    return event.source === "yaml" ? 2 : 1;
  }

  function kindRank(kind) {
    if (kind === "corrected") return 4;
    if (kind === "initial") return 3;
    if (kind === "propagated") return 2;
    return 1;
  }

  function countPointKinds(points) {
    const counts = {
      corrected: 0,
      propagated: 0,
      initial: 0,
      unknown: 0,
    };
    for (const point of points) {
      counts[point.kind] = (counts[point.kind] || 0) + 1;
    }
    return counts;
  }

  function buildTrace(result, includePropagated) {
    const hasCorrected = result.points.some(
      (point) => point.kind === "corrected"
    );
    const filtered = result.points.filter((point) => {
      if (!hasCorrected) return true;
      if (point.kind === "corrected" || point.kind === "initial") return true;
      if (point.kind === "propagated") return !!includePropagated;
      return false;
    });

    const points = [];
    let distanceMeters = 0;
    for (const source of filtered) {
      const point = { ...source, breakBefore: false };
      const previous = points[points.length - 1];
      if (previous) {
        const elapsed = point.timestamp - previous.timestamp;
        const distance = Math.hypot(
          point.easting - previous.easting,
          point.northing - previous.northing
        );
        point.breakBefore =
          elapsed <= 0 ||
          elapsed > 45 ||
          (elapsed > 0.05 && distance / elapsed > 80);
        if (!point.breakBefore) distanceMeters += distance;
      }
      points.push(point);
    }
    assignMovementHeadings(points);

    const bounds = coordinateBounds(points);
    const durationSeconds =
      points.length > 1
        ? points[points.length - 1].timestamp - points[0].timestamp
        : 0;
    const events = result.events.map((event) => {
      const pointIndex = nearestTimestampIndex(points, event.timestamp);
      return {
        ...event,
        pointIndex,
        point: pointIndex >= 0 ? points[pointIndex] : null,
      };
    });
    const engagementSegments = buildEngagementSegments(
      points,
      result.engagementTransitions || []
    );

    return {
      points,
      events,
      engagementSegments,
      bounds,
      durationSeconds,
      distanceMeters,
    };
  }

  function assignMovementHeadings(points) {
    const minimumDistance = 2;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      let previous = null;
      let next = null;

      for (let priorIndex = index - 1; priorIndex >= 0; priorIndex--) {
        if (points[priorIndex + 1].breakBefore) break;
        if (routePointDistance(point, points[priorIndex]) >= minimumDistance) {
          previous = points[priorIndex];
          break;
        }
      }
      for (let nextIndex = index + 1; nextIndex < points.length; nextIndex++) {
        if (points[nextIndex].breakBefore) break;
        if (routePointDistance(point, points[nextIndex]) >= minimumDistance) {
          next = points[nextIndex];
          break;
        }
      }

      point.heading = movementHeading(previous || point, next || point);
      if (!Number.isFinite(point.heading) && next) {
        point.heading = movementHeading(point, next);
      }
      if (!Number.isFinite(point.heading) && previous) {
        point.heading = movementHeading(previous, point);
      }
    }
  }

  function routePointDistance(start, end) {
    return Math.hypot(
      end.easting - start.easting,
      end.northing - start.northing
    );
  }

  function movementHeading(start, end) {
    const deltaEasting = end.easting - start.easting;
    const deltaNorthing = end.northing - start.northing;
    if (Math.hypot(deltaEasting, deltaNorthing) < 0.25) return null;
    return (
      (Math.atan2(deltaEasting, deltaNorthing) * 180) / Math.PI +
      360
    ) % 360;
  }

  function buildEngagementSegments(points, transitions) {
    if (points.length < 2 || !transitions.length) return [];

    const intervals = [];
    let engagedAt = null;
    for (const transition of transitions) {
      if (transition.engaged) {
        if (engagedAt == null) engagedAt = transition.timestamp;
      } else if (engagedAt != null) {
        if (transition.timestamp > engagedAt) {
          intervals.push({
            start: engagedAt,
            end: transition.timestamp,
          });
        }
        engagedAt = null;
      }
    }
    if (engagedAt != null) {
      intervals.push({ start: engagedAt, end: Number.POSITIVE_INFINITY });
    }

    const output = [];
    for (const interval of intervals) {
      let segment = [];
      const flush = () => {
        if (segment.length >= 2) output.push(segment);
        segment = [];
      };

      for (let index = 1; index < points.length; index++) {
        const previous = points[index - 1];
        const point = points[index];
        if (point.breakBefore || point.timestamp <= previous.timestamp) {
          flush();
          continue;
        }

        const start = Math.max(previous.timestamp, interval.start);
        const end = Math.min(point.timestamp, interval.end);
        if (end <= start) continue;

        const startPoint = interpolateRoutePoint(previous, point, start);
        const endPoint = interpolateRoutePoint(previous, point, end);
        const last = segment[segment.length - 1];
        if (!last || Math.abs(last.timestamp - start) > 1e-6) {
          flush();
          segment.push(startPoint);
        }
        segment.push(endPoint);
      }
      flush();
    }
    return output;
  }

  function interpolateRoutePoint(start, end, timestamp) {
    const duration = end.timestamp - start.timestamp;
    const ratio = duration > 0 ? (timestamp - start.timestamp) / duration : 0;
    const point = {
      timestamp,
      easting: start.easting + (end.easting - start.easting) * ratio,
      northing: start.northing + (end.northing - start.northing) * ratio,
      breakBefore: false,
    };
    if (
      Number.isFinite(start.lat) &&
      Number.isFinite(start.lon) &&
      Number.isFinite(end.lat) &&
      Number.isFinite(end.lon)
    ) {
      point.lat = start.lat + (end.lat - start.lat) * ratio;
      point.lon = start.lon + (end.lon - start.lon) * ratio;
    }
    return point;
  }

  function coordinateBounds(points) {
    if (!points.length) return null;
    let minEasting = Infinity;
    let maxEasting = -Infinity;
    let minNorthing = Infinity;
    let maxNorthing = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let hasGeographic = true;
    for (const point of points) {
      minEasting = Math.min(minEasting, point.easting);
      maxEasting = Math.max(maxEasting, point.easting);
      minNorthing = Math.min(minNorthing, point.northing);
      maxNorthing = Math.max(maxNorthing, point.northing);
      if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
        minLat = Math.min(minLat, point.lat);
        maxLat = Math.max(maxLat, point.lat);
        minLon = Math.min(minLon, point.lon);
        maxLon = Math.max(maxLon, point.lon);
      } else {
        hasGeographic = false;
      }
    }
    return {
      minEasting,
      maxEasting,
      minNorthing,
      maxNorthing,
      ...(hasGeographic
        ? { minLat, maxLat, minLon, maxLon }
        : {}),
    };
  }

  function nearestTimestampIndex(points, timestamp) {
    if (!points.length || !Number.isFinite(timestamp)) return -1;
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (points[middle].timestamp < timestamp) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    if (low === points.length) return points.length - 1;
    return timestamp - points[low - 1].timestamp <=
      points[low].timestamp - timestamp
      ? low - 1
      : low;
  }

  function utmZoneForLongitude(longitude) {
    return Math.max(
      1,
      Math.min(60, Math.floor((Number(longitude) + 180) / 6) + 1)
    );
  }

  // WGS 84 inverse Universal Transverse Mercator conversion. UTM values are
  // retained for plotting and distance calculations; this conversion is only
  // needed for geographic labels and the optional street-map background.
  function utmToLatLon(easting, northing, zone, northern) {
    const a = 6378137;
    const eccentricitySquared = 0.00669438;
    const k0 = 0.9996;
    const eccentricityPrimeSquared =
      eccentricitySquared / (1 - eccentricitySquared);

    const x = Number(easting) - 500000;
    let y = Number(northing);
    if (!northern) y -= 10000000;

    const meridionalArc = y / k0;
    const mu =
      meridionalArc /
      (a *
        (1 -
          eccentricitySquared / 4 -
          (3 * eccentricitySquared ** 2) / 64 -
          (5 * eccentricitySquared ** 3) / 256));
    const e1 =
      (1 - Math.sqrt(1 - eccentricitySquared)) /
      (1 + Math.sqrt(1 - eccentricitySquared));

    const phi1 =
      mu +
      (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
      (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
      (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
      (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);
    const n1 = a / Math.sqrt(1 - eccentricitySquared * sinPhi1 ** 2);
    const t1 = tanPhi1 ** 2;
    const c1 = eccentricityPrimeSquared * cosPhi1 ** 2;
    const r1 =
      (a * (1 - eccentricitySquared)) /
      (1 - eccentricitySquared * sinPhi1 ** 2) ** 1.5;
    const d = x / (n1 * k0);

    const lat =
      phi1 -
      ((n1 * tanPhi1) / r1) *
        (d ** 2 / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * eccentricityPrimeSquared) *
            d ** 4) /
            24 +
          ((61 +
            90 * t1 +
            298 * c1 +
            45 * t1 ** 2 -
            252 * eccentricityPrimeSquared -
            3 * c1 ** 2) *
            d ** 6) /
            720);
    const lon =
      (d -
        ((1 + 2 * t1 + c1) * d ** 3) / 6 +
        ((5 -
          2 * c1 +
          28 * t1 -
          3 * c1 ** 2 +
          8 * eccentricityPrimeSquared +
          24 * t1 ** 2) *
          d ** 5) /
          120) /
      cosPhi1;
    const centralMeridian = (Number(zone) - 1) * 6 - 180 + 3;

    return {
      lat: (lat * 180) / Math.PI,
      lon: centralMeridian + (lon * 180) / Math.PI,
    };
  }

  root.LogRouteCore = {
    buildEngagementSegments,
    buildTrace,
    createAccumulator,
    createFileParser,
    finalize,
    nearestTimestampIndex,
    roleForPath,
    timestampFromLine,
    utmToLatLon,
    utmZoneForLongitude,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
