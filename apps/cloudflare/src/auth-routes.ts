import {
  type AuthEnv,
  authenticate,
  clearedSessionCookie,
  requestSignIn,
  revokeSession,
  roleAllows,
  sessionCookie,
  sessionCookieValue,
  verifySignIn,
} from "./auth.js";

// HTTP surface for hosted sign-in. Enabled on the pre-production surface only —
// see the caller in index.ts.
//
// The console reaches these through a same-origin proxy, so the session cookie is
// SameSite=Strict and the request token travels in a header the browser will not
// attach automatically. A cross-site form post therefore cannot act on a session.

const REQUEST_TOKEN_HEADER = "x-eventforge-request-token";

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: { "cache-control": "no-store", ...init.headers },
  });
}

function fault(status: number, code: string, detail: string, headers?: HeadersInit): Response {
  return Response.json(
    { type: "about:blank", title: code, status, code, retryable: status >= 500, detail },
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}

/** Coarse labels only. Storing a full user agent or raw IP against a session
 * would put identifying data in the authority for no operational gain. */
function labelsFor(request: Request): { userAgentLabel: string; ipLabel: string } {
  const agent = request.headers.get("user-agent") ?? "";
  const platform = /Mobi|Android|iPhone/.test(agent)
    ? "mobile"
    : /Mac|Windows|Linux|CrOS/.test(agent)
      ? "desktop"
      : "unknown";
  return {
    userAgentLabel: platform,
    ipLabel: request.headers.get("cf-ipcountry") ?? "unknown",
  };
}

async function readEmail(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { email?: unknown };
    return typeof body.email === "string" ? body.email : undefined;
  } catch {
    return undefined;
  }
}

export async function handleAuth(request: Request, env: AuthEnv, url: URL): Promise<Response> {
  const route = url.pathname.slice("/api/auth/".length);

  if (route === "request" && request.method === "POST") {
    const email = await readEmail(request);
    if (email === undefined)
      return fault(400, "INVALID_BODY", "Expected a JSON body with an email.");
    try {
      const outcome = await requestSignIn(env, email);
      // Always 202 with the same shape: this endpoint must not reveal whether an
      // address has an account.
      return json(
        { accepted: true, ...(outcome.devToken ? { devToken: outcome.devToken } : {}) },
        { status: 202 },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "auth_request_failed",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return fault(503, "MAIL_UNAVAILABLE", "Sign-in email could not be sent.");
    }
  }

  if (route === "verify" && request.method === "POST") {
    let token: string | undefined;
    try {
      const body = (await request.json()) as { token?: unknown };
      token = typeof body.token === "string" ? body.token : undefined;
    } catch {
      token = undefined;
    }
    if (!token) return fault(400, "INVALID_BODY", "Expected a JSON body with a token.");

    const result = await verifySignIn(env, token, labelsFor(request));
    if (!result.ok) {
      // A verified address with no membership is a distinct, safe-to-report state:
      // the link worked, but nothing has granted this identity access.
      if (result.reason === "no_membership")
        return fault(403, "NO_MEMBERSHIP", "This address has no workspace membership.");
      return fault(400, "INVALID_TOKEN", "The sign-in link is invalid, used, or expired.");
    }
    return json(
      {
        identity: { id: result.identity.id, email: result.identity.normalizedEmail },
        requestToken: result.requestToken,
      },
      {
        headers: {
          "set-cookie": sessionCookie(
            sessionCookieValue(result.identity.id, result.sessionId),
            result.maxAgeSeconds,
          ),
        },
      },
    );
  }

  if (route === "session" && request.method === "GET") {
    const caller = await authenticate(
      env,
      request,
      request.headers.get(REQUEST_TOKEN_HEADER) ?? undefined,
    );
    if (!caller)
      return fault(401, "UNAUTHENTICATED", "No valid session.", {
        "set-cookie": clearedSessionCookie,
      });
    return json({
      identity: { id: caller.identity.id, email: caller.identity.normalizedEmail },
      memberships: caller.memberships,
      // Reported so the console can hide what the caller cannot do. The server
      // still re-checks on every request; this is presentation, not enforcement.
      capabilities: {
        canRead: caller.memberships.some((m) => roleAllows(m.role, "viewer")),
        canOperate: caller.memberships.some((m) => roleAllows(m.role, "operator")),
        canAdminister: caller.memberships.some((m) => roleAllows(m.role, "admin")),
        canOwn: caller.memberships.some((m) => roleAllows(m.role, "owner")),
      },
    });
  }

  if (route === "logout" && request.method === "POST") {
    const caller = await authenticate(
      env,
      request,
      request.headers.get(REQUEST_TOKEN_HEADER) ?? undefined,
    );
    if (caller) await revokeSession(env, caller.identity.id, caller.session.id);
    // Always clear the cookie, even when the session was already invalid.
    return json({ ok: true }, { headers: { "set-cookie": clearedSessionCookie } });
  }

  return fault(404, "NOT_FOUND", "Unknown auth route.");
}
