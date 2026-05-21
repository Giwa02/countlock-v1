import { supabase, orgId, json, readJson } from "./_supabase.js";
import { getRoboflowConfig, trainDeepLink } from "./_roboflow.js";
import { requireSupervisor } from "./_supervisor.js";

/**
 * POST /api/trigger-training  (supervisor only)
 * Body: { projectId: uuid }
 *
 * Free-tier (Roboflow Instant) flow:
 *   - The first model auto-trains when labeled images land in the dataset, so
 *     this endpoint does NOT fire a paid train API. It records the job, marks
 *     the project's untrained/captured parts as 'training', and returns a
 *     Roboflow deep-link the supervisor uses to kick a retrain when needed.
 *   - On a paid plan, set TRAINING_MODE=roboflow3 and this is where the real
 *     version.train() REST call would fire (left as a clearly-marked TODO so
 *     it isn't blind-shipped against the known-finicky train API).
 *
 * Returns: { jobId, deepLink, mode }
 */
export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const denied = requireSupervisor(event);
  if (denied) return denied;

  const body = readJson(event);
  if (!body?.projectId) return json({ error: "projectId is required" }, 400);
  const { projectId } = body;

  const db = supabase();

  // Tenancy: project must be in our org.
  const { data: project, error: projErr } = await db
    .from("projects")
    .select("id, org_id")
    .eq("id", projectId)
    .single();
  if (projErr || !project) return json({ error: "Project not found" }, 404);
  if (project.org_id !== orgId()) return json({ error: "Project not in this org" }, 403);

  const rf = await getRoboflowConfig(db, orgId());
  if (!rf.apiKey) return json({ error: { code: "ROBOFLOW_NOT_CONFIGURED" } }, 500);

  // Record the training job.
  const { data: jobRow, error: jobErr } = await db
    .from("training_jobs")
    .insert({
      project_id: projectId,
      status: "training",
      progress: 0,
      created_by: null, // no per-user identity in CountLock yet
    })
    .select("id")
    .single();
  if (jobErr) {
    console.error("[trigger-training] job insert failed:", jobErr.message);
    return json({ error: "Could not record training job" }, 500);
  }

  // Move this project's not-yet-trained parts to 'training'.
  await db
    .from("project_parts")
    .update({ training_status: "training" })
    .eq("project_id", projectId)
    .in("training_status", ["untrained", "images_captured"]);

  return json({
    jobId: jobRow.id,
    deepLink: trainDeepLink(rf.workspace, rf.project),
    mode: "instant_auto",
    message:
      "Labeled images are in your Roboflow dataset. The first Instant model trains automatically. " +
      "For a retrain, open Roboflow with the link, then return and activate the new model.",
  });
}
