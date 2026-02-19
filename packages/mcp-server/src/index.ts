export { ShappsMCP } from "./mcp";
import { ShappsMCP } from "./mcp";
import { serveApp } from "./serve";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const path = url.pathname;

    // MCP endpoint
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return ShappsMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // App serving: /app/:slug or /app/:slug/file.js
    if (path.startsWith("/app/")) {
      const rest = path.slice("/app/".length); // "my-project" or "my-project/css/style.css"
      const slashIndex = rest.indexOf("/");
      const slug = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const filePath = slashIndex === -1 ? "index.html" : rest.slice(slashIndex + 1) || "index.html";
      return serveApp(env, slug, filePath, "active");
    }

    // Preview serving: /preview/:slug or /preview/:slug/file.js
    if (path.startsWith("/preview/")) {
      const rest = path.slice("/preview/".length);
      const slashIndex = rest.indexOf("/");
      const slug = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const filePath = slashIndex === -1 ? "index.html" : rest.slice(slashIndex + 1) || "index.html";
      return serveApp(env, slug, filePath, "draft");
    }

    // Health check
    if (path === "/") {
      return new Response(JSON.stringify({ status: "ok", service: "shapps-mcp" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
