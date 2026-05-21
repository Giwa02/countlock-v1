import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Camera,
  ArrowLeft,
  CheckCircle2,
  Upload,
  Download,
  Lock,
  Unlock,
  FolderOpen,
  Plus,
  AlertCircle,
  Wand2,
  GraduationCap,
  Trash2,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import "./styles.css";

// ───────────────────────────────────────────────────────────────────────────
// Framing guide
//
// Defines the central region of the camera frame that operators must fit all
// parts inside. We crop the captured frame to this region before upload, so
// the detection model only ever sees a known active zone. This keeps the
// training distribution tight even when operators hold the phone at varying
// angles and distances — anything outside the gold frame is discarded both
// visually (operator sees it dimmed) and in code (cropped away before
// Roboflow ever sees it).
//
// Training photos MUST also be cropped to these same bounds so train and
// inference distributions match.
// ───────────────────────────────────────────────────────────────────────────

const FRAMING_GUIDE = Object.freeze({
  x: 0.06, // left edge, fraction of video width
  y: 0.10, // top edge, fraction of video height
  w: 0.88, // width as fraction of video width
  h: 0.80, // height as fraction of video height
});

function FramingGuide({ bounds }) {
  const style = {
    left: `${bounds.x * 100}%`,
    top: `${bounds.y * 100}%`,
    width: `${bounds.w * 100}%`,
    height: `${bounds.h * 100}%`,
  };
  return (
    <div className="framing-guide" style={style} aria-hidden="true">
      <span className="framing-guide-corner tl" />
      <span className="framing-guide-corner tr" />
      <span className="framing-guide-corner bl" />
      <span className="framing-guide-corner br" />
      <span className="framing-guide-label">Fit all parts inside this frame</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// API helpers
// ───────────────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

const ProjectsApi = {
  list: () => api("/api/projects"),
  get: (id) => api(`/api/projects?id=${encodeURIComponent(id)}`),
  createFromCsv: (csvText, filename) =>
    api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ csvText, filename }),
    }),
};

const KitsApi = {
  finish: (kitId) =>
    api("/api/kits", { method: "POST", body: JSON.stringify({ kitId, action: "finish" }) }),
  reopen: (kitId) =>
    api("/api/kits", { method: "POST", body: JSON.stringify({ kitId, action: "reopen" }) }),
  capture: ({ kitId, partId, imageBase64 }) =>
    api("/api/count-image", {
      method: "POST",
      body: JSON.stringify({ kitId, partId, imageBase64 }),
    }),
};

// ── Supervisor passcode (held in memory only, never persisted) ──────────────
// Training Mode endpoints are gated by SUPERVISOR_PASSCODE. The passcode is
// entered once per session and sent in the x-countlock-supervisor header.
let supervisorPasscode = "";
export function setSupervisorPasscode(v) { supervisorPasscode = v || ""; }
export function hasSupervisorPasscode() { return Boolean(supervisorPasscode); }
function supervisorHeaders() {
  return supervisorPasscode ? { "x-countlock-supervisor": supervisorPasscode } : {};
}

const TrainingApi = {
  getClasses: () => api("/api/roboflow-classes"),
  uploadImage: (payload) =>
    api("/api/upload-training-image", {
      method: "POST",
      headers: supervisorHeaders(),
      body: JSON.stringify(payload),
    }),
  trigger: (projectId) =>
    api("/api/trigger-training", {
      method: "POST",
      headers: supervisorHeaders(),
      body: JSON.stringify({ projectId }),
    }),
  status: ({ jobId, projectId }) => {
    const q = jobId ? `jobId=${encodeURIComponent(jobId)}` : `projectId=${encodeURIComponent(projectId)}`;
    return api(`/api/training-status?${q}`);
  },
  activate: ({ projectId, modelUrl, version, jobId }) =>
    api("/api/activate-model", {
      method: "POST",
      headers: supervisorHeaders(),
      body: JSON.stringify({ projectId, modelUrl, version, jobId }),
    }),
};

const GuidedApi = {
  create: ({ name, parts, kitNames }) =>
    api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, parts, kitNames }),
    }),
};

// ───────────────────────────────────────────────────────────────────────────
// Training Mode — guided capture sequence + in-browser auto-boxing
//
// Each part is captured as 1 background reference + 8 configured shots. The
// background frame powers background-subtraction auto-boxing (robust on any
// mat) AND uploads to Roboflow as a null/background example (cuts false
// positives). Auto-boxing runs entirely in the browser — no server, no
// timeout risk.
// ───────────────────────────────────────────────────────────────────────────

const TRAINING_SHOTS = [
  { key: "background", label: "Empty mat — no parts", hint: "Clear the mat completely. This becomes the reference frame.", expected: 0, isBackground: true },
  { key: "1up",     label: "1 part — face up, centered",          hint: "Single part, right side up.", expected: 1 },
  { key: "1side",   label: "1 part — on its side",                hint: "Tip the same part onto its side.", expected: 1 },
  { key: "2up",     label: "2 parts — both up, spread apart",     hint: "Leave a gap between them.", expected: 2 },
  { key: "2mixed",  label: "2 parts — one up, one on its side",   hint: "Mixed orientation in one frame.", expected: 2 },
  { key: "3up",     label: "3 parts — all up, spread out",        hint: "Three parts, well separated.", expected: 3 },
  { key: "3alt",    label: "3 parts — alternating up / on side",  hint: "Vary each one's orientation.", expected: 3 },
  { key: "3close",  label: "3 parts — close together (not touching)", hint: "Near each other but with visible gaps.", expected: 3 },
  { key: "2flip",   label: "2 parts — flipped to the back face",  hint: "Show the opposite side of the part.", expected: 2 },
];
const PART_SHOT_COUNT = TRAINING_SHOTS.filter((s) => !s.isBackground).length;

// Crop the live video to the framing-guide region into `canvas`.
function cropVideoToCanvas(video, canvas, guide = FRAMING_GUIDE) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const sx = Math.round(vw * guide.x);
  const sy = Math.round(vh * guide.y);
  const sw = Math.round(vw * guide.w);
  const sh = Math.round(vh * guide.h);
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return { width: sw, height: sh };
}

// Downscaled ImageData for fast CV, plus the scale factor back to full res.
function downscaledImageData(srcCanvas, maxW = 360) {
  const scale = Math.min(1, maxW / srcCanvas.width);
  const w = Math.max(1, Math.round(srcCanvas.width * scale));
  const h = Math.max(1, Math.round(srcCanvas.height * scale));
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  return { imageData: ctx.getImageData(0, 0, w, h), scale };
}

// Background subtraction → threshold → connected components → bounding boxes.
// Both ImageData must share dimensions. Returns boxes in that pixel space.
function proposeBoxes(bgData, curData, opts = {}) {
  const threshold = opts.threshold ?? 38;
  const minAreaFrac = opts.minAreaFrac ?? 0.004;
  const w = curData.width;
  const h = curData.height;
  if (!bgData || bgData.width !== w || bgData.height !== h) return [];

  const bg = bgData.data;
  const cur = curData.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const gb = bg[p] * 0.299 + bg[p + 1] * 0.587 + bg[p + 2] * 0.114;
    const gc = cur[p] * 0.299 + cur[p + 1] * 0.587 + cur[p + 2] * 0.114;
    mask[i] = Math.abs(gc - gb) > threshold ? 1 : 0;
  }

  const labels = new Int32Array(w * h);
  const minArea = Math.max(40, Math.floor(w * h * minAreaFrac));
  const stack = [];
  const boxes = [];
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    let minx = w, miny = h, maxx = 0, maxy = 0, area = 0;

    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w;
      const y = (idx - x) / w;
      area += 1;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nidx = ny * w + nx;
          if (mask[nidx] && !labels[nidx]) {
            labels[nidx] = label;
            stack.push(nidx);
          }
        }
      }
    }
    if (area >= minArea) boxes.push({ xmin: minx, ymin: miny, xmax: maxx, ymax: maxy, area });
  }

  boxes.sort((a, b) => b.area - a.area);
  return boxes.slice(0, 20).map(({ xmin, ymin, xmax, ymax }) => ({ xmin, ymin, xmax, ymax }));
}

// ───────────────────────────────────────────────────────────────────────────
// CSV export of kit results
// ───────────────────────────────────────────────────────────────────────────

function exportProjectCsv(project) {
  const headers = ["part", ...project.parts.map((p) => p.part_id), "Review"];
  const expected = ["expected #", ...project.parts.map((p) => p.expected), ""];
  const rows = project.kits.map((kit) => {
    const mismatches = project.parts
      .filter((p) => Number(kit.counts?.[p.part_id]?.count ?? "") !== Number(p.expected))
      .map((p) => p.part_id);
    const review =
      kit.status === "locked"
        ? mismatches.length
          ? `Review ${kit.name} part ${mismatches.join(",")}`
          : "Pass"
        : "Open";
    return [kit.name, ...project.parts.map((p) => kit.counts?.[p.part_id]?.count ?? ""), review];
  });

  const csv = [headers, expected, ...rows]
    .map((row) =>
      row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}-countlock-results.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level routing (no router, just a view enum)
// ───────────────────────────────────────────────────────────────────────────

function App() {
  const [view, setView] = useState({ name: "projects" });
  const [error, setError] = useState("");
  const [passcodePrompt, setPasscodePrompt] = useState(null); // { onUnlock } | null

  function showError(message) {
    setError(message);
    if (message) setTimeout(() => setError(""), 6000);
  }

  // Gate a supervisor action behind the passcode. If already unlocked, runs
  // immediately; otherwise prompts, then runs on success.
  function requireSupervisor(onUnlock) {
    if (hasSupervisorPasscode()) onUnlock();
    else setPasscodePrompt({ onUnlock });
  }

  function backTarget() {
    if (view.name === "kits") return { name: "projects" };
    if (view.name === "operator") return { name: "kits", projectId: view.projectId };
    if (view.name === "setup") return { name: "projects" };
    if (view.name === "training") return { name: "kits", projectId: view.projectId };
    if (view.name === "trainingStatus") return { name: "kits", projectId: view.projectId };
    return { name: "projects" };
  }

  return (
    <main className="app">
      <Header
        view={view}
        onHome={() => setView({ name: "projects" })}
        onBack={() => setView(backTarget())}
      />

      {error && (
        <div className="alert">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {view.name === "projects" && (
        <ProjectListView
          onOpenProject={(id) => setView({ name: "kits", projectId: id })}
          onNewGuided={() => setView({ name: "setup" })}
          onError={showError}
        />
      )}

      {view.name === "setup" && (
        <SetupWizard
          onCreated={(id) => setView({ name: "kits", projectId: id })}
          onCancel={() => setView({ name: "projects" })}
          onError={showError}
        />
      )}

      {view.name === "kits" && (
        <KitListView
          projectId={view.projectId}
          onOpenKit={(kitId) =>
            setView({ name: "operator", projectId: view.projectId, kitId })
          }
          onTrainPart={(part) =>
            requireSupervisor(() =>
              setView({ name: "training", projectId: view.projectId, part })
            )
          }
          onTrainModel={() =>
            requireSupervisor(() =>
              setView({ name: "trainingStatus", projectId: view.projectId, trigger: true })
            )
          }
          onError={showError}
        />
      )}

      {view.name === "training" && (
        <TrainingCaptureView
          projectId={view.projectId}
          part={view.part}
          onDone={() => setView({ name: "kits", projectId: view.projectId })}
          onError={showError}
        />
      )}

      {view.name === "trainingStatus" && (
        <TrainingStatusView
          projectId={view.projectId}
          autoTrigger={Boolean(view.trigger)}
          onError={showError}
        />
      )}

      {view.name === "operator" && (
        <OperatorView
          projectId={view.projectId}
          kitId={view.kitId}
          onBack={() => setView({ name: "kits", projectId: view.projectId })}
          onError={showError}
        />
      )}

      {passcodePrompt && (
        <PasscodeModal
          onUnlock={() => {
            const cb = passcodePrompt.onUnlock;
            setPasscodePrompt(null);
            cb?.();
          }}
          onCancel={() => setPasscodePrompt(null)}
        />
      )}
    </main>
  );
}

// Supervisor passcode prompt — sets the in-memory passcode for the session.
function PasscodeModal({ onUnlock, onCancel }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  function submit() {
    if (!value.trim()) return;
    setSupervisorPasscode(value.trim());
    onUnlock();
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Lock size={18} />
          <h3>Supervisor access</h3>
        </div>
        <p className="muted">Training Mode is supervisor-only. Enter the passcode to continue.</p>
        <input
          ref={inputRef}
          type="password"
          className="text-input"
          placeholder="Supervisor passcode"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!value.trim()}>Unlock</button>
        </div>
      </div>
    </div>
  );
}

function Header({ view, onHome, onBack }) {
  const showBack = view.name !== "projects";
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">📸</span>
        <div>
          <p className="eyebrow">CountLock</p>
          <h1>Tap → Count → Lock</h1>
        </div>
      </div>
      <div className="header-actions">
        {showBack && (
          <button className="ghost" onClick={onBack}>
            <ArrowLeft size={18} /> Back
          </button>
        )}
        {view.name !== "projects" && (
          <button className="ghost" onClick={onHome}>
            <FolderOpen size={18} /> Projects
          </button>
        )}
      </div>
    </header>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// View 1: Project list + CSV upload
// ───────────────────────────────────────────────────────────────────────────

function ProjectListView({ onOpenProject, onNewGuided, onError }) {
  const [projects, setProjects] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  async function reload() {
    try {
      const { projects } = await ProjectsApi.list();
      setProjects(projects);
    } catch (error) {
      onError(error.message);
      setProjects([]);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const csvText = await file.text();
      const { project } = await ProjectsApi.createFromCsv(csvText, file.name);
      onOpenProject(project.id);
    } catch (error) {
      onError(error.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Projects</p>
          <h2>Pick a kit project</h2>
        </div>
        <div className="panel-head-actions">
          <button className="ghost" onClick={onNewGuided}>
            <Wand2 size={18} /> New kit (guided)
          </button>
          <label className="primary" aria-busy={uploading}>
            <Upload size={18} />
            {uploading ? "Uploading…" : "Upload CSV"}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleUpload}
              disabled={uploading}
            />
          </label>
        </div>
      </div>

      {projects === null && <div className="empty">Loading projects…</div>}

      {projects?.length === 0 && (
        <div className="empty">
          <Plus size={28} />
          <p>No projects yet. Upload a CSV to get started.</p>
        </div>
      )}

      {projects?.length > 0 && (
        <ul className="project-grid">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                className="project-card"
                onClick={() => onOpenProject(project.id)}
              >
                <div className="project-card-name">{project.name}</div>
                <div className="project-card-meta">
                  <span>
                    {project.kitSummary?.total ?? 0} kit
                    {project.kitSummary?.total === 1 ? "" : "s"}
                  </span>
                  <span className="dot" aria-hidden="true">·</span>
                  <span>
                    {project.kitSummary?.locked ?? 0} locked
                  </span>
                </div>
                <div className="project-card-date">
                  {new Date(project.created_at).toLocaleString()}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Guided setup wizard — name a kit, then add parts one at a time
// ───────────────────────────────────────────────────────────────────────────

function SetupWizard({ onCreated, onCancel, onError }) {
  const [kitName, setKitName] = useState("");
  const [parts, setParts] = useState([]); // { partName, identifier, expected }
  const [pName, setPName] = useState("");
  const [pId, setPId] = useState("");
  const [pExpected, setPExpected] = useState("");
  const [creating, setCreating] = useState(false);
  const nameRef = useRef(null);

  function addPart() {
    const name = pName.trim();
    const expected = Number(pExpected);
    if (!name) return;
    if (!Number.isInteger(expected) || expected < 0) {
      onError("Expected count must be a whole number (0 or more).");
      return;
    }
    setParts((prev) => [...prev, { partName: name, identifier: pId.trim(), expected }]);
    setPName("");
    setPId("");
    setPExpected("");
    nameRef.current?.focus();
  }

  function removePart(i) {
    setParts((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function create() {
    if (!kitName.trim()) { onError("Give the kit a name."); return; }
    if (parts.length === 0) { onError("Add at least one part."); return; }
    setCreating(true);
    try {
      const { project } = await GuidedApi.create({
        name: kitName.trim(),
        kitNames: [kitName.trim()],
        parts: parts.map((p) => ({
          partName: p.partName,
          partId: p.identifier || p.partName,
          expected: p.expected,
        })),
      });
      onCreated(project.id);
    } catch (err) {
      onError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">New kit</p>
          <h2>Set up a kit step by step</h2>
        </div>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>

      <label className="field">
        <span className="field-label">Kit name</span>
        <input
          className="text-input"
          placeholder="e.g. Pump Assembly A"
          value={kitName}
          onChange={(e) => setKitName(e.target.value)}
        />
      </label>

      <div className="wizard-parts">
        <p className="eyebrow">Parts in this kit</p>
        {parts.length === 0 && <p className="muted">No parts yet — add your first part below.</p>}
        {parts.length > 0 && (
          <ul className="wizard-part-list">
            {parts.map((p, i) => (
              <li key={i} className="wizard-part-row">
                <div>
                  <strong>{p.partName}</strong>
                  {p.identifier && <span className="muted"> · {p.identifier}</span>}
                </div>
                <div className="wizard-part-right">
                  <span className="expected-pill">× {p.expected}</span>
                  <button className="icon-btn" onClick={() => removePart(i)} aria-label="Remove part">
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="wizard-add">
          <input
            ref={nameRef}
            className="text-input"
            placeholder="Part name (e.g. Left Bracket)"
            value={pName}
            onChange={(e) => setPName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPart()}
          />
          <input
            className="text-input"
            placeholder="Part # / ID (optional)"
            value={pId}
            onChange={(e) => setPId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPart()}
          />
          <input
            className="text-input narrow"
            type="number"
            min="0"
            placeholder="Qty"
            value={pExpected}
            onChange={(e) => setPExpected(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPart()}
          />
          <button className="ghost" onClick={addPart}>
            <Plus size={16} /> Add part
          </button>
        </div>
      </div>

      <div className="wizard-footer">
        <p className="muted">
          {parts.length} part{parts.length === 1 ? "" : "s"} · new parts will need training before counting
        </p>
        <button className="primary" onClick={create} disabled={creating || !parts.length || !kitName.trim()}>
          {creating ? "Creating…" : "Create kit"}
        </button>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// View 2: Kit list within a project
// ───────────────────────────────────────────────────────────────────────────

function KitListView({ projectId, onOpenKit, onTrainPart, onTrainModel, onError }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [trainedClasses, setTrainedClasses] = useState(null); // Set | null

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { project } = await ProjectsApi.get(projectId);
        if (!cancelled) setProject(project);
      } catch (error) {
        if (cancelled) return;
        onError(error.message);
        setLoadError(error.message || "Failed to load project");
      }
      // Class list is best-effort — never block the view on it.
      try {
        const { classes } = await TrainingApi.getClasses();
        if (!cancelled) setTrainedClasses(new Set((classes || []).map((c) => String(c).toLowerCase())));
      } catch {
        if (!cancelled) setTrainedClasses(new Set());
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // A part is trained if the live model knows its class, or its workflow
  // state already says trained. Otherwise it carries its workflow state.
  function partStatus(p) {
    const known = trainedClasses?.has(String(p.part_id).toLowerCase());
    if (known || p.training_status === "trained") return "trained";
    return p.training_status || "untrained";
  }

  if (loadError) {
    return (
      <div className="empty">
        <AlertCircle size={28} />
        <p>{loadError}</p>
      </div>
    );
  }
  if (!project) return <div className="empty">Loading project…</div>;

  const statuses = project.parts.map(partStatus);
  const untrainedCount = statuses.filter((s) => s !== "trained").length;
  const readyToTrain = statuses.some((s) => s === "images_captured" || s === "training");

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Project</p>
          <h2>{project.name}</h2>
        </div>
        <button className="ghost" onClick={() => exportProjectCsv(project)}>
          <Download size={18} /> Export
        </button>
      </div>

      {untrainedCount > 0 && (
        <div className="train-banner">
          <div>
            <GraduationCap size={18} />
            <span>
              <strong>{untrainedCount} part{untrainedCount === 1 ? "" : "s"}</strong> need training before this kit can count reliably.
            </span>
          </div>
          {readyToTrain && (
            <button className="primary small" onClick={onTrainModel}>
              Train model →
            </button>
          )}
        </div>
      )}

      <div className="parts-panel">
        <span className="eyebrow">Parts</span>
        <ul className="parts-list">
          {project.parts.map((p) => {
            const status = partStatus(p);
            return (
              <li className="parts-row" key={p.part_id}>
                <div className="parts-row-main">
                  <strong>{p.part_name || p.part_id}</strong>
                  <span className="muted">× {p.expected}</span>
                  <TrainPill status={status} />
                </div>
                {status !== "trained" && (
                  <button className="ghost small" onClick={() => onTrainPart(p)}>
                    <Camera size={15} /> {status === "untrained" ? "Train part" : "Add photos"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ul className="kit-list">
        {project.kits.map((kit) => {
          const completed = project.parts.filter((p) => kit.counts?.[p.part_id]).length;
          return (
            <li key={kit.id}>
              <button className="kit-row" onClick={() => onOpenKit(kit.id)}>
                <div className="kit-row-head">
                  <strong>{kit.name}</strong>
                  <KitStatusBadge kit={kit} />
                </div>
                <div className="kit-row-meta">
                  {completed}/{project.parts.length} counted
                  {kit.reopen_count > 0 && (
                    <span className="muted"> · re-opened {kit.reopen_count}×</span>
                  )}
                  {kit.review_note && kit.status === "locked" && (
                    <span className="review-note"> · {kit.review_note}</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TrainPill({ status }) {
  const map = {
    trained: { cls: "pill-trained", label: "Trained" },
    untrained: { cls: "pill-untrained", label: "Needs training" },
    images_captured: { cls: "pill-captured", label: "Images captured" },
    training: { cls: "pill-training", label: "Training…" },
  };
  const s = map[status] || map.untrained;
  return <span className={`train-pill ${s.cls}`}>{s.label}</span>;
}

function KitStatusBadge({ kit }) {
  if (kit.status === "locked") {
    return (
      <span className="badge badge-locked">
        <Lock size={12} /> Locked
      </span>
    );
  }
  return <span className="badge badge-open">Open</span>;
}

// ───────────────────────────────────────────────────────────────────────────
// View 3: Operator screen — camera + capture + finish/reopen
// ───────────────────────────────────────────────────────────────────────────

function OperatorView({ projectId, kitId, onBack, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [partIndex, setPartIndex] = useState(0);
  const [status, setStatus] = useState("Loading kit…");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [videoAspect, setVideoAspect] = useState(null);
  const [isCounting, setIsCounting] = useState(false);
  const [busy, setBusy] = useState(false);

  const kit = useMemo(
    () => project?.kits.find((k) => k.id === kitId) || null,
    [project, kitId]
  );

  const currentPart = project?.parts[partIndex] || null;
  const currentCount =
    kit && currentPart ? kit.counts?.[currentPart.part_id] : null;

  // Load project + kit
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { project } = await ProjectsApi.get(projectId);
        if (cancelled) return;
        setProject(project);

        const found = project.kits.find((k) => k.id === kitId);
        if (!found) {
          setLoadError("Kit not found in this project. Go back to the kit list.");
        } else if (found.status === "locked") {
          setStatus(`Kit locked. Tap Re-open to re-take any part.`);
        } else {
          setStatus("Place all parts for the first group inside the gold frame, then tap Picture.");
        }
      } catch (error) {
        if (cancelled) return;
        onError(error.message);
        setLoadError(error.message || "Failed to load kit");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId, kitId]);

  // Camera lifecycle. The cancellation flag protects against the race where
  // the component unmounts before getUserMedia resolves — without it, the
  // stream gets attached to a stale ref and is never stopped, leaking the
  // camera light/track until the tab is closed.
  useEffect(() => {
    let stream = null;
    let cancelled = false;

    async function startCamera() {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          // Component unmounted while we were waiting; stop the stream now
          // since the cleanup function already ran with stream === null.
          acquired.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = acquired;
        if (videoRef.current) {
          const v = videoRef.current;
          v.srcObject = stream;
          const onMeta = () => {
            if (cancelled) return;
            if (v.videoWidth && v.videoHeight) {
              setVideoAspect(v.videoWidth / v.videoHeight);
            }
            setCameraReady(true);
          };
          // If metadata is already loaded (rare but possible if browser
          // attached the track synchronously), the loadedmetadata event won't
          // fire again. Detect that case via readyState.
          if (v.readyState >= 1) {
            onMeta();
          } else {
            v.onloadedmetadata = onMeta;
          }
        }
      } catch (error) {
        if (!cancelled) setCameraError(`Camera unavailable: ${error.message}`);
      }
    }

    startCamera();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function refreshProject() {
    const { project } = await ProjectsApi.get(projectId);
    setProject(project);
  }

  async function captureAndCount() {
    if (!videoRef.current || !canvasRef.current || !kit || !currentPart) return;
    if (kit.status === "locked") {
      setStatus("Kit is locked. Re-open before capturing.");
      return;
    }

    setIsCounting(true);
    const video = videoRef.current;
    const canvas = canvasRef.current;
    // Use real intrinsic dimensions if available; fall back only if metadata
    // hasn't loaded yet. Falling back risks an empty draw (videoWidth=0) so
    // we bail out cleanly instead.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      setStatus("Camera not ready yet. Try again in a second.");
      setIsCounting(false);
      return;
    }

    // Crop to the framing guide region. The detector only sees this central
    // patch, matching the cropped training distribution. Anything that wasn't
    // inside the gold frame on screen is dropped here.
    const sx = Math.round(vw * FRAMING_GUIDE.x);
    const sy = Math.round(vh * FRAMING_GUIDE.y);
    const sw = Math.round(vw * FRAMING_GUIDE.w);
    const sh = Math.round(vh * FRAMING_GUIDE.h);

    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.82);

    try {
      const result = await KitsApi.capture({
        kitId,
        partId: currentPart.part_id,
        imageBase64,
      });

      const clipped = Number(result.edgeClipped || 0);
      const verdict = result.pass ? "PASS" : "MISMATCH";
      const base = `Detected ${result.count} · Expected ${result.expected} · ${verdict}`;
      const clipNote =
        clipped > 0
          ? ` · ${clipped} part${clipped === 1 ? "" : "s"} cut off at edge — recompose inside the gold frame and retake`
          : "";
      setStatus(base + clipNote);

      await refreshProject();

      // Auto-advance only on a clean pass with no edge clipping.
      if (result.pass && clipped === 0 && partIndex < project.parts.length - 1) {
        setPartIndex((value) => value + 1);
      }
    } catch (error) {
      onError(error.message);
      setStatus(error.message);
    } finally {
      setIsCounting(false);
    }
  }

  async function finishKit() {
    if (!kit) return;
    setBusy(true);
    try {
      const result = await KitsApi.finish(kitId);
      await refreshProject();
      if (result.mismatches?.length || result.incompleteParts?.length) {
        const note = [];
        if (result.mismatches?.length) note.push(`${result.mismatches.length} mismatch(es)`);
        if (result.incompleteParts?.length)
          note.push(`${result.incompleteParts.length} missing part(s)`);
        setStatus(
          `Locked with review needed: ${note.join(", ")}.${
            result.email?.sent ? " Supervisor emailed." : ""
          }`
        );
      } else {
        setStatus("Locked. All counts pass.");
      }
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function reopenKit() {
    if (!kit) return;
    setBusy(true);
    try {
      await KitsApi.reopen(kitId);
      await refreshProject();
      setStatus("Re-opened. Re-take any part by tapping Picture.");
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    setPartIndex((value) => Math.max(0, value - 1));
  }

  function jumpToPart(index) {
    setPartIndex(index);
  }

  if (loadError) {
    return (
      <div className="empty">
        <AlertCircle size={28} />
        <p>{loadError}</p>
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={18} /> Back to kit list
        </button>
      </div>
    );
  }

  if (!project || !kit) {
    return <div className="empty">Loading…</div>;
  }

  const isLocked = kit.status === "locked";
  const completed = project.parts.filter((p) => kit.counts?.[p.part_id]).length;

  return (
    <section className="panel operator">
      <div className="kit-header">
        <div>
          <p className="eyebrow">{project.name}</p>
          <h2>
            {kit.name} <KitStatusBadge kit={kit} />
          </h2>
        </div>
        <div className="kit-progress">
          {completed} / {project.parts.length} counted
          {kit.reopen_count > 0 && (
            <span className="muted"> · re-opened {kit.reopen_count}×</span>
          )}
        </div>
      </div>

      <div className="part-strip">
        {project.parts.map((p, i) => {
          const c = kit.counts?.[p.part_id];
          const isMismatch = c && Number(c.count) !== Number(p.expected);
          const isCurrent = i === partIndex;
          return (
            <button
              key={p.part_id}
              className={
                "part-pill" +
                (isCurrent ? " is-current" : "") +
                (c ? (isMismatch ? " is-mismatch" : " is-pass") : "")
              }
              onClick={() => jumpToPart(i)}
              title={`Part ${p.part_id} · expected ${p.expected}`}
            >
              <span className="part-pill-id">{p.part_id}</span>
              <span className="part-pill-count">{c?.count ?? "—"}</span>
            </button>
          );
        })}
      </div>

      <div className="part-status">
        <div>
          <p className="eyebrow">Current part group</p>
          <h3>{currentPart ? `Part ${currentPart.part_id}` : "—"}</h3>
        </div>
        <div className="count-box">
          <span>Expected</span>
          <strong>{currentPart?.expected ?? "—"}</strong>
        </div>
        <div className="count-box">
          <span>Detected</span>
          <strong>{currentCount?.count ?? "—"}</strong>
        </div>
      </div>

      <div
        className="camera-wrap"
        style={videoAspect ? { aspectRatio: videoAspect } : undefined}
      >
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} hidden />
        {cameraReady && !isLocked && <FramingGuide bounds={FRAMING_GUIDE} />}
        {!cameraReady && (
          <div className="camera-placeholder">
            {cameraError || "Waiting for camera…"}
          </div>
        )}
        {isLocked && (
          <div className="camera-overlay-locked">
            <Lock size={32} /> <span>Kit locked</span>
          </div>
        )}
      </div>

      <div className="status">{status}</div>

      <div className="buttons">
        <button onClick={goBack} disabled={partIndex === 0}>
          <ArrowLeft size={22} /> Back
        </button>

        {isLocked ? (
          <button className="primary reopen" onClick={reopenKit} disabled={busy}>
            <Unlock size={26} /> {busy ? "Re-opening…" : "Re-open"}
          </button>
        ) : (
          <button
            className="primary"
            onClick={captureAndCount}
            disabled={isCounting || !cameraReady}
          >
            <Camera size={26} /> {isCounting ? "Counting…" : "Picture"}
          </button>
        )}

        <button
          className="finish"
          onClick={finishKit}
          disabled={busy || isLocked}
        >
          <CheckCircle2 size={22} /> Finished
        </button>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Training Mode: guided capture with background-subtraction auto-boxing
// ───────────────────────────────────────────────────────────────────────────

function TrainingCaptureView({ projectId, part, onDone, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const bgImageDataRef = useRef(null); // downscaled background ImageData
  const lastShotRef = useRef(null);    // { canvas, width, height, scale } pending confirm

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [videoAspect, setVideoAspect] = useState(null);
  const [shotIndex, setShotIndex] = useState(0);     // index into TRAINING_SHOTS
  const [doneShots, setDoneShots] = useState({});    // key -> true
  const [preview, setPreview] = useState(null);       // { dataUrl, boxes, width, height, scale }
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const shot = TRAINING_SHOTS[shotIndex] || null;
  const partLabel = part?.part_name || part?.part_id || "part";

  // Camera lifecycle (same pattern as the operator screen).
  useEffect(() => {
    let stream = null;
    let cancelled = false;
    (async () => {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" }, audio: false,
        });
        if (cancelled) { acquired.getTracks().forEach((t) => t.stop()); return; }
        stream = acquired;
        if (videoRef.current) {
          const v = videoRef.current;
          v.srcObject = stream;
          const onMeta = () => {
            if (cancelled) return;
            if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight);
            setCameraReady(true);
          };
          if (v.readyState >= 1) onMeta(); else v.onloadedmetadata = onMeta;
        }
      } catch (e) {
        if (!cancelled) setCameraError(`Camera unavailable: ${e.message}`);
      }
    })();
    return () => { cancelled = true; if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, []);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !shot) return;
    const dims = cropVideoToCanvas(video, canvas);
    if (!dims) { setStatus("Camera not ready yet."); return; }

    const down = downscaledImageData(canvas);

    if (shot.isBackground) {
      // Store the reference frame; nothing to box.
      bgImageDataRef.current = down.imageData;
      lastShotRef.current = { canvas: cloneCanvas(canvas), width: dims.width, height: dims.height, scale: down.scale };
      setPreview({ dataUrl: canvas.toDataURL("image/jpeg", 0.82), boxes: [], width: dims.width, height: dims.height, scale: down.scale, isBackground: true });
      setStatus("Reference captured. Confirm to continue.");
      return;
    }

    if (!bgImageDataRef.current) {
      setStatus("Capture the empty-mat reference first.");
      return;
    }

    // Auto-box against the background reference.
    const downBoxes = proposeBoxes(bgImageDataRef.current, down.imageData);
    // Scale boxes from downscaled coords to full-res image coords.
    const inv = 1 / down.scale;
    const boxes = downBoxes.map((b) => ({
      xmin: Math.round(b.xmin * inv), ymin: Math.round(b.ymin * inv),
      xmax: Math.round(b.xmax * inv), ymax: Math.round(b.ymax * inv),
    }));
    lastShotRef.current = { canvas: cloneCanvas(canvas), width: dims.width, height: dims.height, scale: down.scale };
    setPreview({ dataUrl: canvas.toDataURL("image/jpeg", 0.82), boxes, width: dims.width, height: dims.height });

    const expected = shot.expected;
    if (boxes.length === expected) setStatus(`Found ${boxes.length} — matches the ${expected} expected. Confirm or retake.`);
    else setStatus(`Found ${boxes.length}, expected ${expected}. Tap a box to delete a false one, or retake.`);
  }

  function removeBox(i) {
    setPreview((prev) => prev ? { ...prev, boxes: prev.boxes.filter((_, idx) => idx !== i) } : prev);
  }

  function retake() {
    setPreview(null);
    setStatus("");
  }

  async function confirmShot() {
    if (!preview || !shot) return;
    setBusy(true);
    setStatus("Uploading…");
    try {
      await TrainingApi.uploadImage({
        partId: part.id,
        imageBase64: preview.dataUrl,
        width: preview.width,
        height: preview.height,
        boxes: preview.boxes,
        configLabel: shot.key,
        isBackground: Boolean(shot.isBackground),
        // Any labeled (non-background) shot promotes untrained → images_captured;
        // the backend guard prevents regressing a trained/training part.
        markImagesCaptured: !shot.isBackground,
      });
      setDoneShots((prev) => ({ ...prev, [shot.key]: true }));
      setPreview(null);
      setStatus("");
      // Advance to the next shot.
      if (shotIndex < TRAINING_SHOTS.length - 1) setShotIndex(shotIndex + 1);
    } catch (err) {
      onError(err.message);
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  const partShotsDone = TRAINING_SHOTS.filter((s) => !s.isBackground && doneShots[s.key]).length;
  const allDone = partShotsDone >= PART_SHOT_COUNT;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Train · {partLabel}</p>
          <h2>{shot ? shot.label : "All shots captured"}</h2>
        </div>
        <span className="muted">{partShotsDone}/{PART_SHOT_COUNT} shots</span>
      </div>

      {shot && <p className="shot-hint">{shot.hint}</p>}

      <div
        className="camera-wrap"
        style={videoAspect ? { aspectRatio: videoAspect } : undefined}
      >
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} hidden />
        {cameraReady && !preview && <FramingGuide bounds={FRAMING_GUIDE} />}
        {!cameraReady && (
          <div className="camera-placeholder">{cameraError || "Waiting for camera…"}</div>
        )}
        {preview && (
          <div className="preview-overlay">
            <img src={preview.dataUrl} alt="capture preview" className="preview-img" />
            <svg className="preview-boxes" viewBox={`0 0 ${preview.width} ${preview.height}`} preserveAspectRatio="none">
              {preview.boxes.map((b, i) => (
                <g key={i} onClick={() => removeBox(i)} style={{ cursor: "pointer" }}>
                  <rect x={b.xmin} y={b.ymin} width={b.xmax - b.xmin} height={b.ymax - b.ymin}
                    fill="rgba(184,149,56,0.15)" stroke="#b89538" strokeWidth="3" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </svg>
          </div>
        )}
      </div>

      {status && <div className="status">{status}</div>}

      <div className="shot-strip">
        {TRAINING_SHOTS.filter((s) => !s.isBackground).map((s, i) => (
          <span key={s.key}
            className={`shot-dot ${doneShots[s.key] ? "done" : ""} ${shot && shot.key === s.key ? "active" : ""}`}
            title={s.label}>{i + 1}</span>
        ))}
      </div>

      <div className="actions">
        {!preview && shot && (
          <button className="snap" onClick={capture} disabled={!cameraReady || busy}>
            <Camera size={26} /> {shot.isBackground ? "Capture reference" : "Capture"}
          </button>
        )}
        {preview && (
          <>
            <button className="ghost" onClick={retake} disabled={busy}>
              <RefreshCw size={18} /> Retake
            </button>
            <button className="snap" onClick={confirmShot} disabled={busy}>
              <CheckCircle2 size={22} /> {busy ? "Uploading…" : preview.isBackground ? "Use reference" : `Confirm ${preview.boxes.length}`}
            </button>
          </>
        )}
        <button className="finish" onClick={onDone} disabled={busy}>
          {allDone ? <><CheckCircle2 size={22} /> Done with this part</> : "Save & exit"}
        </button>
      </div>
    </section>
  );
}

function cloneCanvas(src) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

// ───────────────────────────────────────────────────────────────────────────
// Training Mode: trigger + status + activate
// ───────────────────────────────────────────────────────────────────────────

function TrainingStatusView({ projectId, autoTrigger, onError }) {
  const [job, setJob] = useState(null);
  const [roboflow, setRoboflow] = useState(null);
  const [deepLink, setDeepLink] = useState("");
  const [modelUrl, setModelUrl] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Kick off training once on mount if requested.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (autoTrigger) {
        try {
          const res = await TrainingApi.trigger(projectId);
          if (cancelled) return;
          setDeepLink(res.deepLink || "");
          setMsg(res.message || "");
        } catch (err) {
          if (!cancelled) onError(err.message);
        }
      }
      poll();
    })();
    const id = setInterval(poll, 30000); // spec: poll every 30s
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function poll() {
    try {
      const res = await TrainingApi.status({ projectId });
      setJob(res.job || null);
      setRoboflow(res.roboflow || null);
    } catch {
      /* best-effort */
    }
  }

  async function activate() {
    if (!modelUrl.trim()) { onError("Paste the model URL from Roboflow's Deploy page."); return; }
    setBusy(true);
    try {
      await TrainingApi.activate({
        projectId,
        modelUrl: modelUrl.trim(),
        version: Number(version) || undefined,
        jobId: job?.id,
      });
      setMsg("Model activated. New parts will now count.");
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Training</p>
          <h2>Train & activate model</h2>
        </div>
        <button className="ghost small" onClick={poll}><RefreshCw size={16} /> Refresh</button>
      </div>

      {msg && <div className="train-banner"><div><GraduationCap size={18} /><span>{msg}</span></div></div>}

      <ol className="train-steps">
        <li>
          <strong>1. Labeled images uploaded</strong>
          <p className="muted">Your captured shots are in the Roboflow dataset, fully labeled.</p>
        </li>
        <li>
          <strong>2. Train the model</strong>
          <p className="muted">
            The first Instant model trains automatically. For a retrain, open Roboflow,
            click <em>Train Model</em>, then come back here.
          </p>
          {deepLink && (
            <a className="ghost small" href={deepLink} target="_blank" rel="noreferrer">
              <ExternalLink size={15} /> Open Roboflow training
            </a>
          )}
          {roboflow && (
            <p className="muted">
              Latest version on Roboflow: {roboflow.latestVersion ?? "—"}
              {roboflow.ready ? " · model ready" : " · not ready yet"}
            </p>
          )}
        </li>
        <li>
          <strong>3. Activate it in CountLock</strong>
          <p className="muted">
            On Roboflow's <em>Deploy</em> page, copy the model's inference URL and paste it here.
            This points the live counter at the new model — no redeploy.
          </p>
          <div className="activate-row">
            <input className="text-input" placeholder="https://detect.roboflow.com/countlock/2  (or serverless.roboflow.com/…)"
              value={modelUrl} onChange={(e) => setModelUrl(e.target.value)} />
            <input className="text-input narrow" placeholder="Ver" value={version}
              onChange={(e) => setVersion(e.target.value)} />
            <button className="primary" onClick={activate} disabled={busy || !modelUrl.trim()}>
              {busy ? "Activating…" : "Activate"}
            </button>
          </div>
        </li>
      </ol>

      {job && (
        <p className="muted small">
          Job {job.id.slice(0, 8)} · {job.status}{job.completed_at ? ` · done ${new Date(job.completed_at).toLocaleString()}` : ""}
        </p>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
