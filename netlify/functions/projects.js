import { supabase, orgId, json, readJson } from "./_supabase.js";
import { buildProjectFromCsv } from "./_csv.js";

const MAX_CSV_BYTES = 1_000_000; // 1 MB — generous; real CSVs are < 10 KB

export async function handler(event) {
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};

  try {
    if (method === "GET" && params.id) return await getProject(params.id);
    if (method === "GET") return await listProjects();
    if (method === "POST") return await createProject(event);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("projects function failed:", error);
    return json({ error: error.message || "Projects request failed" }, 500);
  }
}

async function listProjects() {
  const db = supabase();
  const { data, error } = await db
    .from("projects")
    .select("id, name, csv_filename, created_at")
    .eq("org_id", orgId())
    .order("created_at", { ascending: false });

  if (error) throw error;

  const ids = data.map((p) => p.id);
  if (ids.length === 0) return json({ projects: [] });

  const { data: kits, error: kitsError } = await db
    .from("kits")
    .select("project_id, status")
    .in("project_id", ids);

  if (kitsError) throw kitsError;

  const summaries = new Map(ids.map((id) => [id, { total: 0, locked: 0 }]));
  for (const kit of kits) {
    const summary = summaries.get(kit.project_id);
    if (!summary) continue;
    summary.total += 1;
    if (kit.status === "locked") summary.locked += 1;
  }

  return json({
    projects: data.map((p) => ({ ...p, kitSummary: summaries.get(p.id) })),
  });
}

async function getProject(id) {
  const db = supabase();

  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, name, csv_filename, created_at, org_id")
    .eq("id", id)
    .eq("org_id", orgId())
    .single();

  if (projectError) {
    if (projectError.code === "PGRST116") return json({ error: "Project not found" }, 404);
    throw projectError;
  }

  // Fetch parts and kits in parallel. Then fetch counts via the kit IDs we
  // already have, no duplicate kits query.
  const [partsRes, kitsRes] = await Promise.all([
    db
      .from("project_parts")
      .select("id, part_id, part_name, position, expected, training_status")
      .eq("project_id", id)
      .order("position"),
    db
      .from("kits")
      .select("id, name, status, locked_at, reopened_at, reopen_count, review_note, created_at")
      .eq("project_id", id)
      .order("created_at"),
  ]);

  if (partsRes.error) throw partsRes.error;
  if (kitsRes.error) throw kitsRes.error;

  const parts = partsRes.data || [];
  const kits = kitsRes.data || [];
  const kitIds = kits.map((k) => k.id);

  let counts = [];
  if (kitIds.length > 0) {
    const { data, error } = await db
      .from("kit_counts")
      .select("kit_id, part_id, count, confidence, mode, counted_at")
      .in("kit_id", kitIds);
    if (error) throw error;
    counts = data || [];
  }

  const countsByKit = new Map();
  for (const c of counts) {
    if (!countsByKit.has(c.kit_id)) countsByKit.set(c.kit_id, {});
    countsByKit.get(c.kit_id)[c.part_id] = {
      count: c.count,
      confidence: c.confidence,
      mode: c.mode,
      countedAt: c.counted_at,
    };
  }

  return json({
    project: {
      ...project,
      parts,
      kits: kits.map((k) => ({ ...k, counts: countsByKit.get(k.id) || {} })),
    },
  });
}

async function createProject(event) {
  const body = readJson(event);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  // Guided wizard path: structured parts with display names. Bypasses the CSV
  // parser (which requires numeric part columns) so parts can be named.
  if (Array.isArray(body.parts) && body.parts.length > 0) {
    return await createProjectStructured(body);
  }

  const { csvText, filename } = body;
  if (!csvText) return json({ error: "csvText is required" }, 400);

  if (typeof csvText !== "string") {
    return json({ error: "csvText must be a string" }, 400);
  }
  if (csvText.length > MAX_CSV_BYTES) {
    return json({ error: `CSV exceeds maximum size of ${MAX_CSV_BYTES} bytes` }, 413);
  }

  const fallbackName = (filename || "Uploaded Project").replace(/\.csv$/i, "");
  let parsed;
  try {
    parsed = buildProjectFromCsv(csvText, fallbackName);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const db = supabase();

  // Atomic create via stored procedure — eliminates the orphaned-project
  // failure mode where parts/kits insert fails after the project insert succeeds.
  const { data: projectId, error: rpcError } = await db.rpc(
    "create_project_atomic",
    {
      p_org_id: orgId(),
      p_name: parsed.name,
      p_csv_filename: filename || null,
      p_parts: parsed.parts.map((p) => ({
        partId: p.partId,
        position: p.position,
        expected: p.expected,
      })),
      p_kit_names: parsed.kitNames,
    }
  );

  if (rpcError) {
    // Surface unique-violation as a friendly 409
    if (rpcError.code === "23505") {
      return json({ error: "A project with that data already exists" }, 409);
    }
    throw rpcError;
  }

  return getProject(projectId);
}

// Slugify a part name into a stable, Roboflow-class-safe identifier.
function slugifyClass(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function createProjectStructured(body) {
  const name = String(body.name || "New Kit").trim() || "New Kit";

  const kitNames =
    Array.isArray(body.kitNames) && body.kitNames.length
      ? body.kitNames.map((k) => String(k).trim()).filter(Boolean)
      : ["Kit 1"];

  // Validate + normalize parts.
  const seen = new Set();
  const parts = [];
  body.parts.forEach((p, i) => {
    const partName = String(p.partName || p.name || "").trim();
    const identifier = String(p.partId || p.identifier || "").trim();
    const partId = slugifyClass(identifier || partName);
    if (!partId) throw new Error(`Part ${i + 1} needs a name or identifier.`);
    if (seen.has(partId)) throw new Error(`Duplicate part identifier "${partId}".`);
    seen.add(partId);

    const expected = Number(p.expected);
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error(`Part "${partName || partId}" needs a whole-number expected count.`);
    }
    parts.push({ partId, partName: partName || partId, position: i + 1, expected });
  });

  if (parts.length === 0) throw new Error("At least one part is required.");

  const db = supabase();

  let projectId;
  try {
    const { data, error } = await db.rpc("create_project_atomic", {
      p_org_id: orgId(),
      p_name: name,
      p_csv_filename: null,
      p_parts: parts.map((p) => ({ partId: p.partId, position: p.position, expected: p.expected })),
      p_kit_names: kitNames,
    });
    if (error) {
      if (error.code === "23505") return json({ error: "A project with that data already exists" }, 409);
      throw error;
    }
    projectId = data;
  } catch (err) {
    return json({ error: err.message || "Could not create project" }, 500);
  }

  // Stamp display names + mark parts untrained (they need training before use).
  for (const p of parts) {
    await db
      .from("project_parts")
      .update({ part_name: p.partName, training_status: "untrained" })
      .eq("project_id", projectId)
      .eq("part_id", p.partId);
  }

  return getProject(projectId);
}
