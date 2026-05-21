import { supabase, orgId, json, readJson } from "./_supabase.js";
import { getRoboflowConfig, uploadTrainingImage } from "./_roboflow.js";
import { requireSupervisor } from "./_supervisor.js";

// Netlify sync request limit is 6 MB; base64 image must stay under it.
const MAX_IMAGE_BYTES = 5_000_000;

/**
 * POST /api/upload-training-image  (supervisor only)
 * Body: {
 *   partId: uuid,              // countlock.project_parts.id
 *   imageBase64: string,       // cropped JPEG (framing-guide region)
 *   width: number, height: number,   // pixel dims of the uploaded image
 *   boxes: Array<{xmin,ymin,xmax,ymax}>,  // pixel coords; [] = background frame
 *   configLabel: string,       // which of the 8 shots (or "background")
 *   isBackground?: boolean,
 *   markImagesCaptured?: boolean  // set on the final "Done with this part" upload
 * }
 * Returns: { roboflow_image_id, box_count }
 */
export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const denied = requireSupervisor(event);
  if (denied) return denied;

  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { partId, imageBase64, width, height, configLabel } = body;
  const isBackground = Boolean(body.isBackground);
  if (!partId || !imageBase64) {
    return json({ error: "partId and imageBase64 are required" }, 400);
  }
  if (typeof imageBase64 !== "string" || imageBase64.length > MAX_IMAGE_BYTES) {
    return json({ error: `Image missing or too large (max ${MAX_IMAGE_BYTES} b64 bytes)` }, 413);
  }
  if (!width || !height) {
    return json({ error: "width and height are required for annotation" }, 400);
  }

  const db = supabase();

  // Resolve the part → its Roboflow class (part_id text) and owning project.
  // Also enforces tenancy: the part must belong to a project in our org.
  const { data: part, error: partError } = await db
    .from("project_parts")
    .select("id, part_id, project_id, projects!inner(org_id)")
    .eq("id", partId)
    .single();

  if (partError || !part) return json({ error: "Part not found" }, 404);
  if (part.projects?.org_id !== orgId()) return json({ error: "Part not in this org" }, 403);

  const className = part.part_id; // stable Roboflow class identifier

  // Server stamps the class on every box — never trust the client for identity.
  const rawBoxes = Array.isArray(body.boxes) ? body.boxes : [];
  const boxes = isBackground
    ? []
    : rawBoxes.map((b) => ({
        className,
        xmin: Number(b.xmin), ymin: Number(b.ymin),
        xmax: Number(b.xmax), ymax: Number(b.ymax),
      }));

  // Resolve Roboflow target.
  const rf = await getRoboflowConfig(db, orgId());
  if (!rf.apiKey) return json({ error: { code: "ROBOFLOW_NOT_CONFIGURED" } }, 500);

  const stamp = Date.now();
  const safeClass = String(className).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeClass}-${configLabel || (isBackground ? "background" : "shot")}-${stamp}.jpg`;
  const batch = `countlock-train-${part.project_id}`;

  let imageId;
  try {
    ({ imageId } = await uploadTrainingImage({
      apiKey: rf.apiKey,
      project: rf.project,
      base64Jpeg: imageBase64,
      filename,
      batch,
      boxes,
      width: Number(width),
      height: Number(height),
    }));
  } catch (err) {
    console.error("[upload-training-image]", JSON.stringify({ partId, error: err.message }));
    return json({ error: { code: "ROBOFLOW_UPLOAD_FAILED", message: err.message } }, 502);
  }

  // Record for audit + potential delete.
  const { error: insErr } = await db.from("training_images").insert({
    part_id: partId,
    roboflow_image_id: imageId,
    config_label: configLabel || (isBackground ? "background" : null),
    box_count: boxes.length,
  });
  if (insErr) {
    console.error("[upload-training-image] DB insert failed:", insErr.message);
    // Image is already in Roboflow; surface but don't hard-fail the capture.
  }

  // Move the part to 'images_captured' on the final upload of its sequence.
  if (body.markImagesCaptured) {
    await db.from("project_parts")
      .update({ training_status: "images_captured" })
      .eq("id", partId)
      .eq("training_status", "untrained"); // don't regress a trained part
  }

  return json({ roboflow_image_id: imageId, box_count: boxes.length });
}
