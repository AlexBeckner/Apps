import { requireCloudflareAccess } from "./access.js";

const OWNER = "AppliedNeuron";
const REPO = "core-stack";
const PARAMETER_DIRECTORY =
  "onroad/controls/dbw/dataspeed_v2/parameters";
const MAX_REF_LENGTH = 200;

const PARAMETER_FILES = new Map([
  ["FORD_GE1 Gateway.json", "Gateway"],
  ["FORD_GE1 Shift.json", "Shift"],
  ["FORD_GE1 Throttle.json", "Throttle"],
]);

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request, env),
        });
      }

      const accessError = await requireCloudflareAccess(request, env);
      if (accessError) {
        return accessError;
      }

      if (request.method !== "GET") {
        return jsonResponse(
          request,
          env,
          { error: "Method not allowed" },
          { status: 405 }
        );
      }

      const originError = validateOrigin(request, env);
      if (originError) {
        return jsonResponse(
          request,
          env,
          { error: originError },
          { status: 403 }
        );
      }

      const url = new URL(request.url);
      if (isAssetRoute(url.pathname)) {
        return env.ASSETS.fetch(request);
      }

      if (!env.GITHUB_TOKEN) {
        return jsonResponse(
          request,
          env,
          { error: "Worker secret GITHUB_TOKEN is not configured." },
          { status: 500 }
        );
      }

      if (url.pathname === "/parameter-file") {
        return handleParameterFile(request, env, url);
      }
      if (url.pathname === "/branch-suggestions") {
        return handleBranchSuggestions(request, env, url);
      }
      if (url.pathname === "/health") {
        return jsonResponse(request, env, { ok: true });
      }

      return jsonResponse(
        request,
        env,
        { error: "Not found" },
        { status: 404 }
      );
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      return jsonResponse(
        request,
        env,
        { error: error.message || "Unexpected error" },
        { status }
      );
    }
  },
};

async function handleParameterFile(request, env, url) {
  const ref = normalizeRequiredParam(url, "ref");
  const fileName = normalizeRequiredParam(url, "file");
  const module = PARAMETER_FILES.get(fileName);

  if (!module) {
    throw httpError(400, "Unsupported parameter file.");
  }

  const metadata = await githubJson(
    contentsApiUrl(ref, fileName),
    "application/vnd.github.object+json",
    env
  );

  if (metadata.type !== "file" || metadata.encoding !== "base64") {
    throw httpError(502, `${fileName} was not returned as a JSON file.`);
  }

  const text = decodeBase64Content(metadata.content);
  const json = JSON.parse(text);
  if (typeof json.hash !== "string" && typeof json.hash !== "number") {
    throw httpError(502, `${fileName} does not contain a top-level hash.`);
  }

  return jsonResponse(request, env, {
    module,
    fileName: metadata.name,
    hash: String(json.hash).toUpperCase(),
    text,
  });
}

async function handleBranchSuggestions(request, env, url) {
  const prefix = normalizeRequiredParam(url, "prefix");
  const refs = await githubJson(
    matchingRefsApiUrl(prefix),
    "application/vnd.github+json",
    env
  );
  const branchRefs = refs
    .filter((ref) => ref.ref && ref.ref.startsWith("refs/heads/"))
    .slice(0, 50);
  const suggestions = await Promise.all(
    branchRefs.map(async (ref) => ({
      name: ref.ref.slice("refs/heads/".length),
      updatedAt: await fetchBranchUpdatedAt(ref, env),
    }))
  );

  return jsonResponse(request, env, {
    suggestions: suggestions
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          left.name.localeCompare(right.name)
      )
      .slice(0, 25)
      .map((suggestion) => suggestion.name),
  });
}

async function fetchBranchUpdatedAt(ref, env) {
  try {
    const commitUrl = ref.object?.url;
    if (
      typeof commitUrl !== "string" ||
      !commitUrl.startsWith(
        `https://api.github.com/repos/${OWNER}/${REPO}/git/commits/`
      )
    ) {
      return 0;
    }

    const commit = await githubJson(
      commitUrl,
      "application/vnd.github+json",
      env
    );
    return (
      Date.parse(commit.committer?.date || commit.author?.date || "") || 0
    );
  } catch {
    return 0;
  }
}

function normalizeRequiredParam(url, name) {
  const value = (url.searchParams.get(name) || "").trim();
  if (!value) {
    throw httpError(400, `Missing required query parameter: ${name}.`);
  }
  if (value.length > MAX_REF_LENGTH) {
    throw httpError(400, `${name} is too long.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw httpError(400, `${name} contains invalid characters.`);
  }

  return value;
}

function contentsApiUrl(ref, fileName) {
  const path = `${PARAMETER_DIRECTORY}/${fileName}`;
  return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodedPath(
    path
  )}?ref=${encodeURIComponent(ref)}`;
}

function matchingRefsApiUrl(prefix) {
  const encodedPrefix = prefix.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${OWNER}/${REPO}/git/matching-refs/heads/${encodedPrefix}`;
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function githubJson(url, accept, env) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "dataspeed-parameter-proxy",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let githubMessage = errorText;
    try {
      githubMessage = JSON.parse(errorText).message || errorText;
    } catch {
      // GitHub usually returns JSON errors, but keep the raw body if not.
    }
    throw httpError(
      response.status,
      `${response.status} ${response.statusText}: ${githubMessage}`
    );
  }

  return response.json();
}

function decodeBase64Content(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0)
  );
  return new TextDecoder("utf-8").decode(bytes);
}

function validateOrigin(request, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  if (allowedOrigin === "*") {
    return "";
  }

  const origin = request.headers.get("Origin");
  if (!origin) {
    return "";
  }

  const allowedOrigins = allowedOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) {
    return "Origin is not allowed.";
  }

  return "";
}

function corsHeaders(request, env) {
  const configuredOrigin = env.ALLOWED_ORIGIN || "*";
  if (configuredOrigin === "*") {
    return {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
  }

  const origin = request.headers.get("Origin");
  const allowedOrigins = configuredOrigin
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowOrigin =
    origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": allowOrigin,
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function jsonResponse(request, env, body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json;charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html;charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function isAssetRoute(pathname) {
  return pathname === "/" || pathname === "/config.js";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
