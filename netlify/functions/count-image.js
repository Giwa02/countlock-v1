import { supabase, orgId, json, readJson } from "./_supabase.js";
import { getActiveModel, getEnv } from "./_roboflow.js";

// Netlify Functions sync request limit is 6 MB. After base64 padding the JPEG
// has to be smaller than that. We hold a hard cap with margin.
const MAX_IMAGE_BYTES = 5_000_000;

export async function handler(event) {
  if (event.httpMethod !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const { kitId, partId, imageBase64 } = body;
  if (!kitId || !partId || !imageBase64) {
    return json({ error: "kitId, partId, imageBase64 are all required" }, 400);
  }
  if (typeof imageBase64 !== "string") {
    return json({ error: "imageBase64 must be a string" }, 400);
  }
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return json(
      { error: `Image too large (max ${MAX_IMAGE_BYTES} bytes after base64)` },
      413
    );
  }

  const db = supabase();

  // Tenancy: assert the kit belongs to our configured org. The RPC raises
  // P0002 if the kit doesn't exist OR belongs to a different org. From an
  // attacker's perspective the two cases are indistinguishable.
  const { data: kitArr, error: assertError } = await db.rpc(
    "assert_kit_in_org",
    { p_kit_id: kitId, p_org_id: orgId() }
  );
  if (assertError) {
    if (assertError.code === "P0002") return json({ error: "Kit not found" }, 404);
    throw assertError;
  }
  // RPC returns a single composite type; supabase-js gives us the row directly.
  const kit = Array.isArray(kitArr) ? kitArr[0] : kitArr;
  if (!kit) return json({ error: "Kit not found" }, 404);

  if (kit.status === "locked") {
    return json({ error: "Kit is locked. Re-open it before capturing." }, 409);
  }

  // Verify the part belongs to this project
  const { data: part, error: partError } = await db
    .from("project_parts")
    .select("part_id, expected")
    .eq("project_id", kit.project_id)
    .eq("part_id", partId)
    .single();

  if (partError || !part) {
    return json({ error: `Part ${partId} is not in this project` }, 400);
  }

  // Resolve the active inference model from the DB (env-var fallback).
  // This is the activation pointer Training Mode updates on completion.
  const activeModel = await getActiveModel(db, orgId());

  // Run detection (mock or Roboflow)
  let result;
  try {
    result = await runDetection(imageBase64, activeModel);
  } catch (error) {
    console.error("Detection failed:", error);
    return json({ error: `Detection failed: ${error.message}` }, 502);
  }

  // Append the immutable audit event first, then upsert the current count.
  const { error: eventError } = await db.from("count_events").insert({
    kit_id: kitId,
    part_id: partId,
    count: result.count,
    confidence: result.confidence,
    mode: result.mode,
    predictions: result.predictions,
  });
  if (eventError) throw eventError;

  const { error: upsertError } = await db
    .from("kit_counts")
    .upsert(
      {
        kit_id: kitId,
        part_id: partId,
        count: result.count,
        confidence: result.confidence,
        mode: result.mode,
        counted_at: new Date().toISOString(),
      },
      { onConflict: "kit_id,part_id" }
    );
  if (upsertError) throw upsertError;

  return json({
    count: result.count,
    confidence: result.confidence,
    mode: result.mode,
    edgeClipped: result.edgeClipped || 0,
    expected: Number(part.expected),
    pass: Number(result.count) === Number(part.expected),
  });
}

async function runDetection(imageBase64, activeModel) {
  const modelUrl = activeModel?.modelUrl || "";
  const useRoboflow =
    getEnv("MOCK_COUNT") !== "true" &&
    modelUrl &&
    getEnv("ROBOFLOW_API_KEY");

  if (!useRoboflow) {
    // Mock returns counts in [1, 10] inclusive. The sample CSV has expecteds
    // up to 33 — adjust the CSV or set MOCK_COUNT=false for real coverage.
    const mockCount = 1 + Math.floor(Math.random() * 10);
    return {
      count: mockCount,
      confidence: 0.99,
      mode: "mock",
      predictions: [],
      edgeClipped: 0,
    };
  }

  const base64 = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");

  // Build URL safely whether the model URL has existing query params or not.
  let url;
  try {
    url = new URL(modelUrl);
  } catch {
    throw new Error("Active model URL is not a valid URL");
  }
  url.searchParams.set("api_key", getEnv("ROBOFLOW_API_KEY"));

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: base64,
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Roboflow returned non-JSON ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(result?.message || `Roboflow returned ${response.status}`);
  }

  const threshold = Number(getEnv("COUNT_CONFIDENCE_THRESHOLD") || 0.65);
  // Boxes within this fraction of the image edge are treated as cut off and
  // dropped from the count. Cropping client-side already eliminates most
  // edge-clipped parts, but if the operator hasn't recomposed and a part is
  // still partly inside the gold frame, this catches it server-side too.
  const edgeMarginRatio = Number(getEnv("COUNT_EDGE_MARGIN_RATIO") || 0.015);

  const predictions = Array.isArray(result.predictions) ? result.predictions : [];

  // Roboflow returns the inference image dimensions on result.image. Without
  // them we can't tell where the edges are, so we skip edge filtering for
  // this prediction set — better to over-count than crash the request.
  const imageWidth = Number(result?.image?.width || 0);
  const imageHeight = Number(result?.image?.height || 0);
  const canFilterEdges = imageWidth > 0 && imageHeight > 0;
  const marginX = canFilterEdges ? imageWidth * edgeMarginRatio : 0;
  const marginY = canFilterEdges ? imageHeight * edgeMarginRatio : 0;

  const accepted = [];
  let edgeClipped = 0;

  for (const p of predictions) {
    if (Number(p.confidence || 0) < threshold) continue;

    if (canFilterEdges) {
      // Roboflow box format: (x, y) is the CENTER of the box.
      const cx = Number(p.x ?? 0);
      const cy = Number(p.y ?? 0);
      const bw = Number(p.width ?? 0);
      const bh = Number(p.height ?? 0);
      const left = cx - bw / 2;
      const top = cy - bh / 2;
      const right = cx + bw / 2;
      const bottom = cy + bh / 2;

      const touchesEdge =
        left <= marginX ||
        top <= marginY ||
        right >= imageWidth - marginX ||
        bottom >= imageHeight - marginY;

      if (touchesEdge) {
        edgeClipped += 1;
        continue;
      }
    }
    accepted.push(p);
  }

  const avgConfidence =
    accepted.length === 0
      ? 0
      : accepted.reduce((sum, p) => sum + Number(p.confidence || 0), 0) /
        accepted.length;

  return {
    count: accepted.length,
    confidence: Number(avgConfidence.toFixed(4)),
    mode: "roboflow",
    predictions: accepted,
    edgeClipped,
  };
}
