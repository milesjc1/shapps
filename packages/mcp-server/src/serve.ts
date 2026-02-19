import { getSupabase } from "./db";
import type { Env } from "./types";

/**
 * Serves a file from a Shapps project.
 * mode "active" = published app at /app/:slug
 * mode "draft"  = preview at /preview/:slug
 */
export async function serveApp(
  env: Env,
  slug: string,
  filePath: string,
  mode: "active" | "draft"
): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return new Response("Server misconfiguration: missing database credentials", { status: 500 });
  }

  const supabase = getSupabase(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

  // Look up the project by slug
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, active_version_id, draft_version_id, status")
    .eq("slug", slug)
    .single();

  if (projectError || !project) {
    return new Response("Project not found", { status: 404 });
  }

  // Pick the right version based on mode
  const versionId =
    mode === "active" ? project.active_version_id : project.draft_version_id;

  if (!versionId) {
    const message =
      mode === "active"
        ? "This app hasn't been published yet."
        : "No draft version exists for this project.";
    return new Response(
      `<!DOCTYPE html><html><body><h1>${message}</h1></body></html>`,
      { status: 404, headers: { "Content-Type": "text/html" } }
    );
  }

  // Fetch the requested file
  const { data: file, error: fileError } = await supabase
    .from("project_files")
    .select("content, content_type")
    .eq("version_id", versionId)
    .eq("file_path", filePath)
    .single();

  if (fileError || !file) {
    return new Response("File not found", { status: 404 });
  }

  const cacheControl =
    mode === "active" ? "public, max-age=300" : "no-cache, no-store";

  return new Response(file.content, {
    headers: {
      "Content-Type": file.content_type,
      "Cache-Control": cacheControl,
    },
  });
}
