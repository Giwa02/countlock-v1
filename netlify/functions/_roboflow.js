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

// ───────────────────────────────────────────────────────────────────────────
// Roboflow REST endpoints
//
// Confidence levels (verified against Roboflow docs, May 2026):
//   - UPLOAD  : api.roboflow.com/dataset/{project}/upload  — well documented
//   - ANNOTATE: api.roboflow.com/dataset/{project}/annotate/{imageId} — documented
//   - PROJECT : api.roboflow.com/{workspace}/{project} — documented (class list)
//   - VERSION : api.roboflow.com/{workspace}/{project}/{version} — documented
//   - CREATE VERSION + TRAIN — SDK-wrapped, under-documented and known-finicky.
//     Those live in trigger-training/training-status and MUST be confirmed on
//     the first live training run. The four helpers below are the safe set.
// ───────────────────────────────────────────────────────────────────────────

const RF_API = "https://api.roboflow.com";

/**
 * Build a Pascal VOC XML annotation. Roboflow auto-detects VOC and reads the
 * class name inline from each <object><name>, so no separate labelmap file.
 * Pass an empty boxes array to register a confirmed background/null image
 * (an annotation file with zero objects) — reduces false positives.
 *
 * @param {{filename:string, width:number, height:number,
 *          boxes:Array<{className:string,xmin:number,ymin:number,xmax:number,ymax:number}>}}
 */
export function buildVocXml({ filename, width, height, boxes = [] }) {
  const esc = (s) =>
    String(s).replace(/[<>&'"]/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
    );
  const objects = boxes
    .map(
      (b) => `  <object>
    <name>${esc(b.className)}</name>
    <bndbox>
      <xmin>${Math.round(b.xmin)}</xmin>
      <ymin>${Math.round(b.ymin)}</ymin>
      <xmax>${Math.round(b.xmax)}</xmax>
      <ymax>${Math.round(b.ymax)}</ymax>
    </bndbox>
  </object>`
    )
    .join("\n");
  return `<annotation>
  <filename>${esc(filename)}</filename>
  <size>
    <width>${Math.round(width)}</width>
    <height>${Math.round(height)}</height>
    <depth>3</depth>
  </size>
${objects}
</annotation>`;
}

/**
 * Upload one training image to the Roboflow dataset, then attach its VOC
 * annotation (or register it as a background image when boxes is empty).
 *
 * @returns {Promise<{ imageId: string }>}
 */
export async function uploadTrainingImage({
  apiKey, project, base64Jpeg, filename, batch, boxes, width, height,
}) {
  const clean = String(base64Jpeg).replace(/^data:image\/\w+;base64,/, "");

  // 1. Upload the image bytes.
  const uploadUrl = new URL(`${RF_API}/dataset/${project}/upload`);
  uploadUrl.searchParams.set("api_key", apiKey);
  uploadUrl.searchParams.set("name", filename);
  uploadUrl.searchParams.set("split", "train");
  if (batch) uploadUrl.searchParams.set("batch", batch);

  const upRes = await fetch(uploadUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: clean,
  });
  const upJson = await upRes.json().catch(() => ({}));
  if (!upRes.ok || !(upJson.id || upJson.image?.id)) {
    throw new Error(`Roboflow image upload failed (${upRes.status}): ${upJson.message || JSON.stringify(upJson)}`);
  }
  const imageId = upJson.id || upJson.image.id;

  // 2. Attach VOC annotation (zero objects = confirmed background/null image).
  const xml = buildVocXml({ filename, width, height, boxes: boxes || [] });
  const annUrl = new URL(`${RF_API}/dataset/${project}/annotate/${imageId}`);
  annUrl.searchParams.set("api_key", apiKey);
  annUrl.searchParams.set("name", `${filename}.xml`);

  const annRes = await fetch(annUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: xml,
  });
  if (!annRes.ok) {
    const annJson = await annRes.json().catch(() => ({}));
    throw new Error(`Roboflow annotate failed (${annRes.status}): ${annJson.message || JSON.stringify(annJson)}`);
  }

  return { imageId };
}

/**
 * List the classes the project currently knows about. Used to flag untrained
 * parts (a brand-new part class won't appear here). Returns lowercased class
 * names for case-insensitive comparison.
 *
 * @returns {Promise<string[]>}
 */
export async function listProjectClasses({ apiKey, workspace, project }) {
  const url = new URL(`${RF_API}/${workspace}/${project}`);
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Roboflow project fetch failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  }

  // The project payload exposes classes as an object keyed by class name
  // (value = instance count). Fall back to a few other shapes defensively.
  const classObj = data.project?.classes || data.classes || {};
  const names = Array.isArray(classObj) ? classObj : Object.keys(classObj);
  return names.map((n) => String(n).toLowerCase());
}

/**
 * Best-effort training-state read for the project's latest version/model.
 * Roboflow's project payload lists versions with optional model info. For
 * free Instant models the exact shape varies, so this is advisory only — the
 * reliable activation path is the supervisor confirming the model URL from
 * Roboflow's Deploy page (see activate-model). Needs live confirmation.
 *
 * @returns {Promise<{ ready: boolean, latestVersion: number|null, raw: object }>}
 */
export async function getLatestTrainingState({ apiKey, workspace, project }) {
  const url = new URL(`${RF_API}/${workspace}/${project}`);
  url.searchParams.set("api_key", apiKey);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Roboflow project fetch failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  }
  const versions = Array.isArray(data.versions) ? data.versions : [];
  let latestVersion = null;
  let ready = false;
  for (const v of versions) {
    const num = Number(v.id?.split("/").pop() || v.version || 0);
    if (num > (latestVersion || 0)) {
      latestVersion = num;
      ready = Boolean(v.model || v.train?.model || v.exports);
    }
  }
  return { ready, latestVersion, raw: data };
}

/** Roboflow dashboard deep-link to the Models/Train page (free-tier retrain). */
export function trainDeepLink(workspace, project) {
  return `https://app.roboflow.com/${workspace}/${project}/models`;
}
