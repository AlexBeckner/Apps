import { createRemoteJWKSet, jwtVerify } from "jose";

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const jwksByTeamDomain = new Map();

export async function requireCloudflareAccess(request, env) {
  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const policyAud = (env.POLICY_AUD || "").trim();

  if (!teamDomain || !policyAud) {
    if (isLocalRequest(request)) {
      return null;
    }
    return accessResponse(
      "Cloudflare Access is not configured for this Worker.",
      500
    );
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) {
    return accessResponse("Missing Cloudflare Access token.", 403);
  }

  try {
    await jwtVerify(token, jwksForTeamDomain(teamDomain), {
      issuer: teamDomain,
      audience: policyAud,
    });
    return null;
  } catch {
    return accessResponse("Invalid Cloudflare Access token.", 403);
  }
}

function normalizeTeamDomain(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function jwksForTeamDomain(teamDomain) {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`)
    );
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

function isLocalRequest(request) {
  const { hostname } = new URL(request.url);
  return LOCAL_HOSTNAMES.has(hostname);
}

function accessResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain;charset=utf-8",
    },
  });
}
