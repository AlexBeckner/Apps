export function dataspeedHashFinderHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>dataspeedhashfinder</title>
    <style>
      * { box-sizing: border-box; }
      body {
        background: #111;
        color: #eee;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 14px;
        margin: 8px;
      }
      main { max-width: 900px; }
      .search-grid, .hash-row {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) 48px minmax(0, 1fr);
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 4px;
      }
      .sr-only {
        height: 1px;
        left: -10000px;
        overflow: hidden;
        position: absolute;
        top: auto;
        width: 1px;
      }
      input {
        background: #111;
        border: 1px solid #666;
        color: #eee;
        font: inherit;
        padding: 4px 6px;
        width: 100%;
      }
      input::placeholder { color: #888; }
      button {
        background: #2a2a2a;
        border: 1px solid #666;
        color: #eee;
        cursor: pointer;
        font: inherit;
        padding: 4px 8px;
      }
      .rows {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }
      .module-name {
        font-weight: 700;
        grid-column: 1 / -1;
      }
      .hash-cell {
        min-height: 64px;
        padding: 4px 0;
      }
      .hash-line {
        align-items: center;
        display: flex;
        gap: 8px;
      }
      .hash {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        font-size: 20px;
        font-weight: 700;
      }
      .download-button {
        align-items: center;
        display: inline-flex;
        height: 28px;
        justify-content: center;
        padding: 0;
        width: 28px;
      }
      .download-button svg {
        height: 16px;
        width: 16px;
      }
      .match-cell {
        align-items: center;
        display: flex;
        font-size: 28px;
        font-weight: 700;
        justify-content: center;
        min-height: 64px;
      }
      .match { color: #25d366; }
      .mismatch { color: #ff4d4d; }
      .placeholder { color: #aaa; }
      .error { color: #ff4d4d; overflow-wrap: anywhere; }
      .status-section { margin-top: 8px; }
      @media (max-width: 700px) {
        .search-grid, .hash-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="search-grid" aria-label="Branch inputs">
        <div>
          <label class="sr-only" for="left-ref">Left branch</label>
          <input id="left-ref" autocomplete="off" list="branch-suggestions" placeholder="master" value="master">
        </div>
        <div></div>
        <div>
          <label class="sr-only" for="right-ref">Right branch</label>
          <input id="right-ref" autocomplete="off" list="branch-suggestions" placeholder="branch, tag, or commit SHA">
        </div>
      </section>
      <section id="rows" class="rows" aria-label="Dataspeed module hashes"></section>
      <section class="status-section" aria-live="polite">
        <p id="backend-status"></p>
      </section>
      <datalist id="branch-suggestions"></datalist>
    </main>
    <script>
      const files = [
        { module: "Gateway", fileName: "FORD_GE1 Gateway.json" },
        { module: "Shift", fileName: "FORD_GE1 Shift.json" },
        { module: "Throttle", fileName: "FORD_GE1 Throttle.json" }
      ];
      const columns = {
        left: {
          input: document.querySelector("#left-ref"),
          files: new Map(),
          errors: new Map(),
          requestId: 0
        },
        right: {
          input: document.querySelector("#right-ref"),
          files: new Map(),
          errors: new Map(),
          requestId: 0
        }
      };
      const rowsEl = document.querySelector("#rows");
      const branchSuggestions = document.querySelector("#branch-suggestions");
      const backendStatus = document.querySelector("#backend-status");
      let branchSuggestionRequestId = 0;

      backendStatus.textContent =
        "Using protected Worker backend: " + window.location.origin;
      renderRows();

      function normalizeRef(input) {
        const trimmed = input.trim();
        const treeMarker = "/tree/";
        const treeIndex = trimmed.indexOf(treeMarker);
        if (treeIndex !== -1) {
          const treeRef = trimmed.slice(treeIndex + treeMarker.length);
          return decodeURIComponent(treeRef.split(/[?#]/)[0]);
        }
        return trimmed.replace(/^origin\\//, "");
      }

      function apiUrl(path, params) {
        const url = new URL(path, window.location.href);
        Object.entries(params).forEach(function ([key, value]) {
          url.searchParams.set(key, value);
        });
        return url.toString();
      }

      async function fetchProxyJson(path, params) {
        const response = await fetch(apiUrl(path, params), { cache: "no-store" });
        const responseText = await response.text();
        let data;
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }
        if (!response.ok) {
          throw new Error(
            data.error ||
              response.status + " " + response.statusText + ": " + responseText
          );
        }
        return data;
      }

      function downloadText(fileName, text) {
        const blob = new Blob([text], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      function downloadFileName(parameterFile) {
        return parameterFile.fileName.replace(
          /\\.json$/i,
          " " + parameterFile.hash + ".json"
        );
      }

      async function fetchParameterFile(ref, file) {
        const parameterFile = await fetchProxyJson("parameter-file", {
          ref,
          file: file.fileName
        });
        return {
          module: parameterFile.module || file.module,
          fileName: parameterFile.fileName || file.fileName,
          hash: parameterFile.hash,
          text: parameterFile.text
        };
      }

      function renderRows() {
        rowsEl.innerHTML = "";
        files.forEach(function (file) {
          const row = document.createElement("div");
          row.className = "hash-row";

          const module = document.createElement("div");
          module.className = "module-name";
          module.textContent = file.module;

          row.append(
            module,
            renderCell(columns.left, file.module),
            renderMatchCell(file.module),
            renderCell(columns.right, file.module)
          );
          rowsEl.appendChild(row);
        });
      }

      function renderMatchCell(module) {
        const cell = document.createElement("div");
        cell.className = "match-cell";
        const leftFile = columns.left.files.get(module);
        const rightFile = columns.right.files.get(module);
        if (!leftFile || !rightFile) return cell;

        const marker = document.createElement("span");
        marker.className = leftFile.hash === rightFile.hash ? "match" : "mismatch";
        marker.textContent = leftFile.hash === rightFile.hash ? "=" : "X";
        cell.appendChild(marker);
        return cell;
      }

      function renderCell(column, module) {
        const cell = document.createElement("article");
        cell.className = "hash-cell";
        const parameterFile = column.files.get(module);
        const error = column.errors.get(module);

        if (parameterFile) {
          const hashLine = document.createElement("div");
          hashLine.className = "hash-line";
          const hash = document.createElement("div");
          hash.className = "hash";
          hash.textContent = parameterFile.hash;
          const downloadButton = document.createElement("button");
          downloadButton.className = "download-button";
          downloadButton.type = "button";
          downloadButton.title = "Download " + parameterFile.fileName;
          downloadButton.setAttribute(
            "aria-label",
            "Download " + parameterFile.fileName
          );
          downloadButton.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v9l3-3 1.4 1.4L12 16.8l-5.4-5.4L8 10l3 3V4z" fill="currentColor"></path><path d="M5 19h14v2H5v-2z" fill="currentColor"></path></svg>';
          downloadButton.addEventListener("click", function () {
            downloadText(downloadFileName(parameterFile), parameterFile.text);
          });
          hashLine.append(hash, downloadButton);
          cell.appendChild(hashLine);
        } else if (error) {
          const message = document.createElement("p");
          message.className = "error";
          message.textContent = error;
          cell.appendChild(message);
        } else {
          const placeholder = document.createElement("p");
          placeholder.className = "placeholder";
          placeholder.textContent = normalizeRef(column.input.value)
            ? "Loading..."
            : "Enter a branch";
          cell.appendChild(placeholder);
        }
        return cell;
      }

      async function fetchAllFiles(ref) {
        const results = await Promise.allSettled(
          files.map(function (file) {
            return fetchParameterFile(ref, file);
          })
        );
        return results.map(function (result, index) {
          return { file: files[index], result };
        });
      }

      async function updateBranchSuggestions(input) {
        try {
          const requestId = branchSuggestionRequestId + 1;
          branchSuggestionRequestId = requestId;
          const prefix = normalizeRef(input.value);
          if (!prefix || prefix.length < 2) {
            branchSuggestions.innerHTML = "";
            return;
          }
          const data = await fetchProxyJson("branch-suggestions", { prefix });
          if (requestId !== branchSuggestionRequestId) return;

          branchSuggestions.innerHTML = "";
          (data.suggestions || []).forEach(function (suggestion) {
            const option = document.createElement("option");
            option.value = suggestion;
            branchSuggestions.appendChild(option);
          });
        } catch {
          branchSuggestions.innerHTML = "";
        }
      }

      async function loadColumn(columnName) {
        const column = columns[columnName];
        const ref = normalizeRef(column.input.value);
        const requestId = column.requestId + 1;
        column.requestId = requestId;
        column.files.clear();
        column.errors.clear();
        renderRows();
        if (!ref) return;

        const results = await fetchAllFiles(ref);
        if (requestId !== column.requestId) return;
        results.forEach(function ({ file, result }) {
          if (result.status === "fulfilled") {
            column.files.set(result.value.module, result.value);
          } else {
            column.errors.set(file.module, result.reason.message);
          }
        });
        renderRows();
      }

      function debounce(callback, waitMs) {
        let timeoutId;
        return function () {
          window.clearTimeout(timeoutId);
          timeoutId = window.setTimeout(callback, waitMs);
        };
      }

      columns.left.input.addEventListener(
        "input",
        debounce(function () {
          updateBranchSuggestions(columns.left.input);
          loadColumn("left");
        }, 400)
      );
      columns.right.input.addEventListener(
        "input",
        debounce(function () {
          updateBranchSuggestions(columns.right.input);
          loadColumn("right");
        }, 400)
      );
      loadColumn("left");
    </script>
  </body>
</html>`;
}
