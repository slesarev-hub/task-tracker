/**
 * Task Tracker auth Worker.
 * - GET  /login     → redirects to Google OAuth (offline access)
 * - GET  /callback  → exchanges code, stores refresh_token in KV, returns
 *                     to the app with a session id in the URL fragment
 * - GET  /token     → returns a fresh access_token (Bearer session)
 * - POST /logout    → removes the session from KV
 */

interface Env {
  SESSIONS: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

const ALLOWED_ORIGINS = [
  "https://slesarev-hub.github.io",
  "http://localhost:5173",
  "http://localhost:5174",
];

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin");

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── /login: send the user to Google's authorisation page ────────────
    if (url.pathname === "/login" && req.method === "GET") {
      const redirectAfter =
        url.searchParams.get("redirect") ||
        "https://slesarev-hub.github.io/task-tracker/";
      const state = randomToken(16);
      await env.SESSIONS.put(`state:${state}`, redirectAfter, {
        expirationTtl: 300,
      });

      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/callback`,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return Response.redirect(
        `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        302
      );
    }

    // ── /callback: trade the auth code for tokens ───────────────────────
    if (url.pathname === "/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return new Response("Missing code/state", { status: 400 });
      }

      const redirectAfter = await env.SESSIONS.get(`state:${state}`);
      if (!redirectAfter) {
        return new Response("Invalid state", { status: 400 });
      }
      await env.SESSIONS.delete(`state:${state}`);

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/callback`,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return new Response(`Token exchange failed: ${err}`, { status: 500 });
      }
      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        id_token?: string;
      };

      if (!tokens.refresh_token) {
        return new Response(
          "No refresh_token returned. Visit https://myaccount.google.com/permissions, " +
            "remove this app, and login again.",
          { status: 500 }
        );
      }

      let email = "";
      if (tokens.id_token) {
        const payload = decodeJwtPayload(tokens.id_token);
        if (payload && typeof payload.email === "string") email = payload.email;
      }

      const sessionId = randomToken(32);
      await env.SESSIONS.put(
        `sess:${sessionId}`,
        JSON.stringify({
          refresh_token: tokens.refresh_token,
          email,
          created_at: Date.now(),
        }),
        { expirationTtl: 60 * 60 * 24 * 365 }
      );

      const redirectUrl = new URL(redirectAfter);
      redirectUrl.hash = `session=${encodeURIComponent(sessionId)}`;
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // ── /token: get a fresh access_token using the stored refresh_token ──
    if (url.pathname === "/token" && req.method === "GET") {
      const auth = req.headers.get("Authorization") || "";
      const sessionId = auth.replace(/^Bearer\s+/i, "").trim();
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "missing_session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }
      const sessRaw = await env.SESSIONS.get(`sess:${sessionId}`);
      if (!sessRaw) {
        return new Response(JSON.stringify({ error: "invalid_session" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }
      const sess = JSON.parse(sessRaw) as { refresh_token: string; email: string };

      const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          refresh_token: sess.refresh_token,
          grant_type: "refresh_token",
        }),
      });
      if (!refreshRes.ok) {
        const err = await refreshRes.text();
        await env.SESSIONS.delete(`sess:${sessionId}`);
        return new Response(
          JSON.stringify({ error: "refresh_failed", detail: err }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders(origin),
            },
          }
        );
      }
      const tokens = (await refreshRes.json()) as {
        access_token: string;
        expires_in: number;
      };
      return new Response(
        JSON.stringify({
          access_token: tokens.access_token,
          expires_in: tokens.expires_in,
          email: sess.email,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin),
          },
        }
      );
    }

    // ── /logout: drop the session record ─────────────────────────────────
    if (url.pathname === "/logout" && req.method === "POST") {
      const auth = req.headers.get("Authorization") || "";
      const sessionId = auth.replace(/^Bearer\s+/i, "").trim();
      if (sessionId) await env.SESSIONS.delete(`sess:${sessionId}`);
      return new Response("OK", { headers: corsHeaders(origin) });
    }

    // ── /: health check ──────────────────────────────────────────────────
    if (url.pathname === "/" && req.method === "GET") {
      return new Response("task-tracker-auth: ok", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
