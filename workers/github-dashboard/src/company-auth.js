const ALLOWED_EMAIL_DOMAINS = new Set(["applied.co", "ext.applied.co"]);
const AUTH_PATH_PREFIX = "/auth/";
const CHALLENGE_COOKIE = "company_auth_challenge";
const SESSION_COOKIE = "company_auth_session";
const CHALLENGE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function companyAuthResponse(request, env, appName) {
  const url = new URL(request.url);

  if (url.pathname === "/auth/request-code") {
    return handleRequestCode(request, env, appName);
  }
  if (url.pathname === "/auth/verify-code") {
    return handleVerifyCode(request, env);
  }
  if (url.pathname === "/auth/logout") {
    return handleLogout();
  }

  if (url.pathname.startsWith(AUTH_PATH_PREFIX)) {
    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  const session = await readSignedCookie(request, env, SESSION_COOKIE);
  if (session && session.email && session.exp > nowSeconds()) {
    return null;
  }

  if (isBrowserNavigation(request)) {
    return loginPage(appName);
  }

  return jsonResponse({ error: "Authentication required." }, { status: 401 });
}

async function handleRequestCode(request, env, appName) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const configError = validateAuthConfig(env);
  if (configError) {
    return configError;
  }

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email || !isAllowedEmail(email)) {
    return jsonResponse(
      { error: "Use an @applied.co or @ext.applied.co email address." },
      { status: 400 }
    );
  }

  const code = verificationCode();
  const nonce = crypto.randomUUID();
  const expiresAt = nowSeconds() + CHALLENGE_TTL_SECONDS;
  const challenge = await signToken(
    {
      email,
      nonce,
      codeHash: await codeHash(email, code, nonce, env.AUTH_SECRET),
      exp: expiresAt,
    },
    env
  );

  await env.EMAIL.send({
    to: email,
    from: env.FROM_EMAIL,
    subject: `${appName} sign-in code`,
    text: `Your ${appName} sign-in code is ${code}. It expires in 10 minutes.`,
    html: `<p>Your <strong>${escapeHtml(appName)}</strong> sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
  });

  return jsonResponse(
    { ok: true },
    {
      headers: {
        "Set-Cookie": cookie(CHALLENGE_COOKIE, challenge, CHALLENGE_TTL_SECONDS),
      },
    }
  );
}

async function handleVerifyCode(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const configError = validateAuthConfig(env, { skipEmail: true });
  if (configError) {
    return configError;
  }

  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return jsonResponse({ error: "Enter the 6-digit code." }, { status: 400 });
  }

  const challenge = await readSignedCookie(request, env, CHALLENGE_COOKIE);
  if (!challenge || challenge.exp <= nowSeconds()) {
    return jsonResponse({ error: "The code expired. Request a new one." }, { status: 400 });
  }

  const expectedHash = await codeHash(
    challenge.email,
    code,
    challenge.nonce,
    env.AUTH_SECRET
  );
  if (!constantTimeEqual(expectedHash, challenge.codeHash)) {
    return jsonResponse({ error: "Invalid code." }, { status: 400 });
  }

  const session = await signToken(
    {
      email: challenge.email,
      iat: nowSeconds(),
      exp: nowSeconds() + SESSION_TTL_SECONDS,
      nonce: crypto.randomUUID(),
    },
    env
  );

  return jsonResponse(
    { ok: true },
    {
      cookies: [
        cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS),
        expiredCookie(CHALLENGE_COOKIE),
      ],
    }
  );
}

function handleLogout() {
  return jsonResponse(
    { ok: true },
    {
      cookies: [
        expiredCookie(SESSION_COOKIE),
        expiredCookie(CHALLENGE_COOKIE),
      ],
    }
  );
}

function validateAuthConfig(env, options = {}) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    return jsonResponse(
      { error: "AUTH_SECRET is not configured for this Worker." },
      { status: 500 }
    );
  }
  if (!options.skipEmail && !env.EMAIL) {
    return jsonResponse(
      { error: "EMAIL binding is not configured for this Worker." },
      { status: 500 }
    );
  }
  if (!options.skipEmail && !env.FROM_EMAIL) {
    return jsonResponse(
      { error: "FROM_EMAIL is not configured for this Worker." },
      { status: 500 }
    );
  }
  return null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isAllowedEmail(email) {
  const domain = email.split("@")[1] || "";
  return ALLOWED_EMAIL_DOMAINS.has(domain);
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

function verificationCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

async function codeHash(email, code, nonce, secret) {
  return sha256Base64Url(`${email}:${code}:${nonce}:${secret}`);
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
      <p class="muted">Sign in with an @applied.co or @ext.applied.co email address.</p>
      <form id="email-form">
        <label for="email">Email</label>
        <input id="email" name="email" autocomplete="email" required>
        <button type="submit">Send code</button>
      </form>
      <form id="code-form" hidden>
        <label for="code">Verification code</label>
        <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" required>
        <button type="submit">Sign in</button>
      </form>
      <p id="status" class="muted" role="status"></p>
    </main>
    <script>
      const statusEl = document.querySelector("#status");
      const emailForm = document.querySelector("#email-form");
      const codeForm = document.querySelector("#code-form");
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
      emailForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("Sending code...");
        try {
          await post("/auth/request-code", { email: emailForm.email.value });
          emailForm.hidden = true;
          codeForm.hidden = false;
          codeForm.code.focus();
          setStatus("Check your email for a 6-digit code.", "ok");
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
      codeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("Checking code...");
        try {
          await post("/auth/verify-code", { code: codeForm.code.value });
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
