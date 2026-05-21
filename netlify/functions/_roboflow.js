// Shared Roboflow helpers for CountLock Netlify functions.
//
// Responsibilities:
//   1. Dual env access (Netlify.env in edge, process.env in serverless).
//   2. Active-model resolution — DB-backed (countlock.roboflow_active_model)
//      with a fallback to the ROBOFLOW_MODEL_URL env var so nothing breaks
//      before a model has ever been activated through Training Mode.
//
// The active model lives in the DB (not an env var) so that activate-model
// can flip the live inference model with a single row update — no Netlify
// env change, no redeploy. count-image reads it at request time.

export function getEnv(key) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(key) || "";
  } catch {}
  try {
    return process.env[key] || "";
  } catch {}
  return "";
}

/**
 * Resolve the active inference model for an org.
 * @param {object} db   countlock-schema service-role Supabase client
 * @param {string} org  public.orgs.id UUID
 * @returns {Promise<null | {
 *   modelUrl: string, workspace: string, project: string,
 *   version: number|null, source: 'db'|'env'
 * }>}
 */
export async function getActiveModel(db, org) {
  // Service role bypasses RLS, so this reads regardless of the caller.
  const { data, error } = await db
    .from("roboflow_active_model")
    .select("model_url, roboflow_workspace, roboflow_project, active_version")
    .eq("org_id", org)
    .maybeSingle();

  if (!error && data && data.model_url) {
    return {
      modelUrl: data.model_url,
      workspace: data.roboflow_workspace,
      project: data.roboflow_project,
      version: data.active_version,
      source: "db",
    };
  }

  // Fallback: env var. Keeps pre-Training-Mode behavior intact.
  const envUrl = getEnv("ROBOFLOW_MODEL_URL");
  if (envUrl) {
    return {
      modelUrl: envUrl,
      workspace: getEnv("ROBOFLOW_WORKSPACE"),
      project: getEnv("ROBOFLOW_PROJECT"),
      version: null,
      source: "env",
    };
  }

  return null;
}

/**
 * Roboflow workspace/project/key for dataset + train operations.
 * Prefers the DB active-model row (kept in sync on activation), falls back
 * to env vars. Workspace/project rarely change, but resolving from one place
 * avoids drift.
 */
export async function getRoboflowConfig(db, org) {
  const active = await getActiveModel(db, org);
  return {
    apiKey: getEnv("ROBOFLOW_API_KEY"),
    workspace: active?.workspace || getEnv("ROBOFLOW_WORKSPACE") || "giwa02-gmail-com",
    project: active?.project || getEnv("ROBOFLOW_PROJECT") || "countlock",
    activeVersion: active?.version ?? null,
  };
}
