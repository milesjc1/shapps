import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { getSupabase } from "./db";
import type { Env } from "./types";

export class ShappsMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Shapps",
    version: "0.1.0",
  });

  async init() {
    const supabase = getSupabase(this.env.SUPABASE_URL, this.env.SUPABASE_ANON_KEY);

    // --- create_project ---
    this.server.tool(
      "create_project",
      "Create a new web app project",
      {
        name: z.string().describe("The name of the project"),
        slug: z.string().regex(/^[a-z0-9-]+$/).describe("URL-friendly slug (lowercase letters, numbers, hyphens)"),
        description: z.string().optional().describe("A short description of the project"),
      },
      async ({ name, slug, description }) => {
        // Create the project
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .insert({ name, slug, description: description ?? null })
          .select()
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error creating project: ${projectError.message}` }] };
        }

        // Create an initial draft version
        const { data: version, error: versionError } = await supabase
          .from("project_versions")
          .insert({
            project_id: project.id,
            version_number: 1,
            message: "Initial version",
            is_draft: true,
          })
          .select()
          .single();

        if (versionError) {
          return { content: [{ type: "text", text: `Project created but failed to create initial version: ${versionError.message}` }] };
        }

        // Link the draft version to the project
        await supabase
          .from("projects")
          .update({ draft_version_id: version.id })
          .eq("id", project.id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: `Project "${name}" created successfully!`,
                project_id: project.id,
                slug,
                draft_version_id: version.id,
              }, null, 2),
            },
          ],
        };
      }
    );

    // --- list_projects ---
    this.server.tool(
      "list_projects",
      "List all projects",
      {},
      async () => {
        const { data, error } = await supabase
          .from("projects")
          .select("id, name, slug, description, status, created_at, updated_at")
          .order("created_at", { ascending: false });

        if (error) {
          return { content: [{ type: "text", text: `Error listing projects: ${error.message}` }] };
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text", text: "No projects found. Use create_project to get started!" }] };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );

    // --- get_project ---
    this.server.tool(
      "get_project",
      "Get project details including its file list",
      {
        project_id: z.string().uuid().describe("The project ID"),
      },
      async ({ project_id }) => {
        // Get the project
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("*")
          .eq("id", project_id)
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error: ${projectError.message}` }] };
        }

        // Get files from the draft version (or active if no draft)
        const versionId = project.draft_version_id ?? project.active_version_id;
        let files: { file_path: string; content_type: string }[] = [];

        if (versionId) {
          const { data: fileData } = await supabase
            .from("project_files")
            .select("file_path, content_type")
            .eq("version_id", versionId);
          files = fileData ?? [];
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...project, files }, null, 2),
            },
          ],
        };
      }
    );

    // --- read_files ---
    this.server.tool(
      "read_files",
      "Read file contents from a project",
      {
        project_id: z.string().uuid().describe("The project ID"),
        file_paths: z.array(z.string()).optional().describe("Specific file paths to read. If omitted, reads all files."),
      },
      async ({ project_id, file_paths }) => {
        // Get the project to find its current version
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("draft_version_id, active_version_id")
          .eq("id", project_id)
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error: ${projectError.message}` }] };
        }

        const versionId = project.draft_version_id ?? project.active_version_id;
        if (!versionId) {
          return { content: [{ type: "text", text: "No version found for this project." }] };
        }

        let query = supabase
          .from("project_files")
          .select("file_path, content, content_type")
          .eq("version_id", versionId);

        if (file_paths && file_paths.length > 0) {
          query = query.in("file_path", file_paths);
        }

        const { data, error } = await query;

        if (error) {
          return { content: [{ type: "text", text: `Error reading files: ${error.message}` }] };
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text", text: "No files found." }] };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }
    );

    // --- write_files ---
    this.server.tool(
      "write_files",
      "Create or update files in a project. This saves to the current draft version.",
      {
        project_id: z.string().uuid().describe("The project ID"),
        files: z.array(
          z.object({
            file_path: z.string().describe("File path like 'index.html' or 'css/style.css'"),
            content: z.string().describe("The file content"),
            content_type: z.string().optional().describe("MIME type (auto-detected if omitted)"),
          })
        ).describe("The files to write"),
      },
      async ({ project_id, files }) => {
        // Get the project's draft version
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("draft_version_id")
          .eq("id", project_id)
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error: ${projectError.message}` }] };
        }

        if (!project.draft_version_id) {
          return { content: [{ type: "text", text: "No draft version found. Create a project first." }] };
        }

        const results: string[] = [];

        for (const file of files) {
          const contentType = file.content_type ?? guessContentType(file.file_path);

          // Upsert: delete existing file at this path in this version, then insert
          await supabase
            .from("project_files")
            .delete()
            .eq("version_id", project.draft_version_id)
            .eq("file_path", file.file_path);

          const { error } = await supabase
            .from("project_files")
            .insert({
              version_id: project.draft_version_id,
              file_path: file.file_path,
              content: file.content,
              content_type: contentType,
            });

          if (error) {
            results.push(`❌ ${file.file_path}: ${error.message}`);
          } else {
            results.push(`✅ ${file.file_path}`);
          }
        }

        return {
          content: [{ type: "text", text: `Files written:\n${results.join("\n")}` }],
        };
      }
    );

    // --- delete_files ---
    this.server.tool(
      "delete_files",
      "Remove files from a project's draft version",
      {
        project_id: z.string().uuid().describe("The project ID"),
        file_paths: z.array(z.string()).describe("File paths to delete"),
      },
      async ({ project_id, file_paths }) => {
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("draft_version_id")
          .eq("id", project_id)
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error: ${projectError.message}` }] };
        }

        if (!project.draft_version_id) {
          return { content: [{ type: "text", text: "No draft version found." }] };
        }

        const { error, count } = await supabase
          .from("project_files")
          .delete({ count: "exact" })
          .eq("version_id", project.draft_version_id)
          .in("file_path", file_paths);

        if (error) {
          return { content: [{ type: "text", text: `Error deleting files: ${error.message}` }] };
        }

        return {
          content: [{ type: "text", text: `Deleted ${count ?? 0} file(s).` }],
        };
      }
    );
  }
}

function guessContentType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    ts: "application/typescript",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    md: "text/markdown",
    txt: "text/plain",
  };
  return types[ext ?? ""] ?? "text/plain";
}

// Worker fetch handler
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return ShappsMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", service: "shapps-mcp" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
