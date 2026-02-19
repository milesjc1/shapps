# Shapps — Implementation Plan (Plugin-First)

## Context

Shapps is a public product that lets non-technical people create web apps through AI. Instead of building a standalone editor, **Shapps is a plugin that lives inside ChatGPT, Claude, and Gemini**. Users chat with their AI, and the AI uses Shapps's tools to create, edit, and manage web apps.

Both Claude and ChatGPT use **MCP (Model Context Protocol)** — same standard, same backend serves both.

Key clarifications:
- Apps are always hosted on Shapps — there's no "deploy to the internet" step
- "Publish" means promoting a draft to the active version (like saving a Google Doc)
- Shared apps render full-screen with no Shapps wrapper
- Source code visibility is togglable by the project owner
- URLs are path-based: `shapps.dev/app/project-slug` (not subdomains)

---

## User Experience

**Through AI (primary):**
1. User opens Claude or ChatGPT → connects Shapps plugin (one-time OAuth)
2. "Create a landing page for my bakery" → AI calls `create_project` + `write_files`
3. "Let me see it" → AI calls `get_preview_url` → user clicks link
4. "Add a contact form" → AI reads current files, writes updated ones
5. "Publish it" → AI calls `publish` → draft becomes the active version
6. "Share it with my team" → AI returns the app URL

**Through Dashboard (secondary):**
- View/manage projects, see version history, toggle settings
- No code editing in the dashboard (the AI is the editor)

**Viewing a shared app:**
- Visitor goes to `shapps.dev/app/my-bakery`
- Sees the app full-screen (no Shapps branding/wrapper)
- If owner enabled "show source," there's a way to view the code

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| MCP Server | Cloudflare Worker (McpAgent class) | Cloudflare has first-class MCP support. Same infra as showmetop10. |
| API Logic | Hono (inside the Worker) | Handles MCP protocol + REST for dashboard + serves user apps. |
| Database | Supabase PostgreSQL | Projects, files, versions, users. You know it already. |
| OAuth (for plugins) | Cloudflare OAuthProvider | Handles OAuth 2.1 that Claude/ChatGPT require. |
| Auth (for dashboard) | Supabase Auth | Google, Microsoft, Apple sign-in. |
| Dashboard | React + Vite + Tailwind + shadcn/ui | Simple project management. |
| Dashboard Hosting | Cloudflare Pages | Free, deploys from git. |
| File Storage | Supabase (small files) + R2 (images/assets) | Keep it simple. |

**No Workers for Platforms needed.** User apps are served by the main Worker reading files from the database. This is much simpler.

**Estimated cost: ~$5-30/month.**

---

## Architecture

```
    Claude / ChatGPT / Gemini          shapps.dev
              |                            |
         MCP Protocol              Cloudflare Pages
              |                    (Dashboard SPA)
              v                            |
    ┌─────────────────────────────────────────┐
    │         Cloudflare Worker (Hono)         │
    │                                          │
    │  /mcp      → MCP tools for AI plugins    │
    │  /api/*    → REST API for dashboard      │
    │  /app/:slug → serves user apps (reads    │
    │               files from DB, returns     │
    │               HTML/CSS/JS)               │
    └──────────────┬───────────────────────────┘
                   │
            Supabase Postgres
            (users, projects,
             versions, files)
```

**How `/app/:slug` works:** When someone visits `shapps.dev/app/my-bakery`, the Worker looks up the project's active version, reads its files from Supabase, and returns the HTML. CSS/JS files are served at `/app/my-bakery/style.css`, etc. It's like a simple static file server backed by a database.

---

## MCP Tools

| Tool | What it does | Read/Write |
|------|-------------|------------|
| `create_project` | Create a new project (name, optional template) | Write |
| `list_projects` | List the user's projects | Read |
| `get_project` | Get project details + file list | Read |
| `read_files` | Read file contents from a project | Read |
| `write_files` | Create or update files (saves as new draft version) | Write |
| `delete_files` | Remove files from a project | Write |
| `get_preview_url` | Get URL to view current draft | Read |
| `publish` | Promote current draft to active version | Write |
| `list_versions` | Show version history | Read |
| `rollback` | Restore a previous version as the new draft | Write |
| `update_settings` | Change name, slug, public/private, show-source toggle | Write |
| `delete_project` | Delete a project | Write (destructive) |

---

## Database Schema

```sql
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null,
  slug text unique not null,
  description text,
  is_public boolean default false,
  show_source boolean default false,    -- can viewers see the code?
  status text default 'draft',          -- draft | active
  active_version_id uuid,              -- current live version
  draft_version_id uuid,               -- work-in-progress version
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) not null,
  version_number integer not null,
  message text,                         -- e.g. "Added contact form"
  is_draft boolean default true,
  created_at timestamptz default now()
);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  version_id uuid references public.project_versions(id) not null,
  file_path text not null,              -- "index.html", "css/style.css"
  content text not null,
  content_type text not null,
  created_at timestamptz default now()
);

create table public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  platform text not null,               -- 'claude' | 'chatgpt' | 'gemini'
  connected_at timestamptz default now()
);
```

---

## Build Plan

### Phase 1: MCP Server + Core Tools

**Goal:** A working MCP server that Claude can connect to. Create projects and write/read files.

1. Scaffold monorepo (Turborepo): `packages/mcp-server`, `packages/web`
2. Scaffold MCP server from Cloudflare's authless template
3. Set up Supabase project + database migrations
4. Implement core tools: `create_project`, `list_projects`, `read_files`, `write_files`
5. Test by connecting to Claude Code locally

### Phase 2: App Serving + Publishing

**Goal:** User apps are viewable at `shapps.dev/app/slug`. Draft → active flow works.

1. Add `/app/:slug` route to the Worker — serves HTML/CSS/JS from database
2. Add `/app/:slug/:filepath` for CSS, JS, and other files
3. Implement `publish` tool (promote draft to active)
4. Implement `get_preview_url` (returns draft URL for previewing before publishing)
5. Implement `list_versions`, `rollback`
6. Add starter templates (blank HTML, landing page, portfolio)

### Phase 3: OAuth + Platform Integration

**Goal:** Works in Claude.ai and ChatGPT (not just Claude Code).

1. Add Cloudflare `OAuthProvider` for OAuth 2.1 + Dynamic Client Registration
2. Wire Supabase Auth as the identity provider
3. Test connecting via Claude.ai
4. Test connecting via ChatGPT (if Apps SDK is available)
5. Add safety annotations to all tools (required for directory listing)

### Phase 4: Web Dashboard

**Goal:** Simple management UI at `shapps.dev`.

1. React + Vite app on Cloudflare Pages
2. Supabase Auth sign-in (Google, Microsoft, Apple)
3. Dashboard: project list, create new
4. Project detail: view files, version history, published URL
5. Settings: rename, slug, public/private, show-source toggle, delete
6. Landing/marketing page

### Phase 5: Marketplace + Polish

**Goal:** Get listed in Claude and ChatGPT directories.

1. Documentation with 3+ usage examples
2. Rate limiting and abuse protection
3. Submit to Claude's MCP directory
4. Submit to ChatGPT's app directory
5. Terms of service + privacy policy

---

## Key Risks

1. **OAuth complexity** — Claude and ChatGPT both require OAuth 2.1 with Dynamic Client Registration. Cloudflare's `OAuthProvider` handles most of it. **Mitigation:** Phase 1 skips auth entirely (works with Claude Code locally). OAuth comes in Phase 3 after core features are solid.

2. **Serving user apps from DB** — Reading files from Supabase on every request could be slow. **Mitigation:** Add Cloudflare Cache API (caches responses at the edge). Invalidate cache when a new version is published. For Phase 1, latency is acceptable.

3. **ChatGPT Apps availability** — Currently Business/Enterprise/Edu only. **Mitigation:** Claude supports MCP for all paid plans. Start with Claude, add ChatGPT when availability expands.

4. **User-generated content** — Someone could create a phishing page. **Mitigation:** Apps are served on a path under shapps.dev (not the root domain). Add Terms of Service and abuse reporting. Can add content scanning later.

---

## Verification Plan

1. **MCP tools:** Connect to Claude Code → create project → write files → read them back
2. **App serving:** Visit `shapps.dev/app/test-project` → see rendered HTML
3. **Publishing:** Write files → publish → verify active version updates → visitor sees new version
4. **OAuth:** Connect via Claude.ai → verify login flow → verify user identity persists
5. **Dashboard:** Sign in → see projects → view details → toggle settings
6. **End-to-end:** In Claude, say "Create a portfolio site, add an about section, publish it" → visit the URL → see the app

---

## Files to Reference

- `~/Desktop/mjc-creative/showmetop10/` — Hono + Workers + Supabase patterns to reuse
- `~/Desktop/mjc-creative/shapps/reference/` — Reference projects for architecture inspiration
- Cloudflare MCP template: `npm create cloudflare -- my-mcp --template=cloudflare/ai/demos/remote-mcp-authless`
- ChatGPT Apps SDK examples: `github.com/openai/openai-apps-sdk-examples`
- MCP Apps examples: `github.com/modelcontextprotocol/ext-apps/tree/main/examples`
