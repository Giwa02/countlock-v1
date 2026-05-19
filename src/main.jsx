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

  function showError(message) {
    setError(message);
    if (message) setTimeout(() => setError(""), 6000);
  }

  return (
    <main className="app">
      <Header
        view={view}
        onHome={() => setView({ name: "projects" })}
        onBack={() => {
          if (view.name === "kits") setView({ name: "projects" });
          else if (view.name === "operator")
            setView({ name: "kits", projectId: view.projectId });
        }}
      />

      {error && (
        <div className="alert">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {view.name === "projects" && (
        <ProjectListView
          onOpenProject={(id) => setView({ name: "kits", projectId: id })}
          onError={showError}
        />
      )}

      {view.name === "kits" && (
        <KitListView
          projectId={view.projectId}
          onOpenKit={(kitId) =>
            setView({ name: "operator", projectId: view.projectId, kitId })
          }
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
    </main>
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

function ProjectListView({ onOpenProject, onError }) {
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
// View 2: Kit list within a project
// ───────────────────────────────────────────────────────────────────────────

function KitListView({ projectId, onOpenKit, onError }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState("");

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
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loadError) {
    return (
      <div className="empty">
        <AlertCircle size={28} />
        <p>{loadError}</p>
      </div>
    );
  }
  if (!project) return <div className="empty">Loading project…</div>;

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

      <div className="expected-strip">
        <span className="eyebrow">Expected per part</span>
        <div className="expected-strip-row">
          {project.parts.map((p) => (
            <div className="expected-chip" key={p.part_id}>
              <span>{p.part_id}</span>
              <strong>{p.expected}</strong>
            </div>
          ))}
        </div>
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

createRoot(document.getElementById("root")).render(<App />);
