import { supabase, orgId, json, readJson } from "./_supabase.js";
import { getRoboflowConfig } from "./_roboflow.js";
import { requireSupervisor } from "./_supervisor.js";

/**
 * POST /api/activate-model  (supervisor only)
 * Body: { projectId: uuid, modelUrl: string, version: number, jobId?: uuid }
 *
 * The reliable activation path (A1): points the live inference model at a
 * trained model by updating the countlock.roboflow_active_model row — no
 * Netlify env change, no redeploy. count-image reads this on the next call.
 *
 * modelUrl is the inference URL from Roboflow's Deploy page:
 *   - detect.roboflow.com/{project}/{version}     (Roboflow 3.0)
 *   - serverless.roboflow.com/{model-id}          (Instant, Serverless V2)
 * We validate it's a Roboflow host so the live counter can't be pointed
 * at an arbitrary endpoint.
 *
 * Marks the project's parts 'trained' and completes the training job.
 */
export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const denied = requireSupervisor(event);
  if (denied) return denied;

  const body = readJson(event);
  if (!body?.projectId || !body?.modelUrl) {
    return json({ error: "projectId and modelUrl are required" }, 400);
  }
  const { projectId, modelUrl, jobId } = body;
  const version = Number(body.version) || null;

  // Validate the model URL points at Roboflow.
  let host;
  try {
    host = new URL(modelUrl).host;
  } catch {
    return json({ error: "modelUrl is not a valid URL" }, 400);
  }
  if (!/(^|\.)roboflow\.com$/.test(host)) {
    return json({ error: "modelUrl must be a roboflow.com inference endpoint" }, 400);
  }

  const db = supabase();

  // Tenancy.
  const { data: project, error: projErr } = await db
    .from("projects").select("id, org_id").eq("id", projectId).single();
  if (projErr || !project) return json({ error: "Project not found" }, 404);
  if (project.org_id !== orgId()) return json({ error: "Project not in this org" }, 403);

  const rf = await getRoboflowConfig(db, orgId());

  // Flip the activation pointer (A1). Upsert on org_id.
  const { error: actErr } = await db
    .from("roboflow_active_model")
    .upsert(
      {
        org_id: orgId(),
        roboflow_workspace: rf.workspace,
        roboflow_project: rf.project,
        active_version: version ?? rf.activeVersion ?? 1,
        model_url: modelUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" }
    );
  if (actErr) {
    console.error("[activate-model] activation upsert failed:", actErr.message);
    return json({ error: "Could not update active model" }, 500);
  }

  // Mark the project's parts trained.
  await db
    .from("project_parts")
    .update({ training_status: "trained" })
    .eq("project_id", projectId);

  // Complete the training job if one was referenced.
  if (jobId) {
    await db
      .from("training_jobs")
      .update({
        status: "trained",
        progress: 100,
        model_url: modelUrl,
        roboflow_version: version,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  }

  return json({ activated: true, modelUrl, version: version ?? rf.activeVersion ?? 1 });
}
