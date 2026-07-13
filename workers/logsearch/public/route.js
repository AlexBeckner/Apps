(function (root) {
  "use strict";

  const core = root.LogRouteCore;
  if (!core || typeof document === "undefined") return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const VIEW_WIDTH = 1000;
  const VIEW_HEIGHT = 560;
  const TILE_SIZE = 256;

  const byId = (id) => document.getElementById(id);
  const panel = byId("route-panel");
  if (!panel) return;

  const statusEl = byId("route-status");
  const topGrid = byId("top-grid");
  const bodyEl = byId("route-body");
  const emptyEl = byId("route-empty");
  const visualEl = byId("route-visual");
  const statsEl = byId("route-stats");
  const workspaceEl = byId("route-workspace");
  const propagatedInput = byId("route-include-propagated");
  const archiveButton = byId("route-archives");
  const collapseButton = byId("route-collapse");
  const downloadButton = byId("route-download");
  const mapFrame = byId("route-map-frame");
  const tileLayer = byId("route-tiles");
  const svg = byId("route-svg");
  const tooltip = byId("route-tooltip");
  const streetButton = byId("route-street");
  const zoomOutButton = byId("route-zoom-out");
  const zoomInButton = byId("route-zoom-in");
  const fitButton = byId("route-fit");
  const attribution = byId("route-attribution");
  const playButton = byId("route-play");
  const rangeInput = byId("route-range");
  const speedInput = byId("route-speed");
  const timeEl = byId("route-time");
  const eventsEl = byId("route-events");
  const eventList = byId("route-event-list");
  const routeLegendLabel = byId("route-legend-label");
  const engagedLegend = byId("route-engaged-legend");

  const state = {
    selection: [],
    archives: [],
    accumulator: null,
    manualEvents: [],
    result: null,
    trace: null,
    selectionToken: 0,
    cancelAnalysis: false,
    analyzing: false,
    archivesScanned: false,
    analysisErrors: [],
    includePropagated: false,
    currentIndex: -1,
    playRaf: 0,
    playLastReal: 0,
    playSimulatedTime: 0,
    streetMode: false,
    mapChoiceMade: false,
    streetZoom: null,
    streetCenter: null,
    fitStreetZoom: null,
    localZoom: 1,
    localCenter: null,
    mapRenderRaf: 0,
    activePointers: new Map(),
    gesture: null,
    suppressMapClickUntil: 0,
    activeEventIndex: -1,
    hoveredEventIndex: -1,
    project: null,
    screenPoints: [],
    progressPath: null,
    currentMarker: null,
  };

  function setSelection(items) {
    state.selectionToken++;
    state.cancelAnalysis = true;
    stopPlayback();
    resetState();

    state.selection = Array.isArray(items) ? items.slice() : [];
    if (!state.selection.length) {
      panel.hidden = true;
      return;
    }

    const direct = [];
    const archives = [];
    for (const item of state.selection) {
      const archiveKind =
        root.LogArchives && root.LogArchives.archiveKind(item.path);
      if (archiveKind) {
        archives.push(item);
      } else if (core.roleForPath(item.path)) {
        direct.push(item);
      }
    }
    state.archives = archives;

    if (!direct.length && !archives.length) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    bodyEl.hidden = false;
    collapseButton.textContent = "Hide";
    visualEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = direct.length
      ? "Reading localization data..."
      : "No plain localization log was found. Analyze the selected archive to look inside it.";
    configureArchiveButton();

    if (direct.length) {
      void analyzeDirectFiles(direct, state.selectionToken);
    } else {
      statusEl.textContent = "Route analysis is ready.";
    }
  }

  function resetState() {
    state.cancelAnalysis = false;
    state.analyzing = false;
    state.archivesScanned = false;
    state.analysisErrors = [];
    state.accumulator = core.createAccumulator();
    state.manualEvents = [];
    state.result = null;
    state.trace = null;
    state.includePropagated = false;
    state.currentIndex = -1;
    state.streetMode = false;
    state.mapChoiceMade = false;
    state.streetZoom = null;
    state.streetCenter = null;
    state.fitStreetZoom = null;
    state.localZoom = 1;
    state.localCenter = null;
    state.activePointers.clear();
    state.gesture = null;
    state.suppressMapClickUntil = 0;
    state.activeEventIndex = -1;
    state.hoveredEventIndex = -1;
    if (state.mapRenderRaf) cancelAnimationFrame(state.mapRenderRaf);
    state.mapRenderRaf = 0;
    mapFrame.classList.remove("dragging");
    state.project = null;
    state.screenPoints = [];
    state.progressPath = null;
    state.currentMarker = null;
    propagatedInput.checked = false;
    propagatedInput.disabled = true;
    statsEl.replaceChildren();
    eventList.replaceChildren();
    eventsEl.hidden = true;
    svg.replaceChildren();
    tileLayer.replaceChildren();
    tileLayer.hidden = true;
    attribution.hidden = true;
    tooltip.hidden = true;
    archiveButton.hidden = true;
    archiveButton.disabled = false;
    archiveButton.textContent = "Analyze archives";
    downloadButton.disabled = true;
    streetButton.disabled = true;
    streetButton.textContent = "Street map";
    zoomOutButton.hidden = true;
    zoomInButton.hidden = true;
    rangeInput.min = "0";
    rangeInput.max = "0";
    rangeInput.value = "0";
    rangeInput.disabled = true;
    playButton.disabled = true;
    playButton.textContent = "Play";
    timeEl.textContent = "";
    routeLegendLabel.textContent = "Route";
    engagedLegend.hidden = true;
    statusEl.textContent = "";
  }

  async function analyzeDirectFiles(items, token) {
    state.analyzing = true;
    configureArchiveButton();
    statusEl.textContent = `Reading ${items.length.toLocaleString()} route-related file${
      items.length === 1 ? "" : "s"
    }...`;
    try {
      for (const item of items) {
        if (state.cancelAnalysis || token !== state.selectionToken) return;
        const parser = core.createFileParser(item.path, state.accumulator);
        if (!parser) continue;
        await streamPlainFile(
          item.file,
          parser,
          () => state.cancelAnalysis || token !== state.selectionToken
        );
      }
    } catch (error) {
      if (token === state.selectionToken) {
        state.analysisErrors.push(error.message || "Could not read route data");
      }
    } finally {
      if (token !== state.selectionToken) return;
      state.analyzing = false;
      updateResult();
      configureArchiveButton();
    }
  }

  async function analyzeArchives() {
    if (state.analyzing) {
      state.cancelAnalysis = true;
      archiveButton.disabled = true;
      archiveButton.textContent = "Cancelling...";
      return;
    }
    if (!state.archives.length || !root.LogArchives) return;

    const token = state.selectionToken;
    state.cancelAnalysis = false;
    state.analyzing = true;
    state.analysisErrors = [];
    configureArchiveButton();

    let completed = true;
    try {
      for (let index = 0; index < state.archives.length; index++) {
        if (state.cancelAnalysis || token !== state.selectionToken) {
          completed = false;
          break;
        }
        const item = state.archives[index];
        if (!root.LogArchives.canExpand(item.path)) {
          state.analysisErrors.push(`${item.path}: unsupported in this browser`);
          continue;
        }
        statusEl.textContent =
          `Analyzing archive ${index + 1} / ${state.archives.length}: ${item.path}`;
        await root.LogArchives.extract(
          item.file,
          item.path,
          makeArchiveSink(token),
          {
            isCancelled: () =>
              state.cancelAnalysis || token !== state.selectionToken,
          }
        );
      }
    } catch (error) {
      completed = false;
      state.analysisErrors.push(error.message || "Could not analyze archive");
    } finally {
      if (token !== state.selectionToken) return;
      state.analyzing = false;
      state.archivesScanned = completed && !state.cancelAnalysis;
      state.cancelAnalysis = false;
      updateResult();
      configureArchiveButton();
    }
  }

  function makeArchiveSink(token) {
    return {
      open(name) {
        const role = core.roleForPath(name);
        if (!role) return null;
        const parser = core.createFileParser(name, state.accumulator, role);
        return {
          parser,
          decoder: new TextDecoder("utf-8", { fatal: false }),
          emitter: lineEmitter((line) => parser.pushLine(line)),
        };
      },
      chunk(handle, bytes) {
        if (
          state.cancelAnalysis ||
          token !== state.selectionToken
        ) {
          return false;
        }
        const text = handle.decoder.decode(bytes, { stream: true });
        if (text) handle.emitter.push(text);
        return true;
      },
      close(handle) {
        const tail = handle.decoder.decode();
        if (tail) handle.emitter.push(tail);
        handle.emitter.finish();
        handle.parser.finish();
      },
      skip(name, reason) {
        if (token === state.selectionToken && core.roleForPath(name)) {
          state.analysisErrors.push(`${name}: ${reason || "could not be read"}`);
        }
      },
      error(path, error) {
        if (token !== state.selectionToken) return;
        state.analysisErrors.push(
          `${path}: ${(error && error.message) || "could not be read"}`
        );
      },
    };
  }

  function configureArchiveButton() {
    if (!state.archives.length || state.archivesScanned) {
      archiveButton.hidden = true;
      return;
    }
    archiveButton.hidden = false;
    if (state.analyzing) {
      archiveButton.disabled = false;
      archiveButton.textContent = "Cancel route scan";
      return;
    }
    const supported = !!(
      root.LogArchives &&
      state.archives.some((item) => root.LogArchives.canExpand(item.path))
    );
    archiveButton.disabled = !supported;
    archiveButton.textContent =
      state.result && state.result.points.length
        ? "Scan archives too"
        : "Analyze archives";
    if (!supported) {
      archiveButton.title =
        "These archives cannot be expanded by this browser.";
    } else {
      archiveButton.removeAttribute("title");
    }
  }

  async function streamPlainFile(file, parser, shouldStop) {
    let reader;
    try {
      reader = file.stream().getReader();
    } catch (error) {
      throw new Error(`Could not open ${file.name || "route log"}`);
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const emitter = lineEmitter((line) => parser.pushLine(line));
    try {
      while (true) {
        if (shouldStop()) {
          try {
            await reader.cancel();
          } catch (error) {}
          return false;
        }
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) emitter.push(text);
      }
      const tail = decoder.decode();
      if (tail) emitter.push(tail);
      emitter.finish();
      parser.finish();
      return true;
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {}
    }
  }

  function lineEmitter(onLine) {
    let buffer = "";
    return {
      push(text) {
        const searchFrom = buffer.length;
        buffer += text;
        let newline = buffer.indexOf("\n", searchFrom);
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          onLine(line);
          newline = buffer.indexOf("\n");
        }
      },
      finish() {
        if (!buffer.length) return;
        if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
        onLine(buffer);
        buffer = "";
      },
    };
  }

  function updateResult() {
    state.result = core.finalize(state.accumulator);
    if (state.manualEvents.length) {
      state.result.events = state.result.events
        .concat(state.manualEvents.map((event) => ({ ...event })))
        .sort((a, b) => a.timestamp - b.timestamp);
    }
    state.activeEventIndex = -1;
    state.hoveredEventIndex = -1;
    const count = state.result.points.length;
    if (!count) {
      state.trace = null;
      visualEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = state.archives.length && !state.archivesScanned
        ? "No route coordinates were found in the plain files. Analyze the archives to continue."
        : "No timestamped localization coordinates were found in this selection.";
      statusEl.textContent = state.analysisErrors.length
        ? state.analysisErrors.slice(0, 2).join("; ")
        : "Route data was not found.";
      return;
    }

    const counts = state.result.counts;
    if (topGrid) topGrid.classList.remove("browse-fill");
    const details = [];
    if (counts.corrected) {
      details.push(
        `${counts.corrected.toLocaleString()} GPS-corrected point${
          counts.corrected === 1 ? "" : "s"
        }`
      );
    }
    if (counts.propagated) {
      details.push(
        `${counts.propagated.toLocaleString()} odometry point${
          counts.propagated === 1 ? "" : "s"
        }`
      );
    }
    if (state.result.events.length) {
      details.push(
        `${state.result.events.length.toLocaleString()} event${
          state.result.events.length === 1 ? "" : "s"
        }`
      );
    }
    if (state.result.engagementTransitions.length) {
      details.push(
        `${state.result.engagementTransitions.length.toLocaleString()} DBW state transition${
          state.result.engagementTransitions.length === 1 ? "" : "s"
        }`
      );
    }
    statusEl.textContent =
      `Found ${details.join(", ")} in ${state.result.files.length.toLocaleString()} file${
        state.result.files.length === 1 ? "" : "s"
      }.` +
      (state.analysisErrors.length
        ? ` ${state.analysisErrors.length} file${
            state.analysisErrors.length === 1 ? "" : "s"
          } could not be read.`
        : "");

    propagatedInput.disabled = !counts.propagated;
    downloadButton.disabled = !state.result.zone;
    streetButton.disabled = !state.result.zone;
    if (state.result.zone && !state.mapChoiceMade) {
      state.streetMode = true;
    }
    streetButton.title = state.result.zone
      ? "Switch between OpenStreetMap and the offline coordinate plot"
      : "A latitude/longitude anchor is required to identify the UTM zone";

    emptyEl.hidden = true;
    visualEl.hidden = false;
    applyTrace(null, true);
  }

  function applyTrace(preserveTimestamp, jumpToEnd) {
    if (!state.result) return;
    state.includePropagated = propagatedInput.checked;
    state.trace = core.buildTrace(state.result, state.includePropagated);
    if (!state.trace.points.length) return;

    let index;
    if (Number.isFinite(preserveTimestamp)) {
      index = core.nearestTimestampIndex(
        state.trace.points,
        preserveTimestamp
      );
    } else {
      index = jumpToEnd ? state.trace.points.length - 1 : 0;
    }
    state.currentIndex = Math.max(
      0,
      Math.min(index, state.trace.points.length - 1)
    );
    routeLegendLabel.textContent = state.result.engagementTransitions.length
      ? "Disengaged"
      : "Route";
    engagedLegend.hidden = !state.trace.engagementSegments.length;
    rangeInput.disabled = state.trace.points.length < 2;
    rangeInput.min = "0";
    rangeInput.max = String(Math.max(0, state.trace.points.length - 1));
    rangeInput.value = String(state.currentIndex);
    playButton.disabled = state.trace.points.length < 2;

    renderStats();
    renderEvents();
    state.streetZoom = null;
    state.streetCenter = null;
    state.localZoom = 1;
    state.localCenter = null;
    renderMap();
    updateTimeline();
  }

  function renderStats() {
    statsEl.replaceChildren();
    const trace = state.trace;
    const result = state.result;
    const crs = result.zone
      ? `UTM ${result.zone}${result.northern ? "N" : "S"} / WGS 84`
      : "UTM / local coordinates";
    const values = [
      [trace.points.length.toLocaleString(), "Plotted points"],
      [formatDuration(trace.durationSeconds), "Duration"],
      [formatDistance(trace.distanceMeters), "Distance"],
      [crs, "Coordinate system"],
    ];
    for (const [value, label] of values) {
      const item = document.createElement("div");
      item.className = "route-stat";
      const number = document.createElement("div");
      number.className = "route-stat-value";
      number.textContent = value;
      const name = document.createElement("div");
      name.className = "route-stat-label";
      name.textContent = label;
      item.append(number, name);
      statsEl.appendChild(item);
    }
  }

  function renderEvents() {
    eventList.replaceChildren();
    const events = state.trace.events
      .map((event, eventIndex) => ({ event, eventIndex }))
      .filter(({ event }) => event.point);
    eventsEl.hidden = !events.length;
    if (workspaceEl) {
      workspaceEl.classList.toggle("no-events", !events.length);
    }
    for (const { event, eventIndex } of events) {
      const row = document.createElement("div");
      row.className = "route-event-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-event-button";
      button.dataset.eventIndex = String(eventIndex);
      const content = event.content || event.type || "Event";
      const time = document.createElement("span");
      time.className = "route-event-time";
      time.textContent = formatClock(event.timestamp);
      const primary = document.createElement("span");
      primary.className = "route-event-primary";
      primary.textContent = content;
      const metadata = [
        event.type,
        event.source === "manual" ? manualEventSource(event) : "",
        event.disengagementType,
        event.severity != null ? `Severity ${event.severity}` : "",
      ].filter(Boolean);
      if (metadata.length) {
        const meta = document.createElement("span");
        meta.className = "route-event-meta";
        meta.textContent = metadata.join(" · ");
        button.append(time, primary, meta);
      } else {
        button.append(time, primary);
      }
      button.setAttribute(
        "aria-label",
        `${formatDateTime(event.timestamp)}: ${content}`
      );
      button.title = [
        formatDateTime(event.timestamp),
        event.type,
        event.disengagementType,
        event.severity != null ? `Severity ${event.severity}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      button.addEventListener("click", () => {
        selectEvent(eventIndex, true);
      });
      button.addEventListener("pointerenter", () => {
        setHoveredEvent(eventIndex, false);
      });
      button.addEventListener("pointerleave", () => {
        clearHoveredEvent(eventIndex);
      });
      row.appendChild(button);
      if (event.source === "manual") {
        row.classList.add("has-remove");
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "route-event-remove";
        removeButton.textContent = "-";
        removeButton.setAttribute(
          "aria-label",
          `Remove ${content} from the event timeline`
        );
        removeButton.title = "Remove from event timeline";
        removeButton.addEventListener("click", (removeClick) => {
          removeClick.stopPropagation();
          removeManualEvent(event.id);
        });
        row.appendChild(removeButton);
      }
      eventList.appendChild(row);
    }
    syncEventHighlights(false);
  }

  function selectEvent(eventIndex, scrollTimeline) {
    const event =
      state.trace && state.trace.events
        ? state.trace.events[eventIndex]
        : null;
    if (!event || !event.point) return;
    state.activeEventIndex = eventIndex;
    stopPlayback();
    setCurrentIndex(event.pointIndex);
    syncEventHighlights(!!scrollTimeline);
  }

  function setHoveredEvent(eventIndex, scrollTimeline) {
    if (state.hoveredEventIndex === eventIndex) return;
    state.hoveredEventIndex = eventIndex;
    syncEventHighlights(!!scrollTimeline);
  }

  function clearHoveredEvent(eventIndex) {
    if (state.hoveredEventIndex !== eventIndex) return;
    state.hoveredEventIndex = -1;
    syncEventHighlights(false);
  }

  function syncEventHighlights(scrollTimeline) {
    for (const entry of eventList.querySelectorAll(".route-event-button")) {
      const index = Number(entry.dataset.eventIndex);
      entry.classList.toggle("is-active", index === state.activeEventIndex);
      entry.classList.toggle("is-hovered", index === state.hoveredEventIndex);
    }
    for (const marker of svg.querySelectorAll(".route-event-marker")) {
      const index = Number(marker.dataset.eventIndex);
      marker.classList.toggle("is-active", index === state.activeEventIndex);
      marker.classList.toggle("is-hovered", index === state.hoveredEventIndex);
    }
    if (scrollTimeline && state.hoveredEventIndex >= 0) {
      const entry = eventList.querySelector(
        `.route-event-button[data-event-index="${state.hoveredEventIndex}"]`
      );
      if (entry) entry.scrollIntoView({ block: "nearest" });
    } else if (scrollTimeline && state.activeEventIndex >= 0) {
      const entry = eventList.querySelector(
        `.route-event-button[data-event-index="${state.activeEventIndex}"]`
      );
      if (entry) entry.scrollIntoView({ block: "nearest" });
    }
  }

  function addEventFromLog(input) {
    if (!state.result || !state.trace || !state.trace.points.length) {
      return {
        ok: false,
        message: "No vehicle route is available for this log selection.",
      };
    }
    const timestamp = Number(input && input.timestamp);
    if (!Number.isFinite(timestamp)) {
      return { ok: false, message: "No usable timestamp was found on this line." };
    }
    const path = String((input && input.path) || "");
    const parsedLineNo = Number((input && input.lineNo) || 0);
    const lineNo = Number.isFinite(parsedLineNo)
      ? Math.max(0, Math.trunc(parsedLineNo))
      : 0;
    const existing = state.manualEvents.find(
      (event) => event.path === path && event.lineNo === lineNo
    );
    if (existing) {
      const existingIndex = state.trace.events.findIndex(
        (event) => event.id === existing.id
      );
      if (existingIndex >= 0) selectEvent(existingIndex, true);
      return {
        ok: true,
        duplicate: true,
        message: `Line ${lineNo.toLocaleString()} is already in the event timeline.`,
      };
    }

    const rawContent = String((input && input.content) || "").trim();
    const content =
      (rawContent || `Log line ${lineNo.toLocaleString()}`).slice(0, 1000);
    const event = {
      id: `manual:${Date.now()}:${state.manualEvents.length}`,
      timestamp,
      type: "Log line",
      disengagementType: "",
      severity: null,
      content,
      path,
      lineNo,
      source: "manual",
    };
    state.manualEvents.push(event);
    state.result.events.push({ ...event });
    state.result.events.sort((a, b) => a.timestamp - b.timestamp);
    state.trace = core.buildTrace(state.result, state.includePropagated);
    renderEvents();
    renderMap();
    const eventIndex = state.trace.events.findIndex(
      (candidate) => candidate.id === event.id
    );
    if (eventIndex >= 0) selectEvent(eventIndex, true);
    return {
      ok: true,
      duplicate: false,
      message: `Added line ${lineNo.toLocaleString()} to the event timeline.`,
    };
  }

  function hasEventFromLog(path, lineNo) {
    return state.manualEvents.some(
      (event) =>
        event.path === String(path || "") && event.lineNo === Number(lineNo)
    );
  }

  function removeManualEvent(eventId) {
    const manualIndex = state.manualEvents.findIndex(
      (event) => event.id === eventId
    );
    if (manualIndex < 0 || !state.result || !state.trace) return false;

    const removed = state.manualEvents[manualIndex];
    const currentPoint = state.trace.points[state.currentIndex];
    const currentTimestamp = currentPoint ? currentPoint.timestamp : null;
    const activeId =
      state.activeEventIndex >= 0
        ? state.trace.events[state.activeEventIndex]?.id
        : null;
    const hoveredId =
      state.hoveredEventIndex >= 0
        ? state.trace.events[state.hoveredEventIndex]?.id
        : null;

    state.manualEvents.splice(manualIndex, 1);
    state.result.events = state.result.events.filter(
      (event) => event.id !== eventId
    );
    state.trace = core.buildTrace(state.result, state.includePropagated);
    state.activeEventIndex =
      activeId && activeId !== eventId
        ? state.trace.events.findIndex((event) => event.id === activeId)
        : -1;
    state.hoveredEventIndex =
      hoveredId && hoveredId !== eventId
        ? state.trace.events.findIndex((event) => event.id === hoveredId)
        : -1;
    if (Number.isFinite(currentTimestamp)) {
      state.currentIndex = core.nearestTimestampIndex(
        state.trace.points,
        currentTimestamp
      );
    }
    tooltip.hidden = true;
    renderEvents();
    renderMap();
    updateTimeline();

    if (typeof root.dispatchEvent === "function" && root.CustomEvent) {
      root.dispatchEvent(
        new root.CustomEvent("logroute:manual-event-removed", {
          detail: { path: removed.path, lineNo: removed.lineNo },
        })
      );
    }
    return true;
  }

  function renderMap() {
    if (!state.trace || !state.trace.points.length) return;
    svg.replaceChildren();
    tooltip.hidden = true;

    const canUseStreet =
      state.streetMode &&
      state.result.zone &&
      state.trace.points.every(
        (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
      );
    let project;
    if (canUseStreet) {
      const street = streetProjection();
      project = street.project;
      drawTiles(street);
      streetButton.textContent = "Local plot";
      zoomOutButton.hidden = false;
      zoomInButton.hidden = false;
      tileLayer.hidden = false;
      attribution.hidden = false;
    } else {
      state.streetMode = false;
      streetButton.textContent = "Street map";
      zoomOutButton.hidden = false;
      zoomInButton.hidden = false;
      tileLayer.replaceChildren();
      tileLayer.hidden = true;
      attribution.hidden = true;
      project = offlineProjection();
      drawGrid(project);
    }
    state.project = project;
    state.screenPoints = state.trace.points.map(project);

    const fullPath = svgElement("path", {
      class: "route-full-path",
      d: pathData(state.trace.points, state.trace.points.length - 1, project),
    });
    state.progressPath = svgElement("path", {
      class: "route-progress-path",
      d: "",
    });
    svg.append(fullPath, state.progressPath);
    const engagedData = state.trace.engagementSegments
      .map((segment) => pathData(segment, segment.length - 1, project))
      .filter(Boolean)
      .join(" ");
    if (engagedData) {
      svg.appendChild(
        svgElement("path", {
          class: "route-engaged-path",
          d: engagedData,
        })
      );
    }

    for (let index = 0; index < state.trace.events.length; index++) {
      const event = state.trace.events[index];
      if (!event.point) continue;
      const position = project(event.point);
      const marker = svgElement("polygon", {
        class: "route-event-marker",
        points: diamondPoints(position.x, position.y, 8),
        role: "button",
        tabindex: "0",
        "aria-label": `${formatDateTime(event.timestamp)}: ${
          event.content || event.type || "Event"
        }`,
      });
      marker.dataset.eventIndex = String(index);
      marker.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        if (performance.now() < state.suppressMapClickUntil) return;
        selectEvent(index, true);
      });
      marker.addEventListener("pointerenter", () => {
        setHoveredEvent(index, true);
      });
      marker.addEventListener("pointerleave", () => {
        clearHoveredEvent(index);
        if (tooltip.dataset.eventIndex === String(index)) {
          tooltip.hidden = true;
        }
      });
      marker.addEventListener("focus", () => {
        setHoveredEvent(index, true);
      });
      marker.addEventListener("blur", () => {
        clearHoveredEvent(index);
      });
      marker.addEventListener("keydown", (keyEvent) => {
        if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
        keyEvent.preventDefault();
        selectEvent(index, true);
      });
      svg.appendChild(marker);
    }

    const first = project(state.trace.points[0]);
    const last = project(state.trace.points[state.trace.points.length - 1]);
    svg.appendChild(
      svgElement("circle", {
        class: "route-start-marker",
        cx: first.x,
        cy: first.y,
        r: 7,
      })
    );
    svg.appendChild(
      svgElement("circle", {
        class: "route-end-marker",
        cx: last.x,
        cy: last.y,
        r: 7,
      })
    );
    state.currentMarker = svgElement("circle", {
      class: "route-current-marker",
      cx: first.x,
      cy: first.y,
      r: 7,
    });
    svg.appendChild(state.currentMarker);
    drawNorthArrow();
    updatePlaybackDrawing();
    syncEventHighlights(false);
  }

  function offlineProjection() {
    const fit = offlineFitParameters();
    if (!state.localCenter) {
      state.localCenter = {
        easting: fit.centerEasting,
        northing: fit.centerNorthing,
      };
    }
    state.localZoom = Math.max(0.25, Math.min(64, state.localZoom || 1));
    const scale = fit.scale * state.localZoom;
    const centerEasting = state.localCenter.easting;
    const centerNorthing = state.localCenter.northing;
    const project = (point) => ({
      x: VIEW_WIDTH / 2 + (point.easting - centerEasting) * scale,
      y: VIEW_HEIGHT / 2 - (point.northing - centerNorthing) * scale,
    });
    project.scale = scale;
    project.fitScale = fit.scale;
    project.centerEasting = centerEasting;
    project.centerNorthing = centerNorthing;
    project.visibleWidth = VIEW_WIDTH / scale;
    project.visibleHeight = VIEW_HEIGHT / scale;
    return project;
  }

  function offlineFitParameters() {
    const bounds = state.trace.bounds;
    const padding = 58;
    const rawWidth = Math.max(1, bounds.maxEasting - bounds.minEasting);
    const rawHeight = Math.max(1, bounds.maxNorthing - bounds.minNorthing);
    const width = Math.max(rawWidth * 1.12, 20);
    const height = Math.max(rawHeight * 1.12, 20);
    const centerEasting = (bounds.minEasting + bounds.maxEasting) / 2;
    const centerNorthing = (bounds.minNorthing + bounds.maxNorthing) / 2;
    const scale = Math.min(
      (VIEW_WIDTH - padding * 2) / width,
      (VIEW_HEIGHT - padding * 2) / height
    );
    return { centerEasting, centerNorthing, scale };
  }

  function drawGrid(project) {
    const widthMeters = project.visibleWidth;
    const heightMeters = project.visibleHeight;
    const step = niceStep(Math.max(widthMeters, heightMeters) / 8);
    const minEasting = project.centerEasting - widthMeters / 2;
    const maxEasting = project.centerEasting + widthMeters / 2;
    const minNorthing = project.centerNorthing - heightMeters / 2;
    const maxNorthing = project.centerNorthing + heightMeters / 2;
    const group = svgElement("g");

    for (
      let easting = Math.ceil(minEasting / step) * step;
      easting <= maxEasting;
      easting += step
    ) {
      const x = project({
        easting,
        northing: project.centerNorthing,
      }).x;
      group.appendChild(
        svgElement("line", {
          class: "route-grid-line",
          x1: x,
          y1: 0,
          x2: x,
          y2: VIEW_HEIGHT,
        })
      );
      const label = svgElement("text", {
        class: "route-grid-label",
        x: x + 4,
        y: VIEW_HEIGHT - 8,
      });
      label.textContent = Math.round(easting).toLocaleString();
      group.appendChild(label);
    }
    for (
      let northing = Math.ceil(minNorthing / step) * step;
      northing <= maxNorthing;
      northing += step
    ) {
      const y = project({
        easting: project.centerEasting,
        northing,
      }).y;
      group.appendChild(
        svgElement("line", {
          class: "route-grid-line",
          x1: 0,
          y1: y,
          x2: VIEW_WIDTH,
          y2: y,
        })
      );
      const label = svgElement("text", {
        class: "route-grid-label",
        x: 7,
        y: y - 5,
      });
      label.textContent = Math.round(northing).toLocaleString();
      group.appendChild(label);
    }
    const scaleLabel = svgElement("text", {
      class: "route-grid-label",
      x: VIEW_WIDTH - 10,
      y: VIEW_HEIGHT - 8,
      "text-anchor": "end",
    });
    scaleLabel.textContent = `Grid ${formatDistance(step)}`;
    group.appendChild(scaleLabel);
    svg.appendChild(group);
  }

  function niceStep(value) {
    const safe = Math.max(0.1, value);
    const power = 10 ** Math.floor(Math.log10(safe));
    const fraction = safe / power;
    if (fraction <= 1) return power;
    if (fraction <= 2) return 2 * power;
    if (fraction <= 5) return 5 * power;
    return 10 * power;
  }

  function streetProjection() {
    const bounds = state.trace.bounds;
    const fitZoom = fitZoomForBounds(bounds);
    state.fitStreetZoom = fitZoom;
    if (!Number.isFinite(state.streetZoom)) state.streetZoom = fitZoom;
    state.streetZoom = Math.max(2, Math.min(19, state.streetZoom));
    const zoom = state.streetZoom;
    if (!state.streetCenter) {
      state.streetCenter = streetCenterForBounds(bounds);
    }
    const scale = TILE_SIZE * 2 ** zoom;
    const center = {
      x: state.streetCenter.x * scale,
      y: state.streetCenter.y * scale,
    };
    const topLeft = {
      x: center.x - VIEW_WIDTH / 2,
      y: center.y - VIEW_HEIGHT / 2,
    };
    return {
      zoom,
      topLeft,
      project(point) {
        const world = latLonToWorld(point.lat, point.lon, zoom);
        return {
          x: world.x - topLeft.x,
          y: world.y - topLeft.y,
        };
      },
    };
  }

  function streetCenterForBounds(bounds) {
    const northwest = latLonToWorld(bounds.maxLat, bounds.minLon, 0);
    const southeast = latLonToWorld(bounds.minLat, bounds.maxLon, 0);
    return {
      x: (northwest.x + southeast.x) / (2 * TILE_SIZE),
      y: (northwest.y + southeast.y) / (2 * TILE_SIZE),
    };
  }

  function fitZoomForBounds(bounds) {
    for (let zoom = 19; zoom >= 2; zoom--) {
      const northwest = latLonToWorld(bounds.maxLat, bounds.minLon, zoom);
      const southeast = latLonToWorld(bounds.minLat, bounds.maxLon, zoom);
      if (
        Math.abs(southeast.x - northwest.x) <= VIEW_WIDTH - 120 &&
        Math.abs(southeast.y - northwest.y) <= VIEW_HEIGHT - 120
      ) {
        return zoom;
      }
    }
    return 2;
  }

  function latLonToWorld(lat, lon, zoom) {
    const scale = TILE_SIZE * 2 ** zoom;
    const clippedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sin = Math.sin((clippedLat * Math.PI) / 180);
    return {
      x: ((lon + 180) / 360) * scale,
      y:
        (0.5 -
          Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) *
        scale,
    };
  }

  function drawTiles(street) {
    const displayZoom = street.zoom;
    const tileZoom = Math.max(0, Math.min(19, Math.floor(displayZoom)));
    const displayTileSize = TILE_SIZE * 2 ** (displayZoom - tileZoom);
    const count = 2 ** tileZoom;
    const minTileX = Math.floor(street.topLeft.x / displayTileSize);
    const maxTileX = Math.floor(
      (street.topLeft.x + VIEW_WIDTH) / displayTileSize
    );
    const minTileY = Math.max(
      0,
      Math.floor(street.topLeft.y / displayTileSize)
    );
    const maxTileY = Math.min(
      count - 1,
      Math.floor(
        (street.topLeft.y + VIEW_HEIGHT) / displayTileSize
      )
    );
    const existing = new Map(
      Array.from(tileLayer.children, (image) => [image.dataset.tileKey, image])
    );
    const needed = new Set();
    for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
        const wrappedX = ((tileX % count) + count) % count;
        const key = `${tileZoom}/${tileX}/${tileY}`;
        needed.add(key);
        let image = existing.get(key);
        if (!image) {
          image = document.createElement("img");
          image.className = "route-tile";
          image.alt = "";
          image.decoding = "async";
          image.draggable = false;
          image.referrerPolicy = "origin";
          image.dataset.tileKey = key;
          image.src = `https://tile.openstreetmap.org/${tileZoom}/${wrappedX}/${tileY}.png`;
          tileLayer.appendChild(image);
        }
        image.style.left = `${
          ((tileX * displayTileSize - street.topLeft.x) / VIEW_WIDTH) * 100
        }%`;
        image.style.top = `${
          ((tileY * displayTileSize - street.topLeft.y) / VIEW_HEIGHT) * 100
        }%`;
        image.style.width = `${(displayTileSize / VIEW_WIDTH) * 100}%`;
        image.style.height = `${(displayTileSize / VIEW_HEIGHT) * 100}%`;
      }
    }
    for (const [key, image] of existing) {
      if (!needed.has(key)) image.remove();
    }
  }

  function drawNorthArrow() {
    const group = svgElement("g", {
      transform: `translate(${VIEW_WIDTH - 34} 27)`,
    });
    const label = svgElement("text", {
      class: "route-grid-label",
      x: 0,
      y: 0,
      "text-anchor": "middle",
    });
    label.textContent = "N";
    const arrow = svgElement("path", {
      d: "M 0 7 L -6 20 L 0 16 L 6 20 Z",
      fill: "#c7d2e3",
      stroke: "#111",
      "stroke-width": 1,
    });
    group.append(label, arrow);
    svg.appendChild(group);
  }

  function pathData(points, lastIndex, project) {
    let data = "";
    const end = Math.min(lastIndex, points.length - 1);
    for (let index = 0; index <= end; index++) {
      const point = points[index];
      const position = project(point);
      data += `${
        index === 0 || point.breakBefore ? "M" : "L"
      }${position.x.toFixed(2)},${position.y.toFixed(2)} `;
    }
    return data.trim();
  }

  function diamondPoints(x, y, radius) {
    return `${x},${y - radius} ${x + radius},${y} ${x},${
      y + radius
    } ${x - radius},${y}`;
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
      }
    }
    return element;
  }

  function setCurrentIndex(index) {
    if (!state.trace || !state.trace.points.length) return;
    state.currentIndex = Math.max(
      0,
      Math.min(Number(index) || 0, state.trace.points.length - 1)
    );
    rangeInput.value = String(state.currentIndex);
    updatePlaybackDrawing();
    updateTimeline();
  }

  function updatePlaybackDrawing() {
    if (!state.trace || !state.project) return;
    if (state.progressPath) {
      state.progressPath.setAttribute(
        "d",
        pathData(state.trace.points, state.currentIndex, state.project)
      );
    }
    const point = state.trace.points[state.currentIndex];
    if (state.currentMarker && point) {
      const position = state.project(point);
      state.currentMarker.setAttribute("cx", position.x);
      state.currentMarker.setAttribute("cy", position.y);
    }
  }

  function updateTimeline() {
    if (!state.trace || state.currentIndex < 0) {
      timeEl.textContent = "";
      return;
    }
    const points = state.trace.points;
    const point = points[state.currentIndex];
    const activeEvent =
      state.activeEventIndex >= 0
        ? state.trace.events[state.activeEventIndex]
        : null;
    const timestamp =
      activeEvent && activeEvent.pointIndex === state.currentIndex
        ? activeEvent.timestamp
        : point.timestamp;
    const elapsed = timestamp - points[0].timestamp;
    timeEl.textContent = `${formatClock(timestamp)} · ${formatDuration(
      elapsed
    )} / ${formatDuration(state.trace.durationSeconds)}`;
  }

  function togglePlayback() {
    if (state.playRaf) {
      stopPlayback();
      return;
    }
    if (!state.trace || state.trace.points.length < 2) return;
    state.activeEventIndex = -1;
    syncEventHighlights(false);
    if (state.currentIndex >= state.trace.points.length - 1) setCurrentIndex(0);
    state.playSimulatedTime =
      state.trace.points[state.currentIndex].timestamp;
    state.playLastReal = performance.now();
    playButton.textContent = "Pause";
    state.playRaf = requestAnimationFrame(playFrame);
  }

  function playFrame(now) {
    if (!state.trace) {
      stopPlayback();
      return;
    }
    const speed = Number(speedInput.value) || 30;
    state.playSimulatedTime +=
      ((now - state.playLastReal) / 1000) * speed;
    state.playLastReal = now;
    const points = state.trace.points;
    let index = state.currentIndex;
    while (
      index + 1 < points.length &&
      points[index + 1].timestamp <= state.playSimulatedTime
    ) {
      index++;
    }
    if (index !== state.currentIndex) setCurrentIndex(index);
    if (index >= points.length - 1) {
      stopPlayback();
      return;
    }
    state.playRaf = requestAnimationFrame(playFrame);
  }

  function stopPlayback() {
    if (state.playRaf) cancelAnimationFrame(state.playRaf);
    state.playRaf = 0;
    playButton.textContent = "Play";
  }

  function toggleStreetMap() {
    state.mapChoiceMade = true;
    if (state.streetMode) {
      state.streetMode = false;
      streetButton.textContent = "Street map";
      renderMap();
      return;
    }
    if (!state.result || !state.result.zone) return;
    state.streetMode = true;
    streetButton.textContent = "Local plot";
    zoomOutButton.hidden = false;
    zoomInButton.hidden = false;
    renderMap();
  }

  function ensureStreetView() {
    if (!state.trace || !state.trace.bounds) return false;
    if (!Number.isFinite(state.streetZoom)) {
      state.streetZoom = fitZoomForBounds(state.trace.bounds);
    }
    if (!state.streetCenter) {
      state.streetCenter = streetCenterForBounds(state.trace.bounds);
    }
    return true;
  }

  function zoomMap(delta, focalPoint, shouldRender = true) {
    if (!state.trace || !Number.isFinite(delta) || delta === 0) return;
    const focal = focalPoint || {
      x: VIEW_WIDTH / 2,
      y: VIEW_HEIGHT / 2,
    };

    if (state.streetMode && state.result && state.result.zone) {
      if (!ensureStreetView()) return;
      const oldZoom = state.streetZoom;
      const newZoom = Math.max(2, Math.min(19, oldZoom + delta));
      if (newZoom === oldZoom) return;
      const oldScale = TILE_SIZE * 2 ** oldZoom;
      const newScale = TILE_SIZE * 2 ** newZoom;
      const oldTopLeft = {
        x: state.streetCenter.x * oldScale - VIEW_WIDTH / 2,
        y: state.streetCenter.y * oldScale - VIEW_HEIGHT / 2,
      };
      const anchor = {
        x: (oldTopLeft.x + focal.x) / oldScale,
        y: (oldTopLeft.y + focal.y) / oldScale,
      };
      state.streetZoom = newZoom;
      state.streetCenter = {
        x:
          (anchor.x * newScale - focal.x + VIEW_WIDTH / 2) /
          newScale,
        y:
          (anchor.y * newScale - focal.y + VIEW_HEIGHT / 2) /
          newScale,
      };
      clampStreetCenter();
    } else {
      const fit = offlineFitParameters();
      if (!state.localCenter) {
        state.localCenter = {
          easting: fit.centerEasting,
          northing: fit.centerNorthing,
        };
      }
      const oldZoom = state.localZoom || 1;
      const newZoom = Math.max(0.25, Math.min(64, oldZoom * 2 ** delta));
      if (newZoom === oldZoom) return;
      const oldScale = fit.scale * oldZoom;
      const newScale = fit.scale * newZoom;
      const anchor = {
        easting:
          state.localCenter.easting +
          (focal.x - VIEW_WIDTH / 2) / oldScale,
        northing:
          state.localCenter.northing -
          (focal.y - VIEW_HEIGHT / 2) / oldScale,
      };
      state.localZoom = newZoom;
      state.localCenter = {
        easting:
          anchor.easting -
          (focal.x - VIEW_WIDTH / 2) / newScale,
        northing:
          anchor.northing +
          (focal.y - VIEW_HEIGHT / 2) / newScale,
      };
    }
    if (shouldRender) scheduleMapRender();
  }

  function panMap(deltaX, deltaY, shouldRender = true) {
    if (!state.trace) return;
    if (state.streetMode && state.result && state.result.zone) {
      if (!ensureStreetView()) return;
      const scale = TILE_SIZE * 2 ** state.streetZoom;
      state.streetCenter.x -= deltaX / scale;
      state.streetCenter.y -= deltaY / scale;
      clampStreetCenter();
    } else {
      const fit = offlineFitParameters();
      if (!state.localCenter) {
        state.localCenter = {
          easting: fit.centerEasting,
          northing: fit.centerNorthing,
        };
      }
      const scale = fit.scale * (state.localZoom || 1);
      state.localCenter.easting -= deltaX / scale;
      state.localCenter.northing += deltaY / scale;
    }
    if (shouldRender) scheduleMapRender();
  }

  function clampStreetCenter() {
    if (!state.streetCenter || !Number.isFinite(state.streetZoom)) return;
    const scale = TILE_SIZE * 2 ** state.streetZoom;
    const halfHeight = Math.min(0.5, VIEW_HEIGHT / (2 * scale));
    state.streetCenter.y = Math.max(
      halfHeight,
      Math.min(1 - halfHeight, state.streetCenter.y)
    );
  }

  function scheduleMapRender() {
    if (state.mapRenderRaf) return;
    state.mapRenderRaf = requestAnimationFrame(() => {
      state.mapRenderRaf = 0;
      renderMap();
    });
  }

  function fitMap() {
    if (state.streetMode && state.result && state.result.zone) {
      state.streetZoom = null;
      state.streetCenter = null;
    } else {
      state.localZoom = 1;
      state.localCenter = null;
    }
    renderMap();
  }

  function mapPointFromClient(clientX, clientY) {
    const rect = mapFrame.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_WIDTH,
      y: ((clientY - rect.top) / rect.height) * VIEW_HEIGHT,
    };
  }

  function gestureSnapshot() {
    const pointers = Array.from(state.activePointers.values());
    if (!pointers.length) return null;
    if (pointers.length === 1) {
      return { kind: "pan", point: pointers[0] };
    }
    const first = pointers[0];
    const second = pointers[1];
    return {
      kind: "pinch",
      midpoint: {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      },
      distance: Math.max(
        1,
        Math.hypot(second.x - first.x, second.y - first.y)
      ),
    };
  }

  function isMapControl(target) {
    return !!(
      target &&
      target.closest &&
      target.closest(".route-map-buttons, .route-map-attribution")
    );
  }

  function onMapPointerDown(event) {
    if (!state.trace || isMapControl(event.target)) return;
    if (
      event.target &&
      event.target.closest &&
      event.target.closest(".route-event-marker")
    ) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const point = mapPointFromClient(event.clientX, event.clientY);
    state.activePointers.set(event.pointerId, point);
    state.gesture = gestureSnapshot();
    state.hoveredEventIndex = -1;
    syncEventHighlights(false);
    tooltip.hidden = true;
    mapFrame.classList.add("dragging");
    try {
      mapFrame.setPointerCapture(event.pointerId);
    } catch (error) {}
  }

  function onMapPointerDrag(event) {
    if (!state.activePointers.has(event.pointerId)) return;
    event.preventDefault();
    const previous = state.gesture;
    state.activePointers.set(
      event.pointerId,
      mapPointFromClient(event.clientX, event.clientY)
    );
    const next = gestureSnapshot();
    let moved = false;

    if (previous && next && previous.kind === next.kind) {
      if (next.kind === "pan") {
        const deltaX = next.point.x - previous.point.x;
        const deltaY = next.point.y - previous.point.y;
        if (Math.hypot(deltaX, deltaY) > 0.05) {
          panMap(deltaX, deltaY, false);
          moved = true;
        }
      } else {
        const deltaX = next.midpoint.x - previous.midpoint.x;
        const deltaY = next.midpoint.y - previous.midpoint.y;
        if (Math.hypot(deltaX, deltaY) > 0.05) {
          panMap(deltaX, deltaY, false);
          moved = true;
        }
        const zoomDelta = Math.log2(next.distance / previous.distance);
        if (Math.abs(zoomDelta) > 0.001) {
          zoomMap(zoomDelta, next.midpoint, false);
          moved = true;
        }
      }
    }

    state.gesture = next;
    if (moved) {
      state.suppressMapClickUntil = performance.now() + 300;
      tooltip.hidden = true;
      scheduleMapRender();
    }
  }

  function onMapPointerUp(event) {
    if (!state.activePointers.has(event.pointerId)) return;
    state.activePointers.delete(event.pointerId);
    state.gesture = gestureSnapshot();
    try {
      mapFrame.releasePointerCapture(event.pointerId);
    } catch (error) {}
    if (!state.activePointers.size) {
      mapFrame.classList.remove("dragging");
    }
  }

  function onMapWheel(event) {
    if (!state.trace || isMapControl(event.target)) return;
    event.preventDefault();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 240;
    const sensitivity = event.ctrlKey ? 0.01 : 0.0025;
    const zoomDelta = Math.max(-1.25, Math.min(1.25, -delta * sensitivity));
    if (!zoomDelta) return;
    state.suppressMapClickUntil = performance.now() + 200;
    state.hoveredEventIndex = -1;
    syncEventHighlights(false);
    tooltip.hidden = true;
    zoomMap(
      zoomDelta,
      mapPointFromClient(event.clientX, event.clientY)
    );
  }

  function onMapPointerMove(event) {
    if (state.activePointers.size) {
      tooltip.hidden = true;
      return;
    }
    const eventMarker =
      event.target && event.target.closest
        ? event.target.closest(".route-event-marker")
        : null;
    if (eventMarker) {
      const eventIndex = Number(eventMarker.dataset.eventIndex);
      if (Number.isInteger(eventIndex)) {
        showEventTooltip(eventIndex, event);
        return;
      }
    }
    if (!state.screenPoints.length) return;
    const rect = mapFrame.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const y = ((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT;
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let index = 0; index < state.screenPoints.length; index++) {
      const point = state.screenPoints[index];
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    if (nearest < 0 || nearestDistance > 20) {
      tooltip.hidden = true;
      delete tooltip.dataset.pointIndex;
      delete tooltip.dataset.eventIndex;
      return;
    }
    const point = state.trace.points[nearest];
    const lines = [
      `${pointLabel(point.kind)} · ${formatDateTime(point.timestamp)}`,
      `UTM ${point.easting.toFixed(2)}, ${point.northing.toFixed(2)}`,
    ];
    if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
      lines.push(`${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`);
    }
    tooltip.textContent = lines.join("\n");
    tooltip.hidden = false;
    delete tooltip.dataset.eventIndex;
    tooltip.dataset.pointIndex = String(nearest);
    positionMapTooltip(event, rect);
  }

  function showEventTooltip(eventIndex, pointerEvent) {
    const event =
      state.trace && state.trace.events
        ? state.trace.events[eventIndex]
        : null;
    if (!event) return;
    const lines = [
      event.content || event.type || "Event",
      formatDateTime(event.timestamp),
      event.type || "",
      event.source === "manual" ? manualEventSource(event) : "",
      event.disengagementType
        ? `Disengagement: ${event.disengagementType}`
        : "",
      event.severity != null ? `Severity: ${event.severity}` : "",
    ].filter(Boolean);
    tooltip.textContent = lines.join("\n");
    tooltip.hidden = false;
    delete tooltip.dataset.pointIndex;
    tooltip.dataset.eventIndex = String(eventIndex);
    positionMapTooltip(pointerEvent);
  }

  function positionMapTooltip(pointerEvent, existingRect) {
    const rect = existingRect || mapFrame.getBoundingClientRect();
    const width = tooltip.offsetWidth || 250;
    const height = tooltip.offsetHeight || 80;
    const pointerX = pointerEvent.clientX - rect.left;
    const pointerY = pointerEvent.clientY - rect.top;
    let left = pointerX + 12;
    let top = pointerY + 12;
    if (left + width > rect.width - 6) left = pointerX - width - 12;
    if (top + height > rect.height - 6) top = pointerY - height - 12;
    tooltip.style.left = `${Math.max(6, left)}px`;
    tooltip.style.top = `${Math.max(6, top)}px`;
  }

  function onMapClick() {
    if (performance.now() < state.suppressMapClickUntil) return;
    if (tooltip.hidden) return;
    const index = Number(tooltip.dataset.pointIndex);
    if (!Number.isInteger(index)) return;
    state.activeEventIndex = -1;
    syncEventHighlights(false);
    stopPlayback();
    setCurrentIndex(index);
  }

  function downloadGeoJson() {
    if (!state.trace || !state.result || !state.result.zone) return;
    const segments = [];
    let segment = [];
    for (const point of state.trace.points) {
      if (point.breakBefore && segment.length) {
        segments.push(segment);
        segment = [];
      }
      segment.push([point.lon, point.lat]);
    }
    if (segment.length) segments.push(segment);

    const features = segments.map((coordinates, index) => ({
      type: "Feature",
      properties: {
        kind: "vehicle_route",
        segment: index + 1,
      },
      geometry: {
        type: "LineString",
        coordinates,
      },
    }));
    for (const event of state.trace.events) {
      if (!event.point) continue;
      features.push({
        type: "Feature",
        properties: {
          kind: "annotation",
          timestamp: new Date(event.timestamp * 1000).toISOString(),
          type: event.type || null,
          disengagement_type: event.disengagementType || null,
          severity: event.severity,
          content: event.content || null,
        },
        geometry: {
          type: "Point",
          coordinates: [event.point.lon, event.point.lat],
        },
      });
    }
    const geoJson = {
      type: "FeatureCollection",
      properties: {
        coordinate_source: `UTM ${state.result.zone}${
          state.result.northern ? "N" : "S"
        } / WGS 84`,
      },
      features,
    };
    const blob = new Blob([JSON.stringify(geoJson, null, 2) + "\n"], {
      type: "application/geo+json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "logsearch-route.geojson";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return "—";
    if (meters >= 1000) {
      const kilometers = meters / 1000;
      return `${kilometers.toFixed(kilometers >= 10 ? 1 : 2)} km`;
    }
    return `${Math.round(meters).toLocaleString()} m`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    if (hours) return `${hours}h ${minutes}m ${remainder}s`;
    if (minutes) return `${minutes}m ${remainder}s`;
    return `${remainder}s`;
  }

  function formatClock(timestamp) {
    return new Date(timestamp * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatDateTime(timestamp) {
    return new Date(timestamp * 1000).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function pointLabel(kind) {
    if (kind === "corrected") return "GPS corrected";
    if (kind === "propagated") return "Odometry propagated";
    if (kind === "initial") return "Initial position";
    return "Localization";
  }

  function manualEventSource(event) {
    const path = String(event.path || "");
    const name = path.split("/").pop() || path || "Log";
    return event.lineNo ? `${name}:${event.lineNo}` : name;
  }

  archiveButton.addEventListener("click", () => void analyzeArchives());
  collapseButton.addEventListener("click", () => {
    bodyEl.hidden = !bodyEl.hidden;
    collapseButton.textContent = bodyEl.hidden ? "Show" : "Hide";
  });
  propagatedInput.addEventListener("change", () => {
    stopPlayback();
    const point =
      state.trace && state.trace.points[state.currentIndex]
        ? state.trace.points[state.currentIndex]
        : null;
    applyTrace(point ? point.timestamp : null, false);
  });
  rangeInput.addEventListener("input", () => {
    stopPlayback();
    state.activeEventIndex = -1;
    syncEventHighlights(false);
    setCurrentIndex(Number(rangeInput.value));
  });
  playButton.addEventListener("click", togglePlayback);
  streetButton.addEventListener("click", toggleStreetMap);
  zoomOutButton.addEventListener("click", () => zoomMap(-1));
  zoomInButton.addEventListener("click", () => zoomMap(1));
  fitButton.addEventListener("click", fitMap);
  downloadButton.addEventListener("click", downloadGeoJson);
  mapFrame.addEventListener("pointerdown", onMapPointerDown);
  mapFrame.addEventListener("pointermove", onMapPointerDrag);
  mapFrame.addEventListener("pointerup", onMapPointerUp);
  mapFrame.addEventListener("pointercancel", onMapPointerUp);
  mapFrame.addEventListener("lostpointercapture", onMapPointerUp);
  mapFrame.addEventListener("wheel", onMapWheel, { passive: false });
  svg.addEventListener("pointermove", onMapPointerMove);
  svg.addEventListener("pointerleave", () => {
    state.hoveredEventIndex = -1;
    syncEventHighlights(false);
    tooltip.hidden = true;
  });
  svg.addEventListener("click", onMapClick);

  root.LogRoute = { addEventFromLog, hasEventFromLog, setSelection };
})(typeof globalThis !== "undefined" ? globalThis : this);
