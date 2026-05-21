import { supabase, orgId, json } from "./_supabase.js";
import { getRoboflowConfig, getLatestTrainingState } from "./_roboflow.js";

/**
 * GET /api/training-status?jobId=...   (or ?projectId=...)
 *
 * Returns the tracked job plus a best-effort Roboflow training-state read.
 * Read-only; not passcode-gated so the status screen can poll freely.
 * Advisory only — activation is confirmed via activate-model, not from this
 * poll, because Instant's API state shape is not reliably documented.
 *
 * Returns: { job, roboflow: { ready, latestVersion } | null }
 */
export async function handler(event) {
  if (event.httpMethod !== "GET") return json({ error: "Method not allowed" }, 405);

  const params = event.queryStringParameters || {};
  const { jobId, projectId } = params;
  if (!jobId && !projectId) {
    return json({ error: "jobId or projectId is required" }, 400);
  }

  const db = supabase();

  // Fetch the most relevant job (by id, or latest for the project).
  let query = db
    .from("training_jobs")
    .select("id, project_id, status, progress, roboflow_version, model_url, error_message, triggered_at, completed_at");
  query = jobId ? query.eq("id", jobId) : query.eq("project_id", projectId).order("triggered_at", { ascending: false }).limit(1);

  const { data: jobs, error: jobErr } = await query;
  if (jobErr) {
    console.error("[training-status]", jobErr.message);
    return json({ error: "Could not load training job" }, 500);
  }
  const job = Array.isArray(jobs) ? jobs[0] : jobs;
  if (!job) return json({ error: "Training job not found" }, 404);

  // Tenancy: confirm the job's project is in our org.
  const { data: project } = await db
    .from("projects").select("org_id").eq("id", job.project_id).single();
  if (project?.org_id !== orgId()) return json({ error: "Not in this org" }, 403);

  // Best-effort Roboflow state (advisory).
  let roboflow = null;
  try {
    const rf = await getRoboflowConfig(db, orgId());
    if (rf.apiKey) {
      const state = await getLatestTrainingState({
        apiKey: rf.apiKey, workspace: rf.workspace, project: rf.project,
      });
      roboflow = { ready: state.ready, latestVersion: state.latestVersion };
    }
  } catch (err) {
    console.error("[training-status] roboflow poll failed:", err.message);
  }

  return json({ job, roboflow });
}
