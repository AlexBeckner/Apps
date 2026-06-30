const DEFAULT_REPO = "AppliedNeuron/core-stack";

export function isDashboardRoute(pathname) {
  return !pathname.startsWith("/api/") && pathname !== "/api";
}

export function dashboardHtml(env) {
  const repo = (env.GITHUB_REPO || DEFAULT_REPO).trim();
  const configJson = JSON.stringify({ repo });

  return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>GitHub Dashboard</title>
    <style>
      :root {
        --bg: #0b0e14;
        --bg-elevated: #11151c;
        --bg-elevated-2: #161b24;
        --border: #2a3140;
        --border-strong: #3a4356;
        --text: #e6e8eb;
        --text-muted: #8b95a7;
        --text-subtle: #5e6878;
        --accent: #4f8cff;
        --accent-strong: #6ea2ff;
        --success: #2ea043;
        --warning: #d29922;
        --danger: #f85149;
        --merged: #a371f7;
        --draft: #7d8590;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-width: 320px; }
      a { color: inherit; text-decoration: none; }
      button, input, select, textarea { color: inherit; font: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      input::placeholder { color: var(--text-subtle); }
      *:focus-visible { border-radius: 4px; outline: 2px solid var(--accent); outline-offset: 2px; }
      .topbar { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border); background: rgba(11, 14, 20, .9); backdrop-filter: blur(12px); }
      .topbar-main { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; }
      .brand-row, .actions-row, .brand-link, .nav, .mobile-nav, .search-label, .sync-wrap, .badge, .row-meta, .pager, .button-group, .stat-grid { display: flex; align-items: center; }
      .brand-row { gap: 12px; }
      .brand-link { gap: 8px; min-width: 0; }
      .logo { display: grid; width: 32px; height: 32px; flex: none; place-items: center; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated-2); color: var(--accent); }
      .brand-title { display: block; font-size: 14px; font-weight: 650; line-height: 1.1; }
      .brand-repo { display: block; margin-top: 2px; color: var(--text-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.1; }
      .brand-repo:hover, .link:hover, .panel-link:hover, .table-link:hover, .nav-link:hover, .crumb a:hover { color: var(--accent); }
      .nav { display: none; gap: 4px; margin-left: 16px; }
      .mobile-nav { gap: 4px; overflow-x: auto; border-top: 1px solid var(--border); padding: 4px 16px; }
      .nav-link { border-radius: 6px; padding: 6px 10px; color: var(--text-muted); font-size: 13px; white-space: nowrap; }
      .nav-link.active { background: rgba(79, 140, 255, .15); color: var(--accent); }
      .actions-row { justify-content: flex-end; gap: 12px; min-width: 0; }
      .search { position: relative; flex: 1; min-width: 0; }
      .search-label { gap: 8px; width: 100%; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); padding: 8px 12px; }
      .search-label:focus-within { border-color: var(--accent); }
      .search-input, .filter-input { width: 100%; border: 0; background: transparent; outline: none; }
      .search-input { font-size: 14px; }
      .kbd { border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; color: var(--text-subtle); font-size: 10px; }
      .search-menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40; max-height: 28rem; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); box-shadow: 0 18px 50px rgba(0, 0, 0, .35); }
      .search-section-title { border-bottom: 1px solid var(--border); background: var(--bg-elevated-2); padding: 4px 12px; color: var(--text-subtle); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
      .search-result { display: block; border-bottom: 1px solid rgba(42, 49, 64, .6); padding: 8px 12px; }
      .search-result:hover, .list-row:hover, tbody tr:hover, .pr-row:hover { background: var(--bg-elevated-2); }
      .search-footer { display: flex; justify-content: space-between; border-top: 1px solid var(--border); background: var(--bg-elevated-2); padding: 8px 12px; color: var(--text-muted); font-size: 12px; }
      .sync-wrap { position: relative; gap: 12px; flex: none; }
      .last-sync { display: none; color: var(--text-subtle); font-size: 11px; line-height: 1.2; text-align: right; }
      .last-sync strong { display: block; color: var(--text-muted); font-weight: 400; }
      .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); padding: 6px 12px; color: var(--text); font-size: 14px; font-weight: 500; }
      .btn:hover { border-color: var(--accent); color: var(--accent); }
      .btn-danger { border-color: rgba(248, 81, 73, .4); background: rgba(248, 81, 73, .1); color: var(--danger); }
      .token-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; width: min(24rem, calc(100vw - 2rem)); border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); padding: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, .35); }
      .token-popover label { display: grid; gap: 6px; color: var(--text-subtle); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      .token-popover input { width: 100%; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated-2); padding: 8px 10px; color: var(--text); outline: none; }
      .token-popover input:focus { border-color: var(--accent); }
      .token-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 10px; }
      .token-help { margin-top: 8px; color: var(--text-subtle); font-size: 11px; line-height: 1.4; text-transform: none; letter-spacing: 0; }
      .sync-error-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; width: min(28rem, calc(100vw - 2rem)); border: 1px solid rgba(248, 81, 73, .4); border-radius: 6px; background: var(--bg-elevated); padding: 12px; color: var(--danger); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; box-shadow: 0 18px 50px rgba(0, 0, 0, .35); }
      .sync-banner { border-bottom: 1px solid rgba(79, 140, 255, .3); background: rgba(79, 140, 255, .05); color: var(--accent); padding: 8px 16px; font-size: 12px; }
      .pulse-dot { display: inline-block; width: 8px; height: 8px; margin-right: 12px; border-radius: 999px; background: var(--accent); animation: pulse 1.2s infinite; }
      .spin { animation: spin 1s linear infinite; }
      main { padding: 16px; }
      .page { display: grid; gap: 16px; }
      .header-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
      h1 { margin: 0; font-size: 20px; font-weight: 650; }
      h2 { margin: 0; font-size: 14px; font-weight: 650; }
      p { margin: 0; }
      .subtle { color: var(--text-subtle); }
      .muted { color: var(--text-muted); }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .tiny { font-size: 11px; }
      .small { font-size: 12px; }
      .text-sm { font-size: 14px; }
      .break { overflow-wrap: anywhere; }
      .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .panel-grid { display: grid; gap: 16px; }
      .detail-grid, .two-grid { display: grid; gap: 16px; }
      .badge { gap: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); padding: 8px 12px; }
      .badge-value { color: var(--text); font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .badge-label { color: var(--text-muted); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
      .tone-accent { border-color: rgba(79, 140, 255, .4); color: var(--accent); }
      .tone-success { border-color: rgba(46, 160, 67, .4); color: var(--success); }
      .tone-merged { border-color: rgba(163, 113, 247, .4); color: var(--merged); }
      .tone-warning { border-color: rgba(210, 153, 34, .4); color: var(--warning); }
      .panel { min-height: 200px; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated); }
      .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); padding: 8px 16px; }
      .panel-body { min-height: 0; }
      .panel-stack { display: grid; gap: 16px; }
      .panel-link { color: var(--text-muted); font-size: 12px; }
      .empty { padding: 24px 16px; color: var(--text-subtle); font-size: 14px; text-align: center; }
      .list-scroll { max-height: 600px; overflow: auto; }
      .list-row { display: block; border-bottom: 1px solid rgba(42, 49, 64, .6); padding: 10px 16px; }
      .list-row:last-child { border-bottom: 0; }
      .row-meta { justify-content: space-between; gap: 8px; margin-top: 3px; color: var(--text-subtle); font-size: 11px; }
      .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .input, .select, .filter-input { border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); padding: 6px 10px; font-size: 14px; outline: none; }
      .input-sm { max-width: 16rem; padding: 4px 8px; font-size: 12px; }
      .input:focus, .select:focus, .filter-input:focus { border-color: var(--accent); }
      .check { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); padding: 6px 10px; font-size: 14px; }
      .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th { background: var(--bg-elevated-2); color: var(--text-subtle); font-size: 11px; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
      th, td { border-bottom: 1px solid rgba(42, 49, 64, .6); padding: 8px 16px; vertical-align: top; }
      tr:last-child td { border-bottom: 0; }
      .table-link { color: var(--text-muted); }
      .state { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
      .state:before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: currentColor; }
      .state-open { border-color: rgba(46, 160, 67, .4); background: rgba(46, 160, 67, .1); color: var(--success); }
      .state-merged { border-color: rgba(163, 113, 247, .4); background: rgba(163, 113, 247, .1); color: var(--merged); }
      .state-closed { border-color: rgba(248, 81, 73, .4); background: rgba(248, 81, 73, .1); color: var(--danger); }
      .state-draft { border-color: rgba(125, 133, 144, .4); background: rgba(125, 133, 144, .1); color: var(--draft); }
      .pill { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 6px; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
      .pill-accent { background: rgba(79, 140, 255, .15); color: var(--accent); }
      .pill-danger { background: rgba(248, 81, 73, .15); color: var(--danger); }
      .button-group { overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-elevated); }
      .segment { border: 0; border-right: 1px solid var(--border); background: transparent; padding: 7px 12px; color: var(--text-muted); font-size: 14px; }
      .segment:last-child { border-right: 0; }
      .segment.active { background: rgba(79, 140, 255, .15); color: var(--accent); }
      .pr-list { list-style: none; margin: 0; padding: 0; }
      .pager { justify-content: space-between; gap: 12px; border-top: 1px solid rgba(42, 49, 64, .6); padding: 8px 16px; }
      .alert { border: 1px solid rgba(248, 81, 73, .4); border-radius: 8px; background: rgba(248, 81, 73, .1); padding: 16px; color: var(--danger); font-size: 14px; }
      .welcome { border: 1px solid rgba(79, 140, 255, .4); border-radius: 10px; background: rgba(79, 140, 255, .05); padding: 24px; }
      .warning { border: 1px solid rgba(210, 153, 34, .4); border-radius: 8px; background: rgba(210, 153, 34, .1); padding: 16px; color: var(--warning); font-size: 14px; }
      .stat-grid { display: grid; grid-template-columns: repeat(1, minmax(0, 1fr)); gap: 12px; }
      .stat { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); padding: 12px; }
      .stat-label { color: var(--text-subtle); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      .stat-value { margin-top: 4px; font-size: 14px; }
      pre.message { overflow: auto; max-height: 18rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); padding: 12px; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
      .skeleton { min-height: 400px; border: 1px solid var(--border); border-radius: 8px; background: linear-gradient(90deg, var(--bg-elevated), var(--bg-elevated-2), var(--bg-elevated)); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
      .hidden { display: none !important; }
      @media (min-width: 640px) {
        .card-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .last-sync { display: block; }
        .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
      @media (min-width: 1024px) {
        .topbar-main { flex-direction: row; align-items: center; }
        .actions-row { flex: 1; }
        .search { max-width: 36rem; }
        .nav { display: flex; }
        .mobile-nav { display: none; }
        .panel-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .two-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (min-width: 1280px) {
        .card-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
        .panel-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { 50% { opacity: .35; } }
      @keyframes shimmer { to { background-position: -200% 0; } }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="topbar-main">
        <div class="brand-row">
          <a href="/" class="brand-link" data-link>
            <span class="logo" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.49 2.49 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z"/></svg>
            </span>
            <span>
              <span class="brand-title">GitHub Dashboard</span>
              <span class="brand-repo">${escapeHtml(repo)}</span>
            </span>
          </a>
          <nav class="nav" data-nav></nav>
        </div>
        <div class="actions-row">
          <div class="search" id="search-root"></div>
          <div class="sync-wrap" id="sync-root"></div>
        </div>
      </div>
      <nav class="mobile-nav" data-nav></nav>
      <div id="sync-banner"></div>
    </header>
    <main id="app"><div class="skeleton" aria-label="Loading"></div></main>
    <script>window.__DASHBOARD_CONFIG__ = ${configJson};</script>
    <script>
(function () {
  "use strict";

  var config = window.__DASHBOARD_CONFIG__ || { repo: "${escapeJs(repo)}" };
  var app = document.getElementById("app");
  var searchRoot = document.getElementById("search-root");
  var syncRoot = document.getElementById("sync-root");
  var bannerRoot = document.getElementById("sync-banner");
  var adminStorageKey = "githubdashboard.adminToken";
  var navLinks = [
    { href: "/", label: "Home" },
    { href: "/branches", label: "Branches" },
    { href: "/tags", label: "Tags" },
    { href: "/commits", label: "Commits" },
    { href: "/prs", label: "PRs" }
  ];
  var state = {
    branch: { includeDeleted: false, sort: "last_commit_at", filter: "" },
    branchDetail: { name: "", commitsPage: 0, commitsFilter: "", prsFromPage: 0, prsFromFilter: "", prsToPage: 0, prsToFilter: "" },
    tag: { includeDeleted: false, sort: "tagged_at", filter: "" },
    commits: { page: 0, filter: "" },
    prs: { page: 0, state: "all", filter: "" },
    searchValue: "",
    searchOpen: false,
    searchTimer: null,
    searchResults: null,
    sync: null,
    syncErrorOpen: false,
    adminTokenOpen: false
  };

  var inputRestore = null;

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function attr(value) {
    return escape(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
  }

  function api(path) {
    return fetch(path, { cache: "no-store" }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return null; }).then(function (body) {
          throw new Error((body && body.error) || res.status + " " + res.statusText);
        });
      }
      return res.json();
    });
  }

  function postApi(path, init) {
    return fetch(path, { method: "POST", ...(init || {}) }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || "Request failed");
        return body;
      });
    });
  }

  function qs(params) {
    var search = new URLSearchParams();
    Object.keys(params).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
        search.set(key, params[key]);
      }
    });
    return search.toString();
  }

  function rememberInputSelection(event) {
    var input = event.target;
    inputRestore = {
      id: input.id,
      start: input.selectionStart,
      end: input.selectionEnd
    };
  }

  function restoreInputSelection(id) {
    if (!inputRestore || inputRestore.id !== id) return;
    var input = document.getElementById(id);
    if (!input) return;
    input.focus();
    if (typeof input.setSelectionRange === "function" && inputRestore.start !== null && inputRestore.end !== null) {
      var length = input.value.length;
      input.setSelectionRange(Math.min(inputRestore.start, length), Math.min(inputRestore.end, length));
    }
  }

  function branchHref(name) {
    return "/branches/" + String(name || "").split("/").map(encodeURIComponent).join("/");
  }

  function tagHref(name) {
    return "/tags/" + String(name || "").split("/").map(encodeURIComponent).join("/");
  }

  function relativeTime(unix) {
    if (!unix) return "-";
    var date = new Date(unix * 1000);
    return date.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function shortRelative(unix) {
    if (!unix) return "never";
    var seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
    if (seconds < 60) return seconds + "s ago";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days + "d ago";
    return relativeTime(unix);
  }

  function countBadge(label, value, tone) {
    return '<div class="badge ' + (tone ? "tone-" + tone : "") + '"><span class="badge-value">' + escape(value) + '</span><span class="badge-label">' + escape(label) + '</span></div>';
  }

  function prStateBadge(stateValue, draft) {
    var key = draft && stateValue === "open" ? "draft" : (stateValue || "closed");
    if (key !== "open" && key !== "merged" && key !== "draft") key = "closed";
    var label = key === "draft" ? "draft" : (stateValue || "closed");
    return '<span class="state state-' + key + '">' + escape(label) + '</span>';
  }

  function panel(title, action, body, extraClass) {
    return '<section class="panel ' + (extraClass || "") + '"><header class="panel-header"><h2>' + title + '</h2>' + (action || "") + '</header><div class="panel-body">' + body + '</div></section>';
  }

  function listRow(href, body) {
    return '<a class="list-row" href="' + attr(href) + '" data-link>' + body + '</a>';
  }

  function empty(text) {
    return '<div class="empty">' + text + '</div>';
  }

  function setLoading() {
    app.innerHTML = '<div class="skeleton" aria-label="Loading"></div>';
  }

  function setError(message) {
    app.innerHTML = '<div class="alert">Failed to load dashboard data: ' + escape(message) + '</div>';
  }

  function navigate(path) {
    if (path !== location.pathname + location.search) history.pushState(null, "", path);
    render();
  }

  function renderNav() {
    document.querySelectorAll("[data-nav]").forEach(function (nav) {
      nav.innerHTML = navLinks.map(function (item) {
        var active = item.href === "/" ? location.pathname === "/" : location.pathname === item.href || location.pathname.startsWith(item.href + "/");
        return '<a class="nav-link ' + (active ? "active" : "") + '" href="' + item.href + '" data-link>' + item.label + '</a>';
      }).join("");
    });
  }

  function renderSearch() {
    searchRoot.innerHTML =
      '<form role="search" id="search-form">' +
        '<label class="search-label">' +
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="subtle" aria-hidden="true"><path d="M11.5 7a4.499 4.499 0 1 1-8.998 0A4.499 4.499 0 0 1 11.5 7Zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04Z"/></svg>' +
          '<input id="search-input" class="search-input" type="search" spellcheck="false" autocomplete="off" placeholder="Search branches, tags, commits (sha or message), PRs (#123 or title)..." value="' + attr(state.searchValue) + '">' +
          '<kbd class="kbd">/</kbd>' +
        '</label>' +
      '</form><div id="search-menu-root"></div>';
    var input = document.getElementById("search-input");
    input.addEventListener("input", function (event) {
      state.searchValue = event.target.value;
      state.searchOpen = true;
      state.searchResults = null;
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(loadSearchPreview, 150);
      renderSearchMenu();
    });
    input.addEventListener("focus", function () {
      state.searchOpen = true;
      renderSearchMenu();
    });
    document.getElementById("search-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var q = state.searchValue.trim();
      if (q) {
        state.searchOpen = false;
        navigate("/search?q=" + encodeURIComponent(q));
      }
    });
    renderSearchMenu();
  }

  function renderSearchMenu() {
    var menuRoot = document.getElementById("search-menu-root");
    if (!menuRoot) return;
    if (!state.searchOpen || !state.searchValue.trim()) {
      menuRoot.innerHTML = "";
      return;
    }
    menuRoot.innerHTML = !state.searchResults
      ? '<div class="search-menu"><div class="empty">Searching...</div></div>'
      : '<div class="search-menu">' + searchPreview(state.searchResults) + '</div>';
  }

  function loadSearchPreview() {
    var q = state.searchValue.trim();
    if (!q) {
      state.searchResults = null;
      renderSearchMenu();
      return;
    }
    api("/api/search?" + qs({ q: q, limit: 10 })).then(function (data) {
      if (state.searchValue.trim() === q) {
        state.searchResults = data;
        renderSearchMenu();
      }
    }).catch(function () {
      if (state.searchValue.trim() === q) {
        state.searchResults = { query: q, branches: [], tags: [], commits: [], prs: [] };
        renderSearchMenu();
      }
    });
  }

  function searchPreview(data) {
    var count = data.branches.length + data.tags.length + data.commits.length + data.prs.length;
    if (count === 0) return '<div class="empty">No results for "' + escape(data.query) + '".</div>';
    return [
      previewSection("Branches", data.branches, function (b) {
        return resultLink(branchHref(b.name), '<div class="row-meta"><span class="mono truncate">' + escape(b.name) + (b.isDefault ? ' <span class="pill pill-accent">default</span>' : '') + '</span><span>' + shortRelative(b.lastCommitAt) + '</span></div>');
      }),
      previewSection("Tags", data.tags, function (t) {
        return resultLink(tagHref(t.name), '<div class="row-meta"><span class="mono truncate">' + escape(t.name) + '</span><span>' + shortRelative(t.taggedAt) + '</span></div><div class="tiny subtle">target <span class="mono">' + escape(t.shortTargetSha) + '</span></div>');
      }),
      previewSection("Commits", data.commits, function (c) {
        return resultLink("/commits/" + encodeURIComponent(c.sha), '<div><span class="mono small muted">' + escape(c.shortSha) + '</span> <span class="text-sm">' + escape(c.summary || "(no message)") + '</span></div><div class="tiny subtle">' + escape(c.authorName || "?") + ' - ' + shortRelative(c.committedAt) + '</div>');
      }),
      previewSection("Pull requests", data.prs, function (p) {
        return resultLink("/prs/" + p.number, '<div>' + prStateBadge(p.state, p.draft) + ' <span class="mono tiny subtle">#' + p.number + '</span> <span class="text-sm">' + escape(p.title || "") + '</span></div><div class="tiny subtle">' + escape(p.author || "?") + ' - ' + shortRelative(p.mergedAt || p.closedAt || p.createdAt) + '</div>');
      }),
      '<a class="search-footer" href="/search?q=' + encodeURIComponent(data.query) + '" data-link><span>See all results for <span class="mono">' + escape(data.query) + '</span></span><kbd class="kbd">Enter</kbd></a>'
    ].join("");
  }

  function previewSection(title, rows, renderRow) {
    if (!rows.length) return "";
    return '<div><div class="search-section-title">' + title + ' - ' + rows.length + '</div>' + rows.map(renderRow).join("") + '</div>';
  }

  function resultLink(href, html) {
    return '<a class="search-result" href="' + attr(href) + '" data-link>' + html + '</a>';
  }

  function renderSync() {
    var sync = state.sync || {};
    var running = sync.status === "running";
    var label = running ? labelForPhase(sync.phase) : "Sync now";
    var hasAdminToken = !!localStorage.getItem(adminStorageKey);
    syncRoot.innerHTML =
      '<div class="last-sync"><div>Last synced</div><strong>' + shortRelative(sync.lastSyncAt) + '</strong></div>' +
      '<button class="btn" id="sync-button" ' + (running ? "disabled" : "") + '>' +
        '<svg class="' + (running ? "spin" : "") + '" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7 7 0 0 1 14.95 7.16a.75.75 0 1 1-1.49.178A5.501 5.501 0 0 0 8 2.5ZM1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834Z"/></svg>' +
        label +
      '</button>' +
      '<button class="btn" id="admin-button" title="Set manual sync token">' + (hasAdminToken ? "Token saved" : "Admin token") + '</button>' +
      (sync.status === "error" && sync.error ? '<button class="btn btn-danger" id="sync-error-button">Error</button>' : '') +
      (state.adminTokenOpen ? tokenPopover(hasAdminToken) : '') +
      (state.syncErrorOpen && sync.error ? '<div class="sync-error-popover">' + escape(sync.error) + '</div>' : '');
    document.getElementById("sync-button").addEventListener("click", function () {
      state.syncErrorOpen = false;
      var adminToken = getAdminToken();
      if (!adminToken) return;
      postApi("/api/sync", {
        headers: { "X-Dashboard-Admin-Token": adminToken }
      }).then(function (data) {
        state.sync = data;
        renderSync();
        renderBanner();
        pollSyncSoon();
      }).catch(function (error) {
        state.sync = { status: "error", error: error.message, lastSyncAt: sync.lastSyncAt };
        state.syncErrorOpen = true;
        renderSync();
      });
    });
    document.getElementById("admin-button").addEventListener("click", function () {
      state.adminTokenOpen = !state.adminTokenOpen;
      state.syncErrorOpen = false;
      renderSync();
      focusAdminInput();
    });
    bindTokenPopover();
    var errorButton = document.getElementById("sync-error-button");
    if (errorButton) {
      errorButton.addEventListener("click", function () {
        state.syncErrorOpen = !state.syncErrorOpen;
        renderSync();
      });
    }
  }

  function getAdminToken() {
    var token = localStorage.getItem(adminStorageKey) || "";
    if (token) return token;
    state.adminTokenOpen = true;
    renderSync();
    focusAdminInput();
    return "";
  }

  function tokenPopover(hasAdminToken) {
    return '<div class="token-popover" role="dialog" aria-label="Manual sync admin token">' +
      '<label>ADMIN_TOKEN<input id="admin-token-input" type="password" autocomplete="off" placeholder="' + (hasAdminToken ? "Token is saved; enter a new one to replace it" : "Paste the Worker ADMIN_TOKEN") + '"></label>' +
      '<div class="token-help">Saved only in this browser. It must match the Cloudflare Worker secret named ADMIN_TOKEN.</div>' +
      '<div class="token-actions">' +
        '<button class="btn" id="admin-token-clear" type="button">Clear</button>' +
        '<button class="btn" id="admin-token-cancel" type="button">Cancel</button>' +
        '<button class="btn" id="admin-token-save" type="button">Save token</button>' +
      '</div>' +
    '</div>';
  }

  function bindTokenPopover() {
    var input = document.getElementById("admin-token-input");
    if (!input) return;
    document.getElementById("admin-token-save").addEventListener("click", function () {
      var value = input.value.trim();
      if (!value) return;
      localStorage.setItem(adminStorageKey, value);
      state.adminTokenOpen = false;
      renderSync();
    });
    document.getElementById("admin-token-clear").addEventListener("click", function () {
      localStorage.removeItem(adminStorageKey);
      state.adminTokenOpen = false;
      renderSync();
    });
    document.getElementById("admin-token-cancel").addEventListener("click", function () {
      state.adminTokenOpen = false;
      renderSync();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        document.getElementById("admin-token-save").click();
      }
    });
  }

  function focusAdminInput() {
    setTimeout(function () {
      var input = document.getElementById("admin-token-input");
      if (input) input.focus();
    }, 0);
  }

  function renderBanner() {
    var sync = state.sync;
    if (!sync || sync.status !== "running") {
      bannerRoot.innerHTML = "";
      return;
    }
    bannerRoot.innerHTML = '<div class="sync-banner"><span class="pulse-dot"></span><strong>' + escape(sync.message || "Syncing...") + '</strong></div>';
  }

  function labelForPhase(phase) {
    var labels = { starting: "Starting...", repo: "Repo...", branches: "Branches...", tags: "Tags...", commits: "Commits...", prs: "PRs...", done: "Done..." };
    return labels[phase] || "Syncing...";
  }

  var syncTimer = null;
  function pollSyncSoon() {
    clearTimeout(syncTimer);
    var delay = state.sync && state.sync.status === "running" ? 1000 : 30000;
    syncTimer = setTimeout(loadSync, delay);
  }

  function loadSync() {
    api("/api/sync/status").then(function (data) {
      state.sync = data;
      renderSync();
      renderBanner();
      pollSyncSoon();
      if (data.status === "success") {
        if (location.pathname === "/") renderHome();
      }
    }).catch(function () {
      pollSyncSoon();
    });
  }

  function renderHome() {
    setLoading();
    api("/api/summary").then(function (data) {
      var emptyCache = data.branchCount === 0 && data.commitCount === 0 && data.prCount.total === 0;
      app.innerHTML =
        '<div class="page">' +
          (!data.tokenSet ? '<div class="warning"><strong>GITHUB_TOKEN not set.</strong> Set the Worker secret before syncing.</div>' : '') +
          (emptyCache ? '<div class="welcome"><h2>Welcome</h2><p class="muted text-sm" style="margin-top:8px">The cache is empty. Click <strong>Sync now</strong> in the top bar to refresh from GitHub.</p></div>' : '') +
          '<div class="card-grid">' +
            countBadge("branches", data.liveBranchCount, "accent") +
            countBadge("tags", data.liveTagCount) +
            countBadge("commits", Number(data.commitCount || 0).toLocaleString()) +
            countBadge("open PRs", data.prCount.open, "success") +
            countBadge("merged PRs", data.prCount.merged, "merged") +
          '</div>' +
          '<div class="panel-grid">' +
            homeBranchesPanel(data.recentBranches || []) +
            homeTagsPanel(data.recentTags || []) +
            homeCommitsPanel(data.recentCommits || []) +
            homePrsPanel(data.recentPrs || []) +
          '</div>' +
        '</div>';
    }).catch(function (error) { setError(error.message); });
  }

  function homeBranchesPanel(rows) {
    return panel("Recent branches", '<a class="panel-link" href="/branches" data-link>All branches -&gt;</a>', rows.length ? rows.map(function (b) {
      return listRow(branchHref(b.name), '<div class="truncate mono text-sm">' + escape(b.name) + (b.isDefault ? ' <span class="pill pill-accent">default</span>' : '') + '</div><div class="row-meta"><span>HEAD <span class="mono">' + escape(b.shortHeadSha) + '</span></span><span>' + relativeTime(b.lastCommitAt) + '</span></div>');
    }).join("") : empty("No branches yet - sync first."));
  }

  function homeTagsPanel(rows) {
    return panel("Recent tags", '<a class="panel-link" href="/tags" data-link>All tags -&gt;</a>', rows.length ? rows.map(function (t) {
      return listRow(tagHref(t.name), '<div class="truncate mono text-sm">' + escape(t.name) + '</div><div class="row-meta"><span>target <span class="mono">' + escape(t.shortTargetSha) + '</span></span><span>' + relativeTime(t.taggedAt) + '</span></div>');
    }).join("") : empty("No tags yet - sync first."));
  }

  function homeCommitsPanel(rows) {
    return panel("Recent commits", '<a class="panel-link" href="/commits" data-link>All commits -&gt;</a>', rows.length ? rows.map(function (c) {
      return listRow("/commits/" + encodeURIComponent(c.sha), '<div><span class="mono small muted">' + escape(c.shortSha) + '</span> <span class="text-sm">' + escape(c.summary || "(no message)") + '</span></div><div class="row-meta"><span class="truncate">' + escape(c.authorName || "?") + '</span><span>' + relativeTime(c.committedAt) + '</span></div>');
    }).join("") : empty("No commits indexed yet."));
  }

  function homePrsPanel(rows) {
    return panel("Recent PRs", '<a class="panel-link" href="/prs" data-link>All PRs -&gt;</a>', rows.length ? rows.map(function (p) {
      return listRow("/prs/" + p.number, '<div>' + prStateBadge(p.state, p.draft) + ' <span class="mono small subtle">#' + p.number + '</span> <span class="text-sm">' + escape(p.title || "") + '</span></div><div class="row-meta"><span>' + escape(p.author || "?") + '</span><span>' + relativeTime(p.mergedAt || p.closedAt || p.createdAt) + '</span></div>');
    }).join("") : empty("No PRs fetched yet."));
  }

  function renderBranches(opts) {
    opts = opts || {};
    if (!opts.keepContent) setLoading();
    api("/api/branches?" + qs({ sort: state.branch.sort, includeDeleted: state.branch.includeDeleted ? "1" : "0", limit: 500 })).then(function (data) {
      var filter = state.branch.filter.toLowerCase();
      var rows = (data.branches || []).filter(function (b) { return !filter || b.name.toLowerCase().indexOf(filter) !== -1; });
      app.innerHTML =
        '<div class="page">' +
          '<div class="header-row"><div><h1>Branches</h1><p class="subtle text-sm">' + data.total + ' total - showing ' + rows.length + '</p></div>' +
            '<div class="controls"><input id="branch-filter" class="input" placeholder="Filter..." value="' + attr(state.branch.filter) + '">' +
            '<select id="branch-sort" class="select"><option value="last_commit_at">Sort: latest activity</option><option value="name">Sort: name</option></select>' +
            '<label class="check"><input id="branch-deleted" type="checkbox" ' + (state.branch.includeDeleted ? "checked" : "") + '> Include deleted</label></div></div>' +
          table(["Branch", "HEAD", "Created", "Last commit"], rows.map(function (b) {
            return [
              '<a class="table-link mono" href="' + attr(branchHref(b.name)) + '" data-link>' + escape(b.name) + (b.isDefault ? ' <span class="pill pill-accent">default</span>' : '') + (b.deletedAt ? ' <span class="pill pill-danger">deleted</span>' : '') + '</a>',
              '<a class="table-link mono small" href="/commits/' + attr(b.headSha) + '" data-link>' + escape(b.shortHeadSha) + '</a>',
              '<span class="subtle">' + relativeTime(b.branchCreatedAt) + '</span>',
              '<span class="subtle">' + relativeTime(b.lastCommitAt) + '</span>'
            ];
          })) +
        '</div>';
      bindBranchControls();
      if (opts.restoreFocusId) restoreInputSelection(opts.restoreFocusId);
    }).catch(function (error) { setError(error.message); });
  }

  function bindBranchControls() {
    var filter = document.getElementById("branch-filter");
    var sort = document.getElementById("branch-sort");
    var deleted = document.getElementById("branch-deleted");
    sort.value = state.branch.sort;
    filter.addEventListener("input", function (event) {
      state.branch.filter = event.target.value;
      rememberInputSelection(event);
      renderBranches({ keepContent: true, restoreFocusId: "branch-filter" });
    });
    sort.addEventListener("change", function (event) { state.branch.sort = event.target.value; renderBranches(); });
    deleted.addEventListener("change", function (event) { state.branch.includeDeleted = event.target.checked; renderBranches(); });
  }

  function renderTags(opts) {
    opts = opts || {};
    if (!opts.keepContent) setLoading();
    api("/api/tags?" + qs({ sort: state.tag.sort, includeDeleted: state.tag.includeDeleted ? "1" : "0", limit: 500 })).then(function (data) {
      var filter = state.tag.filter.toLowerCase();
      var rows = (data.tags || []).filter(function (t) { return !filter || t.name.toLowerCase().indexOf(filter) !== -1; });
      app.innerHTML =
        '<div class="page">' +
          '<div class="header-row"><div><h1>Tags</h1><p class="subtle text-sm">' + data.total + ' total - showing ' + rows.length + '</p></div>' +
            '<div class="controls"><input id="tag-filter" class="input" placeholder="Filter..." value="' + attr(state.tag.filter) + '">' +
            '<select id="tag-sort" class="select"><option value="tagged_at">Sort: newest</option><option value="name">Sort: name</option></select>' +
            '<label class="check"><input id="tag-deleted" type="checkbox" ' + (state.tag.includeDeleted ? "checked" : "") + '> Include deleted</label></div></div>' +
          table(["Tag", "Target", "Tagger", "Tagged"], rows.map(function (t) {
            return [
              '<a class="table-link mono" href="' + attr(tagHref(t.name)) + '" data-link>' + escape(t.name) + (t.deletedAt ? ' <span class="pill pill-danger">deleted</span>' : '') + '</a>',
              '<a class="table-link mono small" href="/commits/' + attr(t.targetSha) + '" data-link>' + escape(t.shortTargetSha) + '</a>',
              '<span class="subtle">-</span>',
              '<span class="subtle">' + relativeTime(t.taggedAt) + '</span>'
            ];
          })) +
        '</div>';
      bindTagControls();
      if (opts.restoreFocusId) restoreInputSelection(opts.restoreFocusId);
    }).catch(function (error) { setError(error.message); });
  }

  function bindTagControls() {
    var filter = document.getElementById("tag-filter");
    var sort = document.getElementById("tag-sort");
    var deleted = document.getElementById("tag-deleted");
    sort.value = state.tag.sort;
    filter.addEventListener("input", function (event) {
      state.tag.filter = event.target.value;
      rememberInputSelection(event);
      renderTags({ keepContent: true, restoreFocusId: "tag-filter" });
    });
    sort.addEventListener("change", function (event) { state.tag.sort = event.target.value; renderTags(); });
    deleted.addEventListener("change", function (event) { state.tag.includeDeleted = event.target.checked; renderTags(); });
  }

  function renderCommits(opts) {
    opts = opts || {};
    if (!opts.keepContent) setLoading();
    var pageSize = 100;
    var offset = state.commits.page * pageSize;
    api("/api/commits?" + qs({ limit: pageSize, offset: offset })).then(function (data) {
      var filter = state.commits.filter.toLowerCase();
      var rows = (data.commits || []).filter(function (c) { return !filter || (c.sha + " " + (c.summary || "")).toLowerCase().indexOf(filter) !== -1; });
      var totalPages = Math.max(1, Math.ceil(data.total / pageSize));
      app.innerHTML =
        '<div class="page">' +
          '<div class="header-row"><div><h1>Commits</h1><p class="subtle text-sm">' + Number(data.total).toLocaleString() + ' indexed - page ' + (state.commits.page + 1) + ' of ' + totalPages + '</p></div>' +
          '<input id="commit-filter" class="input" placeholder="Filter this page (use top search for full)..." value="' + attr(state.commits.filter) + '"></div>' +
          table(["SHA", "Message", "Author", "Committed"], rows.map(function (c) {
            return [
              '<a class="table-link mono small" href="/commits/' + attr(c.sha) + '" data-link>' + escape(c.shortSha) + '</a>',
              '<a class="link truncate" href="/commits/' + attr(c.sha) + '" data-link>' + escape(c.summary || "(no message)") + '</a>',
              '<span class="muted">' + escape(c.authorName || "?") + '</span>',
              '<span class="subtle">' + relativeTime(c.committedAt) + '</span>'
            ];
          })) +
          pager(offset, pageSize, data.total, state.commits.page, totalPages, "commit") +
        '</div>';
      bindCommitControls(totalPages);
      if (opts.restoreFocusId) restoreInputSelection(opts.restoreFocusId);
    }).catch(function (error) { setError(error.message); });
  }

  function bindCommitControls(totalPages) {
    var filter = document.getElementById("commit-filter");
    filter.addEventListener("input", function (event) {
      state.commits.filter = event.target.value;
      rememberInputSelection(event);
      renderCommits({ keepContent: true, restoreFocusId: "commit-filter" });
    });
    bindPager("commit", function (delta) {
      state.commits.page = Math.max(0, Math.min(totalPages - 1, state.commits.page + delta));
      renderCommits();
    });
  }

  function renderPrs(opts) {
    opts = opts || {};
    if (!opts.keepContent) setLoading();
    var pageSize = 100;
    var offset = state.prs.page * pageSize;
    api("/api/prs?" + qs({ state: state.prs.state, limit: pageSize, offset: offset })).then(function (data) {
      var filter = state.prs.filter.toLowerCase();
      var rows = (data.prs || []).filter(function (p) { return !filter || (p.number + " " + (p.title || "") + " " + (p.author || "")).toLowerCase().indexOf(filter) !== -1; });
      var totalPages = Math.max(1, Math.ceil(data.total / pageSize));
      app.innerHTML =
        '<div class="page">' +
          '<div class="header-row"><div><h1>Pull requests</h1><p class="subtle text-sm">' + Number(data.total).toLocaleString() + ' ' + (state.prs.state === "all" ? "" : state.prs.state) + ' - page ' + (state.prs.page + 1) + ' of ' + totalPages + '</p></div>' +
          '<div class="controls"><input id="pr-filter" class="input" placeholder="Filter this page (use top search for full)..." value="' + attr(state.prs.filter) + '">' + stateButtons() + '</div></div>' +
          '<div class="panel"><div class="panel-body">' + (rows.length ? '<ul style="list-style:none;margin:0;padding:0">' + rows.map(prListItem).join("") + '</ul>' : empty("No PRs to show.")) + '</div></div>' +
          pager(offset, pageSize, data.total, state.prs.page, totalPages, "pr") +
        '</div>';
      bindPrControls(totalPages);
      if (opts.restoreFocusId) restoreInputSelection(opts.restoreFocusId);
    }).catch(function (error) { setError(error.message); });
  }

  function stateButtons() {
    return '<div class="button-group">' + ["all", "open", "merged", "closed"].map(function (s) {
      return '<button class="segment ' + (state.prs.state === s ? "active" : "") + '" data-pr-state="' + s + '">' + s + '</button>';
    }).join("") + '</div>';
  }

  function prListItem(p) {
    return '<li class="pr-row"><a class="list-row" href="/prs/' + p.number + '" data-link><div>' + prStateBadge(p.state, p.draft) + ' <span class="mono small subtle">#' + p.number + '</span> <span class="text-sm">' + escape(p.title || "") + '</span></div><div class="row-meta"><span>by ' + escape(p.author || "?") + '</span><span><span class="mono">' + escape(p.headRef || "?") + '</span> -&gt; <span class="mono">' + escape(p.baseRef || "?") + '</span></span><span>' + shortRelative(p.mergedAt || p.closedAt || p.createdAt) + '</span></div></a></li>';
  }

  function bindPrControls(totalPages) {
    var filter = document.getElementById("pr-filter");
    filter.addEventListener("input", function (event) {
      state.prs.filter = event.target.value;
      rememberInputSelection(event);
      renderPrs({ keepContent: true, restoreFocusId: "pr-filter" });
    });
    document.querySelectorAll("[data-pr-state]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.prs.state = button.getAttribute("data-pr-state");
        state.prs.page = 0;
        renderPrs();
      });
    });
    bindPager("pr", function (delta) {
      state.prs.page = Math.max(0, Math.min(totalPages - 1, state.prs.page + delta));
      renderPrs();
    });
  }

  function renderSearchPage() {
    var query = new URLSearchParams(location.search).get("q") || "";
    if (!query.trim()) {
      app.innerHTML = '<div class="page"><h1>Search</h1><div class="panel"><div class="empty">Type a query in the search bar above and press Enter to see every match across branches, tags, commits, and PRs.</div></div></div>';
      return;
    }
    setLoading();
    api("/api/search?" + qs({ q: query.trim(), limit: 500 })).then(function (data) {
      var counts = { branches: data.branches.length, tags: data.tags.length, commits: data.commits.length, prs: data.prs.length };
      var total = counts.branches + counts.tags + counts.commits + counts.prs;
      app.innerHTML =
        '<div class="page"><div><h1>Search results for <span class="mono" style="color:var(--accent)">' + escape(query) + '</span></h1><p class="subtle text-sm">' + total.toLocaleString() + ' ' + (total === 1 ? "result" : "results") + '</p></div>' +
        '<div class="card-grid">' + countBadge("branches", counts.branches, "accent") + countBadge("tags", counts.tags) + countBadge("commits", counts.commits) + countBadge("PRs", counts.prs, "success") + '</div>' +
        '<div class="panel-grid">' +
          searchPanel("Branches", data.branches, function (b) { return listRow(branchHref(b.name), '<div class="row-meta"><span class="mono truncate">' + escape(b.name) + '</span><span>' + relativeTime(b.lastCommitAt) + '</span></div><div class="tiny subtle">HEAD <span class="mono">' + escape(b.shortHeadSha) + '</span></div>'); }) +
          searchPanel("Tags", data.tags, function (t) { return listRow(tagHref(t.name), '<div class="row-meta"><span class="mono truncate">' + escape(t.name) + '</span><span>' + relativeTime(t.taggedAt) + '</span></div><div class="tiny subtle">target <span class="mono">' + escape(t.shortTargetSha) + '</span></div>'); }) +
          searchPanel("Commits", data.commits, function (c) { return listRow("/commits/" + encodeURIComponent(c.sha), '<div><span class="mono small muted">' + escape(c.shortSha) + '</span> <span>' + escape(c.summary || "(no message)") + '</span></div><div class="tiny subtle">' + escape(c.authorName || "?") + ' - ' + relativeTime(c.committedAt) + '</div>'); }) +
          searchPanel("Pull requests", data.prs, function (p) { return listRow("/prs/" + p.number, '<div>' + prStateBadge(p.state, p.draft) + ' <span class="mono small subtle">#' + p.number + '</span> <span>' + escape(p.title || "") + '</span></div><div class="tiny subtle">' + escape(p.author || "?") + ' - ' + relativeTime(p.mergedAt || p.closedAt || p.createdAt) + '</div>'); }) +
        '</div></div>';
    }).catch(function (error) { setError(error.message); });
  }

  function searchPanel(title, rows, renderRow) {
    return panel(title, '<span class="panel-link">' + rows.length + '</span>', rows.length ? rows.map(renderRow).join("") : empty("No matching " + title.toLowerCase() + "."), "search-result-panel");
  }

  function renderBranchDetail(name, opts) {
    opts = opts || {};
    if (!opts.keepContent) setLoading();
    if (state.branchDetail.name !== name) {
      state.branchDetail = { name: name, commitsPage: 0, commitsFilter: "", prsFromPage: 0, prsFromFilter: "", prsToPage: 0, prsToFilter: "" };
    }
    var encoded = name.split("/").map(encodeURIComponent).join("/");
    var pageSize = 100;
    var commitsOffset = state.branchDetail.commitsPage * pageSize;
    var prsFromOffset = state.branchDetail.prsFromPage * pageSize;
    var prsToOffset = state.branchDetail.prsToPage * pageSize;
    Promise.all([
      api("/api/branches/" + encoded),
      api("/api/branch-commits/" + encoded + "?" + qs({ limit: pageSize, offset: commitsOffset, q: state.branchDetail.commitsFilter.trim() })),
      api("/api/branch-prs/" + encoded + "?" + qs({ direction: "from", limit: pageSize, offset: prsFromOffset, q: state.branchDetail.prsFromFilter.trim() })),
      api("/api/branch-prs/" + encoded + "?" + qs({ direction: "to", limit: pageSize, offset: prsToOffset, q: state.branchDetail.prsToFilter.trim() }))
    ]).then(function (results) {
      var data = results[0];
      var commitsPage = results[1];
      var prsFromPage = results[2];
      var prsToPage = results[3];
      var b = data.branch;
      app.innerHTML =
        '<div class="page">' +
          '<div><div class="crumb small subtle"><a href="/branches" data-link>Branches</a> /</div>' +
          '<h1 class="mono break"><a class="link" href="https://github.com/' + attr(config.repo) + '/tree/' + attr(b.name) + '" target="_blank" rel="noopener noreferrer">' + escape(b.name) + '</a> ' + (b.isDefault ? '<span class="pill pill-accent">default</span>' : '') + (b.deletedAt ? '<span class="pill pill-danger">deleted</span>' : '') + '</h1></div>' +
          '<div class="stat-grid">' +
            stat("HEAD", '<a class="table-link mono" href="/commits/' + attr(b.headSha) + '" data-link>' + escape(b.shortHeadSha) + '</a>') +
            stat("Last activity", '<span class="muted">' + relativeTime(b.lastCommitAt) + '</span>') +
            stat("Default branch", '<span class="muted mono">' + escape(data.defaultBranch || "-") + '</span>') +
          '</div>' +
          '<div class="two-grid">' +
            branchCommitsPanel(commitsPage, data.totalCommits, commitsOffset, pageSize) +
            '<div class="panel-stack">' +
              branchPrsPanel("PRs from this branch", "from", prsFromPage, prsFromOffset, pageSize, "No PRs were opened from this branch.") +
              branchPrsPanel("PRs into this branch", "to", prsToPage, prsToOffset, pageSize, "No PRs targeted this branch.") +
            '</div>' +
          '</div>' +
        '</div>';
      bindBranchDetailControls(name, commitsPage, prsFromPage, prsToPage, pageSize, opts.restoreFocusId);
    }).catch(function (error) { setError(error.message); });
  }

  function branchCommitsPanel(data, totalCommits, offset, pageSize) {
    var filter = state.branchDetail.commitsFilter.trim();
    var title = filter
      ? "Commits (" + Number(data.total || 0).toLocaleString() + " matching - " + Number(totalCommits || 0).toLocaleString() + " total)"
      : "Commits (" + Number(totalCommits || data.total || 0).toLocaleString() + ")";
    var totalPages = Math.max(1, Math.ceil((data.total || 0) / pageSize));
    var body = data.commits && data.commits.length
      ? '<div class="list-scroll">' + data.commits.map(function (c) {
          return listRow("/commits/" + c.sha, '<div><span class="mono small muted">' + escape(c.shortSha) + '</span> <span class="text-sm">' + escape(c.summary || "(no message)") + '</span></div><div class="row-meta"><span class="truncate">' + escape(c.authorName || "?") + '</span><span>' + relativeTime(c.committedAt) + '</span></div>');
        }).join("") + '</div>'
      : empty(filter ? "No commits on this branch match your filter." : "No commits found on this ref.");
    return panel(
      title,
      '<input id="branch-commit-filter" class="input input-sm" placeholder="Search sha, summary, author..." value="' + attr(state.branchDetail.commitsFilter) + '">',
      body + pager(offset, pageSize, data.total || 0, state.branchDetail.commitsPage, totalPages, "branch-commit")
    );
  }

  function branchPrsPanel(title, direction, data, offset, pageSize, emptyText) {
    var filterKey = direction === "from" ? "prsFromFilter" : "prsToFilter";
    var pageKey = direction === "from" ? "prsFromPage" : "prsToPage";
    var pagerKey = direction === "from" ? "branch-pr-from" : "branch-pr-to";
    var inputId = direction === "from" ? "branch-pr-from-filter" : "branch-pr-to-filter";
    var filter = state.branchDetail[filterKey].trim();
    var totalPages = Math.max(1, Math.ceil((data.total || 0) / pageSize));
    var heading = title + " (" + Number(data.total || 0).toLocaleString() + (filter ? " matching" : "") + ")";
    var body = data.prs && data.prs.length
      ? '<ul class="list-scroll pr-list">' + data.prs.map(prListItem).join("") + '</ul>'
      : empty(filter ? "No PRs match your filter." : emptyText);
    return panel(
      heading,
      '<input id="' + inputId + '" class="input input-sm" placeholder="Search PRs..." value="' + attr(state.branchDetail[filterKey]) + '">',
      body + pager(offset, pageSize, data.total || 0, state.branchDetail[pageKey], totalPages, pagerKey)
    );
  }

  function bindBranchDetailControls(name, commitsPage, prsFromPage, prsToPage, pageSize, restoreFocusId) {
    var commitFilter = document.getElementById("branch-commit-filter");
    var prFromFilter = document.getElementById("branch-pr-from-filter");
    var prToFilter = document.getElementById("branch-pr-to-filter");
    if (commitFilter) {
      commitFilter.addEventListener("input", function (event) {
        state.branchDetail.commitsFilter = event.target.value;
        state.branchDetail.commitsPage = 0;
        rememberInputSelection(event);
        renderBranchDetail(name, { keepContent: true, restoreFocusId: "branch-commit-filter" });
      });
    }
    if (prFromFilter) {
      prFromFilter.addEventListener("input", function (event) {
        state.branchDetail.prsFromFilter = event.target.value;
        state.branchDetail.prsFromPage = 0;
        rememberInputSelection(event);
        renderBranchDetail(name, { keepContent: true, restoreFocusId: "branch-pr-from-filter" });
      });
    }
    if (prToFilter) {
      prToFilter.addEventListener("input", function (event) {
        state.branchDetail.prsToFilter = event.target.value;
        state.branchDetail.prsToPage = 0;
        rememberInputSelection(event);
        renderBranchDetail(name, { keepContent: true, restoreFocusId: "branch-pr-to-filter" });
      });
    }
    bindPager("branch-commit", function (delta) {
      state.branchDetail.commitsPage = Math.max(0, Math.min(Math.ceil((commitsPage.total || 0) / pageSize) - 1, state.branchDetail.commitsPage + delta));
      renderBranchDetail(name);
    });
    bindPager("branch-pr-from", function (delta) {
      state.branchDetail.prsFromPage = Math.max(0, Math.min(Math.ceil((prsFromPage.total || 0) / pageSize) - 1, state.branchDetail.prsFromPage + delta));
      renderBranchDetail(name);
    });
    bindPager("branch-pr-to", function (delta) {
      state.branchDetail.prsToPage = Math.max(0, Math.min(Math.ceil((prsToPage.total || 0) / pageSize) - 1, state.branchDetail.prsToPage + delta));
      renderBranchDetail(name);
    });
    if (restoreFocusId) restoreInputSelection(restoreFocusId);
  }

  function renderTagDetail(name) {
    setLoading();
    api("/api/tags/" + name.split("/").map(encodeURIComponent).join("/")).then(function (data) {
      var t = data.tag;
      app.innerHTML =
        '<div class="page"><div><div class="crumb small subtle"><a href="/tags" data-link>Tags</a> /</div><h1 class="mono break"><a class="link" href="https://github.com/' + attr(config.repo) + '/releases/tag/' + attr(t.name) + '" target="_blank" rel="noopener noreferrer">' + escape(t.name) + '</a> ' + (t.deletedAt ? '<span class="pill pill-danger">deleted</span>' : '') + '</h1></div>' +
        '<div class="stat-grid">' + stat("Target", '<a class="table-link mono" href="/commits/' + attr(t.targetSha) + '" data-link>' + escape(t.shortTargetSha) + '</a>') + stat("Tagged", '<span class="muted">' + relativeTime(t.taggedAt) + '</span>') + stat("Annotated", t.isAnnotated ? "yes" : "no") + '</div>' +
        (t.message ? panel("Tag message", "", '<pre class="message">' + escape(t.message) + '</pre>') : '') +
        (data.target ? panel("Target commit", '<a class="panel-link" href="/commits/' + attr(data.target.sha) + '" data-link>Commit details -&gt;</a>', listRow("/commits/" + data.target.sha, '<span class="mono small muted">' + escape(data.target.shortSha) + '</span> ' + escape(data.target.summary || "(no message)") + '<div class="tiny subtle">' + escape(data.target.authorName || "?") + ' - ' + relativeTime(data.target.committedAt) + '</div>')) : '') +
        '</div>';
    }).catch(function (error) { setError(error.message); });
  }

  function renderCommitDetail(sha) {
    setLoading();
    api("/api/commits/" + encodeURIComponent(sha)).then(function (data) {
      var c = data.commit;
      var message = data.message || c.summary || "";
      var body = message.indexOf("\\n") >= 0 ? message.slice(message.indexOf("\\n") + 1).trim() : "";
      app.innerHTML =
        '<div class="page"><div><div class="crumb small subtle"><a href="/commits" data-link>Commits</a> /</div><h1 class="break"><a class="link" href="' + attr(c.url || ("https://github.com/" + config.repo + "/commit/" + c.sha)) + '" target="_blank" rel="noopener noreferrer">' + escape(c.summary || "(no message)") + '</a></h1></div>' +
        (body ? '<pre class="message">' + escape(body) + '</pre>' : '') +
        '<div class="stat-grid">' + stat("SHA", '<span class="mono small muted break">' + escape(c.sha) + '</span>') + stat("Author", '<span class="muted">' + escape(c.authorName || "?") + (c.authorEmail ? ' <span class="subtle">&lt;' + escape(c.authorEmail) + '&gt;</span>' : '') + '</span>') + stat("Committed", '<span class="muted">' + relativeTime(c.committedAt) + '</span>') + '</div>' +
        '<div class="two-grid">' +
          panel("Branches pointing at this commit (" + data.branches.length + ")", "", data.branches.length ? data.branches.map(function (b) { return listRow(branchHref(b.name), '<span class="mono muted">' + escape(b.name) + '</span>'); }).join("") : empty("No cached branch heads point at this commit.")) +
          panel("Pull requests touching this commit (" + data.prs.length + ")", "", data.prs.length ? data.prs.map(prListItem).join("") : empty("No PRs reference this commit in the Worker cache.")) +
        '</div></div>';
    }).catch(function (error) { setError(error.message); });
  }

  function renderPrDetail(number) {
    setLoading();
    api("/api/prs/" + encodeURIComponent(number)).then(function (data) {
      var p = data.pr;
      app.innerHTML =
        '<div class="page"><div><div class="crumb small subtle"><a href="/prs" data-link>Pull requests</a> /</div><h1><a class="link" href="' + attr(p.url || ("https://github.com/" + config.repo + "/pull/" + p.number)) + '" target="_blank" rel="noopener noreferrer"><span class="mono subtle">#' + p.number + '</span> ' + escape(p.title || "") + '</a> ' + prStateBadge(p.state, p.draft) + '</h1><p class="subtle text-sm" style="margin-top:8px">by ' + escape(p.author || "?") + ' - <a class="table-link mono" href="' + attr(branchHref(p.headRef || "")) + '" data-link>' + escape(p.headRef || "?") + '</a> -&gt; <a class="table-link mono" href="' + attr(branchHref(p.baseRef || "")) + '" data-link>' + escape(p.baseRef || "?") + '</a></p></div>' +
        '<div class="stat-grid">' + stat("Opened", relativeTime(p.createdAt)) + stat(p.mergedAt ? "Merged" : "Closed", relativeTime(p.mergedAt || p.closedAt)) + stat("Last updated", relativeTime(p.updatedAt)) + '</div>' +
        (p.mergeCommitSha ? '<p class="tiny subtle">Merge commit: <a class="table-link mono" href="/commits/' + attr(p.mergeCommitSha) + '" data-link>' + escape(p.mergeCommitSha.slice(0, 7)) + '</a></p>' : '') +
        (p.body ? '<pre class="message">' + escape(p.body) + '</pre>' : '') +
        panel("Cached commits (" + data.commits.length + ")", "", data.commits.length ? data.commits.map(function (c) { return listRow("/commits/" + c.sha, '<span class="mono small muted">' + escape(c.shortSha) + '</span> ' + escape(c.summary || "(no message)") + '<div class="tiny subtle">' + escape(c.authorName || "?") + ' - ' + relativeTime(c.committedAt) + '</div>'); }).join("") : empty("No commits cached for this PR yet.")) +
        '</div>';
    }).catch(function (error) { setError(error.message); });
  }

  function stat(label, value) {
    return '<div class="stat"><div class="stat-label">' + escape(label) + '</div><div class="stat-value">' + value + '</div></div>';
  }

  function table(headers, rows) {
    if (!rows.length) return '<div class="panel">' + empty("No rows to show.") + '</div>';
    return '<div class="table-wrap"><table><thead><tr>' + headers.map(function (h) { return '<th>' + escape(h) + '</th>'; }).join("") + '</tr></thead><tbody>' + rows.map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table></div>';
  }

  function pager(offset, pageSize, total, page, totalPages, key) {
    return '<div class="pager"><button class="btn" data-pager="' + key + '-prev" ' + (page === 0 ? "disabled" : "") + '>&lt;- Previous</button><span class="tiny subtle">Showing ' + (total ? offset + 1 : 0) + '-' + Math.min(offset + pageSize, total) + ' of ' + Number(total || 0).toLocaleString() + '</span><button class="btn" data-pager="' + key + '-next" ' + (page + 1 >= totalPages ? "disabled" : "") + '>Next -&gt;</button></div>';
  }

  function bindPager(key, onMove) {
    var prev = document.querySelector('[data-pager="' + key + '-prev"]');
    var next = document.querySelector('[data-pager="' + key + '-next"]');
    if (prev) prev.addEventListener("click", function () { onMove(-1); });
    if (next) next.addEventListener("click", function () { onMove(1); });
  }

  function render() {
    state.searchOpen = false;
    renderNav();
    renderSearch();
    var path = location.pathname;
    if (path === "/") return renderHome();
    if (path === "/branches") return renderBranches();
    if (path.indexOf("/branches/") === 0) return renderBranchDetail(decodePath(path.slice("/branches/".length)));
    if (path === "/tags") return renderTags();
    if (path.indexOf("/tags/") === 0) return renderTagDetail(decodePath(path.slice("/tags/".length)));
    if (path === "/commits") return renderCommits();
    if (path.indexOf("/commits/") === 0) return renderCommitDetail(decodeURIComponent(path.slice("/commits/".length)));
    if (path === "/prs") return renderPrs();
    if (path.indexOf("/prs/") === 0) return renderPrDetail(path.slice("/prs/".length));
    if (path === "/search") return renderSearchPage();
    app.innerHTML = '<div class="alert">Page not found.</div>';
  }

  function decodePath(value) {
    return value.split("/").map(decodeURIComponent).join("/");
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest("a[data-link]");
    if (!link) return;
    var url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });

  document.addEventListener("mousedown", function (event) {
    if (!searchRoot.contains(event.target)) {
      state.searchOpen = false;
      renderSearchMenu();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      state.searchOpen = false;
      renderSearchMenu();
    }
    if (event.key === "/" && document.activeElement && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      event.preventDefault();
      var input = document.getElementById("search-input");
      if (input) input.focus();
    }
  });

  window.addEventListener("popstate", render);
  renderNav();
  renderSearch();
  renderSync();
  loadSync();
  render();
})();
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJs(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/</g, "\\u003c");
}
