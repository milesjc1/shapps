import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { serveApp } from "./serve";
import type { Env, Props } from "./types";

/**
 * Handles all non-MCP routes:
 * - /authorize  → starts the Google Sign-In flow
 * - /callback   → Google redirects back here after sign-in
 * - /app/:slug  → serves published apps (public, no auth)
 * - /preview/:slug → serves draft previews (public for now)
 * - /           → health check
 */
export const AuthHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- /authorize: Start Google Sign-In ---
    if (path === "/authorize") {
      return handleAuthorize(request, env);
    }

    // --- /callback: Google redirects back here ---
    if (path === "/callback") {
      return handleCallback(request, env);
    }

    // --- /app/:slug → serve published app files ---
    if (path.startsWith("/app/")) {
      const rest = path.slice("/app/".length);
      const slashIndex = rest.indexOf("/");
      const slug = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const filePath = slashIndex === -1 ? "index.html" : rest.slice(slashIndex + 1) || "index.html";
      return serveApp(env, slug, filePath, "active");
    }

    // --- /preview/:slug → serve draft preview files ---
    if (path.startsWith("/preview/")) {
      const rest = path.slice("/preview/".length);
      const slashIndex = rest.indexOf("/");
      const slug = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const filePath = slashIndex === -1 ? "index.html" : rest.slice(slashIndex + 1) || "index.html";
      return serveApp(env, slug, filePath, "draft");
    }

    // --- / → health check ---
    if (path === "/") {
      return new Response(JSON.stringify({ status: "ok", service: "shapps-mcp" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

/**
 * Step 1 of OAuth: Parse the MCP client's authorization request,
 * save it in KV, and redirect the user to Google's sign-in page.
 */
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // Parse the OAuth request that the MCP client (e.g. Claude.ai) sent us
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  if (!oauthReqInfo.clientId) {
    return new Response("Invalid OAuth request", { status: 400 });
  }

  // Generate a random "state" token to link the Google redirect back to this request
  const stateParam = crypto.randomUUID();

  // Save the original OAuth request in KV so we can finish it after Google calls back
  await env.OAUTH_KV.put(
    `oauth_state:${stateParam}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 } // expires in 10 minutes
  );

  // Build the Google Sign-In URL
  const redirectUri = new URL("/callback", request.url).href;
  const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set("redirect_uri", redirectUri);
  googleAuthUrl.searchParams.set("response_type", "code");
  googleAuthUrl.searchParams.set("scope", "openid email profile");
  googleAuthUrl.searchParams.set("state", stateParam);
  googleAuthUrl.searchParams.set("access_type", "offline");

  return Response.redirect(googleAuthUrl.toString(), 302);
}

/**
 * Step 2 of OAuth: Google redirects here with a code.
 * We exchange it for the user's profile, then complete the MCP authorization.
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state from Google", { status: 400 });
  }

  // Retrieve the original OAuth request we saved in /authorize
  const stored = await env.OAUTH_KV.get(`oauth_state:${state}`);
  if (!stored) {
    return new Response("Invalid or expired state. Please try connecting again.", { status: 400 });
  }
  await env.OAUTH_KV.delete(`oauth_state:${state}`);
  const oauthReqInfo: AuthRequest = JSON.parse(stored);

  // Exchange Google's authorization code for tokens
  const redirectUri = new URL("/callback", request.url).href;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    return new Response("Failed to exchange Google authorization code", { status: 502 });
  }

  const googleTokens = (await tokenResp.json()) as {
    access_token: string;
    id_token: string;
  };

  // Use the access token to get the user's Google profile (email, name)
  const profileResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${googleTokens.access_token}` },
  });

  if (!profileResp.ok) {
    return new Response("Failed to fetch Google profile", { status: 502 });
  }

  const profile = (await profileResp.json()) as {
    id: string;
    email: string;
    name: string;
  };

  // Complete the OAuthProvider flow — this creates our access token
  // and encrypts the user's identity (props) into it
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: profile.id,
    metadata: { label: profile.name },
    scope: oauthReqInfo.scope,
    props: {
      email: profile.email,
      name: profile.name,
      userId: profile.id,
    } satisfies Props,
  });

  // Redirect the user back to Claude.ai (or whatever MCP client started the flow)
  return Response.redirect(redirectTo, 302);
}
