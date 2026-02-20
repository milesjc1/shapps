import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ShappsMCP } from "./mcp";
import { AuthHandler } from "./auth-handler";

// Re-export the Durable Object class (required by Cloudflare Workers)
export { ShappsMCP };

/**
 * OAuthProvider wraps everything:
 * - Requests to /mcp go to the MCP server (apiHandler), but ONLY if they have a valid token
 * - /token and /register are handled automatically (OAuth 2.1 protocol)
 * - Everything else (/authorize, /callback, /app/*, /preview/*, /) goes to AuthHandler
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: ShappsMCP.serve("/mcp"),
  defaultHandler: AuthHandler as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
