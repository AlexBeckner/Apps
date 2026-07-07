import { companyAuthResponse } from "../../githubdashboard/src/company-auth.js";

// The app is fully client-side: it reads a log folder in the browser and never
// uploads anything. This Worker's only job is to enforce the shared company
// password (companyAuthResponse) and then serve the static files in ./public.
export default {
  async fetch(request, env) {
    try {
      const authResponse = await companyAuthResponse(request, env, "Log Search");
      if (authResponse) {
        return authResponse;
      }

      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      return jsonResponse({ error: error.message || "Unexpected error" }, status);
    }
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json;charset=utf-8",
    },
  });
}
