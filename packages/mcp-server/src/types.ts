import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  // OAuth (added in Phase 3)
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

/** User identity passed through OAuth into MCP tools via this.props */
export type Props = {
  email: string;
  name: string;
  userId: string;
};
