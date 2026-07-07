const AUTH_PATH_PREFIX = "/auth/";
const SESSION_COOKIE = "company_auth_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function companyAuthResponse(request, env, appName) {
  const url = new URL(request.url);

  if (url.pathname === "/auth/login") {
    return handleLogin(request, env);
  }
  if (url.pathname === "/auth/logout") {
    return handleLogout();
  }

  if (url.pathname.startsWith(AUTH_PATH_PREFIX)) {
    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  const session = await readSignedCookie(request, env, SESSION_COOKIE);
  if (session && session.authenticated && session.exp > nowSeconds()) {
    return null;
  }

  if (isBrowserNavigation(request)) {
    return loginPage(appName);
  }

  return jsonResponse({ error: "Authentication required." }, { status: 401 });
}

async function handleLogin(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const configError = validateAuthConfig(env);
  if (configError) {
    return configError;
  }

  const body = await request.json().catch(() => ({}));
  const password = String(body.password || "");
  const passwordHash = await sha256Base64Url(password);
  const expectedHash = await sha256Base64Url(env.ACCESS_PASSWORD);
  if (!constantTimeEqual(passwordHash, expectedHash)) {
    return jsonResponse({ error: "Invalid password." }, { status: 401 });
  }

  const session = await signToken(
    {
      authenticated: true,
      iat: nowSeconds(),
      exp: nowSeconds() + SESSION_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    },
    env
  );

  return jsonResponse(
    { ok: true },
    {
      cookies: [cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS)],
    }
  );
}

function handleLogout() {
  return jsonResponse(
    { ok: true },
    {
      cookies: [expiredCookie(SESSION_COOKIE)],
    }
  );
}

function validateAuthConfig(env) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    return jsonResponse(
      { error: "AUTH_SECRET is not configured for this Worker." },
      { status: 500 }
    );
  }
  if (!env.ACCESS_PASSWORD) {
    return jsonResponse(
      { error: "ACCESS_PASSWORD is not configured for this Worker." },
      { status: 500 }
    );
  }
  return null;
}

function constantTimeEqual(left, right) {
  const leftValue = String(left || "");
  const rightValue = String(right || "");
  if (leftValue.length !== rightValue.length) return false;

  let difference = 0;
  for (let index = 0; index < leftValue.length; index += 1) {
    difference |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }
  return difference === 0;
}

async function signToken(payload, env) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(encodedPayload, env.AUTH_SECRET);
  return `${encodedPayload}.${signature}`;
}

async function readSignedCookie(request, env, name) {
  if (!env.AUTH_SECRET) return null;

  const value = cookieValue(request, name);
  if (!value) return null;

  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) return null;

  try {
    const valid = await verifyHmac(encodedPayload, signature, env.AUTH_SECRET || "");
    if (!valid) return null;
    return JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return arrayBufferToBase64Url(signature);
}

async function verifyHmac(value, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToArrayBuffer(signature),
    new TextEncoder().encode(value)
  );
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return arrayBufferToBase64Url(digest);
}

function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  const cookies = header.split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const found = cookies.find((part) => part.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function expiredCookie(name) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function isBrowserNavigation(request) {
  const accept = request.headers.get("Accept") || "";
  return request.method === "GET" && accept.includes("text/html");
}

function loginPage(appName) {
  return new Response(loginHtml(appName), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html;charset=utf-8",
    },
  });
}

function jsonResponse(body, init = {}) {
  const { cookies = [], ...responseInit } = init;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json;charset=utf-8",
    ...(responseInit.headers || {}),
  });
  cookies.forEach((value) => {
    headers.append("Set-Cookie", value);
  });

  return new Response(JSON.stringify(body), {
    ...responseInit,
    headers,
  });
}

function loginHtml(appName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(appName)} sign in</title>
    <style>
      body { background: #111; color: #eee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
      main { margin: 12vh auto; max-width: 420px; padding: 0 20px; }
      label { display: block; font-weight: 700; margin: 16px 0 6px; }
      input, button { background: #111; border: 1px solid #666; color: #eee; font: inherit; padding: 8px 10px; width: 100%; }
      button { background: #2a2a2a; cursor: pointer; margin-top: 16px; }
      .muted { color: #aaa; }
      .error { color: #ff8a8a; }
      .ok { color: #8aff8a; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(appName)}</h1>
      <p class="muted">Sign in with the shared access password.</p>
      <form id="login-form">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
      </form>
      <p id="status" class="muted" role="status"></p>
    </main>
    <script>
      const statusEl = document.querySelector("#status");
      const loginForm = document.querySelector("#login-form");
      function setStatus(message, className) {
        statusEl.textContent = message;
        statusEl.className = className || "muted";
      }
      async function post(path, body) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Request failed");
        return data;
      }
      loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("Signing in...");
        try {
          await post("/auth/login", { password: loginForm.password.value });
          location.reload();
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function base64UrlEncode(value) {
  return arrayBufferToBase64Url(new TextEncoder().encode(value));
}

function base64UrlDecode(value) {
  const bytes = new Uint8Array(base64UrlToArrayBuffer(value));
  return new TextDecoder().decode(bytes);
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToArrayBuffer(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
