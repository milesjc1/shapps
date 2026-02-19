import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { getSupabase } from "./db";
import type { Env } from "./types";

export class ShappsMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Shapps",
    version: "0.2.0",
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
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .insert({ name, slug, description: description ?? null })
          .select()
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error creating project: ${projectError.message}` }] };
        }

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
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("*")
          .eq("id", project_id)
          .single();

        if (projectError) {
          return { content: [{ type: "text", text: `Error: ${projectError.message}` }] };
        }

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
            results.push(`Failed ${file.file_path}: ${error.message}`);
          } else {
            results.push(`OK ${file.file_path}`);
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

    // ============================================================
    // Phase 2 tools: publish, get_preview_url, list_versions, rollback
    // ============================================================

    // --- publish ---
    this.server.tool(
      "publish",
      "Publish the current draft. Makes it live at /app/:slug and creates a new empty draft for future edits.",
      {
        project_id: z.string().uuid().describe("The project ID"),
        message: z.string().optional().describe("A short note about what changed in this version"),
      },
      async ({ project_id, message }) => {
        // Get the project
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("id, slug, draft_version_id")
          .eq("id", project_id)
          .single();

        if (projectError || !project) {
          return { content: [{ type: "text", text: `Error: ${projectError?.message ?? "Project not found"}` }] };
        }

        if (!project.draft_version_id) {
          return { content: [{ type: "text", text: "No draft version to publish." }] };
        }

        // Mark the draft as published (no longer a draft)
        const { error: publishError } = await supabase
          .from("project_versions")
          .update({ is_draft: false, message: message ?? "Published" })
          .eq("id", project.draft_version_id);

        if (publishError) {
          return { content: [{ type: "text", text: `Error publishing: ${publishError.message}` }] };
        }

        // Set it as the active version on the project
        const publishedVersionId = project.draft_version_id;

        // Get the version number of the just-published version
        const { data: publishedVersion } = await supabase
          .from("project_versions")
          .select("version_number")
          .eq("id", publishedVersionId)
          .single();

        const nextVersionNumber = (publishedVersion?.version_number ?? 1) + 1;

        // Create a new draft version
        const { data: newDraft, error: draftError } = await supabase
          .from("project_versions")
          .insert({
            project_id: project.id,
            version_number: nextVersionNumber,
            message: "Draft",
            is_draft: true,
          })
          .select()
          .single();

        if (draftError) {
          // Still update the project even if new draft fails
          await supabase
            .from("projects")
            .update({ active_version_id: publishedVersionId, draft_version_id: null, status: "published" })
            .eq("id", project.id);

          return { content: [{ type: "text", text: `Published! But failed to create new draft: ${draftError.message}` }] };
        }

        // Copy files from published version into the new draft
        const { data: files } = await supabase
          .from("project_files")
          .select("file_path, content, content_type")
          .eq("version_id", publishedVersionId);

        if (files && files.length > 0) {
          await supabase
            .from("project_files")
            .insert(
              files.map((f) => ({
                version_id: newDraft.id,
                file_path: f.file_path,
                content: f.content,
                content_type: f.content_type,
              }))
            );
        }

        // Update the project pointers
        await supabase
          .from("projects")
          .update({
            active_version_id: publishedVersionId,
            draft_version_id: newDraft.id,
            status: "published",
          })
          .eq("id", project.id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Published successfully!",
                live_url: `/app/${project.slug}`,
                version: publishedVersion?.version_number ?? 1,
                new_draft_version_id: newDraft.id,
              }, null, 2),
            },
          ],
        };
      }
    );

    // --- get_preview_url ---
    this.server.tool(
      "get_preview_url",
      "Get the preview URL for a project's current draft",
      {
        project_id: z.string().uuid().describe("The project ID"),
      },
      async ({ project_id }) => {
        const { data: project, error } = await supabase
          .from("projects")
          .select("slug, draft_version_id")
          .eq("id", project_id)
          .single();

        if (error || !project) {
          return { content: [{ type: "text", text: `Error: ${error?.message ?? "Project not found"}` }] };
        }

        if (!project.draft_version_id) {
          return { content: [{ type: "text", text: "No draft version exists for this project." }] };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                preview_url: `/preview/${project.slug}`,
                slug: project.slug,
              }, null, 2),
            },
          ],
        };
      }
    );

    // --- list_versions ---
    this.server.tool(
      "list_versions",
      "List all versions for a project, newest first. Shows which is active (live) and which is the current draft.",
      {
        project_id: z.string().uuid().describe("The project ID"),
      },
      async ({ project_id }) => {
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("active_version_id, draft_version_id")
          .eq("id", project_id)
          .single();

        if (projectError || !project) {
          return { content: [{ type: "text", text: `Error: ${projectError?.message ?? "Project not found"}` }] };
        }

        const { data: versions, error } = await supabase
          .from("project_versions")
          .select("id, version_number, message, is_draft, created_at")
          .eq("project_id", project_id)
          .order("version_number", { ascending: false });

        if (error) {
          return { content: [{ type: "text", text: `Error: ${error.message}` }] };
        }

        const annotated = (versions ?? []).map((v) => ({
          ...v,
          is_active: v.id === project.active_version_id,
          is_current_draft: v.id === project.draft_version_id,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(annotated, null, 2) }],
        };
      }
    );

    // --- rollback ---
    this.server.tool(
      "rollback",
      "Copy files from a previous version into the current draft. This replaces all files in the draft.",
      {
        project_id: z.string().uuid().describe("The project ID"),
        version_id: z.string().uuid().describe("The version ID to roll back to (get this from list_versions)"),
      },
      async ({ project_id, version_id }) => {
        // Get the project's current draft
        const { data: project, error: projectError } = await supabase
          .from("projects")
          .select("draft_version_id")
          .eq("id", project_id)
          .single();

        if (projectError || !project) {
          return { content: [{ type: "text", text: `Error: ${projectError?.message ?? "Project not found"}` }] };
        }

        if (!project.draft_version_id) {
          return { content: [{ type: "text", text: "No draft version to roll back into." }] };
        }

        // Verify the target version belongs to this project
        const { data: targetVersion, error: versionError } = await supabase
          .from("project_versions")
          .select("id, version_number")
          .eq("id", version_id)
          .eq("project_id", project_id)
          .single();

        if (versionError || !targetVersion) {
          return { content: [{ type: "text", text: "Version not found or doesn't belong to this project." }] };
        }

        // Get files from the target version
        const { data: sourceFiles } = await supabase
          .from("project_files")
          .select("file_path, content, content_type")
          .eq("version_id", version_id);

        // Delete all current draft files
        await supabase
          .from("project_files")
          .delete()
          .eq("version_id", project.draft_version_id);

        // Copy files into the draft
        if (sourceFiles && sourceFiles.length > 0) {
          const { error: insertError } = await supabase
            .from("project_files")
            .insert(
              sourceFiles.map((f) => ({
                version_id: project.draft_version_id!,
                file_path: f.file_path,
                content: f.content,
                content_type: f.content_type,
              }))
            );

          if (insertError) {
            return { content: [{ type: "text", text: `Error copying files: ${insertError.message}` }] };
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: `Rolled back to version ${targetVersion.version_number}. Files copied into your current draft.`,
                files_copied: sourceFiles?.length ?? 0,
              }, null, 2),
            },
          ],
        };
      }
    );

    // --- update_settings ---
    this.server.tool(
      "update_settings",
      "Update project settings like name, slug, description, visibility, or source code toggle.",
      {
        project_id: z.string().uuid().describe("The project ID"),
        name: z.string().optional().describe("New project name"),
        slug: z.string().regex(/^[a-z0-9-]+$/).optional().describe("New URL slug (lowercase letters, numbers, hyphens)"),
        description: z.string().optional().describe("New description"),
        is_public: z.boolean().optional().describe("Whether the app is publicly visible"),
        show_source: z.boolean().optional().describe("Whether visitors can view the source code"),
      },
      async ({ project_id, name, slug, description, is_public, show_source }) => {
        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (slug !== undefined) updates.slug = slug;
        if (description !== undefined) updates.description = description;
        if (is_public !== undefined) updates.is_public = is_public;
        if (show_source !== undefined) updates.show_source = show_source;

        if (Object.keys(updates).length === 0) {
          return { content: [{ type: "text", text: "Nothing to update. Provide at least one setting to change." }] };
        }

        updates.updated_at = new Date().toISOString();

        const { data, error } = await supabase
          .from("projects")
          .update(updates)
          .eq("id", project_id)
          .select("id, name, slug, description, is_public, show_source")
          .single();

        if (error) {
          return { content: [{ type: "text", text: `Error updating settings: ${error.message}` }] };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ message: "Settings updated!", ...data }, null, 2),
            },
          ],
        };
      }
    );

    // --- delete_project ---
    this.server.tool(
      "delete_project",
      "Permanently delete a project and all its versions and files. This cannot be undone.",
      {
        project_id: z.string().uuid().describe("The project ID"),
        confirm: z.boolean().describe("Must be true to confirm deletion"),
      },
      async ({ project_id, confirm }) => {
        if (!confirm) {
          return { content: [{ type: "text", text: "Deletion not confirmed. Set confirm to true to delete." }] };
        }

        // Clear version pointers first (foreign key constraints)
        const { error: clearError } = await supabase
          .from("projects")
          .update({ active_version_id: null, draft_version_id: null })
          .eq("id", project_id);

        if (clearError) {
          return { content: [{ type: "text", text: `Error: ${clearError.message}` }] };
        }

        // Get all version IDs for this project
        const { data: versions } = await supabase
          .from("project_versions")
          .select("id")
          .eq("project_id", project_id);

        // Delete files for all versions
        if (versions && versions.length > 0) {
          const versionIds = versions.map((v) => v.id);
          await supabase
            .from("project_files")
            .delete()
            .in("version_id", versionIds);
        }

        // Delete versions
        await supabase
          .from("project_versions")
          .delete()
          .eq("project_id", project_id);

        // Delete the project
        const { error: deleteError } = await supabase
          .from("projects")
          .delete()
          .eq("id", project_id);

        if (deleteError) {
          return { content: [{ type: "text", text: `Error deleting project: ${deleteError.message}` }] };
        }

        return {
          content: [{ type: "text", text: "Project deleted permanently." }],
        };
      }
    );
  }
}

export function guessContentType(filePath: string): string {
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
