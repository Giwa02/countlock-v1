import { supabase, orgId, json } from "./_supabase.js";
import { getRoboflowConfig, listProjectClasses } from "./_roboflow.js";

/**
 * GET /api/roboflow-classes
 * Returns the class names the Roboflow project currently knows about, so the
 * frontend can flag parts whose class isn't trained yet.
 *
 * Read-only metadata (class names only, no secrets) — not passcode-gated, so
 * the "needs training" banner can render for any viewer.
 *
 * Returns: { classes: string[], source: 'roboflow'|'unavailable' }
 */
export async function handler(event) {
  if (event.httpMethod !== "GET") return json({ error: "Method not allowed" }, 405);

  const db = supabase();
  const rf = await getRoboflowConfig(db, orgId());

  if (!rf.apiKey) {
    return json({ classes: [], source: "unavailable" });
  }

  try {
    const classes = await listProjectClasses({
      apiKey: rf.apiKey,
      workspace: rf.workspace,
      project: rf.project,
    });
    return json({ classes, source: "roboflow" });
  } catch (err) {
    console.error("[roboflow-classes]", err.message);
    // Fail soft: an unreachable Roboflow shouldn't break project views.
    return json({ classes: [], source: "unavailable" });
  }
}
