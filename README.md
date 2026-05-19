# CountLock V1

Phone-camera kit count verification, with Supabase persistence and Roboflow detection.

## What this does

An operator opens the app on a tablet/phone with a mounted camera, picks a project, picks a kit, places each part group under the camera, and taps **Picture**. CountLock detects the count, compares against the expected count from the project's CSV, and persists every capture as an immutable audit event. When the operator taps **Finished** the kit is locked. If counts don't match, a supervisor email is sent. Locked kits can be **Re-opened** for re-counting — but counts can only ever come from a camera capture, never from manual entry.

## Version 1 scope

Included:

1. CSV upload → project + kits in Supabase
2. Multi-project (every CSV is a new project, all listed on the home screen)
3. Three-button operator flow: Back · Picture · Finished
4. Camera capture → Roboflow detection → persisted count + immutable audit event
5. Lock kit on Finished, send supervisor email when mismatches or missing parts
6. **Re-open** a locked kit; re-captures append to the audit history rather than overwriting it
7. CSV export of project results
8. Per-org tenant isolation (UPI Manufacturing by default)

Architectural invariant — **counts are camera-only**:

- The frontend has no input field for count values. The only path that writes a count is the camera capture endpoint.
- The `count_events` audit table is enforced as append-only at the database level via a trigger. Every Picture tap is logged forever, even across re-opens.
- All writes go through Netlify functions using a Supabase service role key. The browser never holds the service role.

Not included yet:

1. Authenticated operator login
2. Epicor integration
3. Barcode scanning for kit selection
4. Part recognition (which part is on the mat)
5. Inventory deduction
6. Mixed part counting

## Architecture

```
Browser (operator UI)
    │   GET /api/projects, POST /api/projects, GET /api/projects?id=X
    │   POST /api/count-image     { kitId, partId, imageBase64 }
    │   POST /api/kits            { kitId, action: "finish" | "reopen" }
    ▼
Netlify Functions
    │   service-role Supabase client + Roboflow + Resend
    ▼
Supabase (countlock schema)
    projects → project_parts
            → kits → kit_counts          (current, mutable)
                  → count_events          (append-only, trigger-enforced)
```

## CSV format

```csv
part,1,2,3,4,5,6,7,8,9,10,Review
expected #,3,6,3,6,7,8,3,6,7,33,
Kit 1,,,,,,,,,,,
Kit 2,,,,,,,,,,,
```

Rules:

1. First row has numbered columns (the part-group sequence).
2. Second row starts with `expected #` and contains the target count for each column.
3. Each remaining row is a kit name.
4. Numbered columns represent the count-sequence, not part numbers (yet).
5. The kit row data cells are populated by CountLock as captures happen.

## Local setup

```bash
npm install
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COUNTLOCK_ORG_ID
npm run dev
```

Open http://localhost:8888 (Netlify Dev proxies Vite + functions).

### Required env vars

| Variable | Description |
| --- | --- |
| `SUPABASE_URL` | From Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only — never bundle into the frontend) |
| `COUNTLOCK_ORG_ID` | UUID of `public.orgs.id`. Default = UPI Manufacturing. |
| `MOCK_COUNT` | `true` to skip Roboflow and return random counts (for UI testing) |
| `ROBOFLOW_MODEL_URL` | e.g. `https://detect.roboflow.com/YOUR_PROJECT/YOUR_VERSION` |
| `ROBOFLOW_API_KEY` | Roboflow API key |
| `COUNT_CONFIDENCE_THRESHOLD` | Default `0.65` — predictions below this are dropped |
| `COUNT_EDGE_MARGIN_RATIO` | Default `0.015` — predictions whose bounding box touches within this fraction of the image edge are treated as cut off and dropped from the count |
| `RESEND_API_KEY` | Resend API key |
| `SUPERVISOR_EMAIL` | Recipient for review emails |
| `FROM_EMAIL` | e.g. `CountLock <countlock@yourdomain.com>` |

### Roboflow setup

For local UI testing, leave `MOCK_COUNT=true`. The count-image function returns a random count between 1 and 10 with confidence 0.99.

For real detection:

```text
MOCK_COUNT=false
ROBOFLOW_MODEL_URL=https://detect.roboflow.com/YOUR_PROJECT/YOUR_VERSION
ROBOFLOW_API_KEY=...
COUNT_CONFIDENCE_THRESHOLD=0.65
COUNT_EDGE_MARGIN_RATIO=0.015
```

The Roboflow model must be an object-detection model that draws one bounding box per visible part. The function counts predictions above the confidence threshold and discards any whose box touches the image edge (treated as cut off). The number of dropped boxes is returned to the UI as `edgeClipped` so the operator can be told to recompose.

### Framing guide

The operator screen overlays a gold rectangle on the camera view. Capture crops the frame to this rectangle before upload, so the detection model only ever sees a fixed central region of the operator's shot — keeping the input distribution tight across freehand phone angles.

Training photos uploaded to Roboflow MUST be cropped to the same proportions (`FRAMING_GUIDE` in `src/main.jsx`: x=6%, y=10%, w=88%, h=80%). If the inference crop and training crop drift apart, accuracy drops.

## Re-open semantics

A locked kit can be re-opened from the operator screen. On re-open:

- `kits.status` flips back to `open`
- `kits.reopened_at` is set to now
- `kits.reopen_count` increments
- Existing kit counts are **preserved** (the operator sees what was previously detected)
- Tapping Picture for any part overwrites the row in `kit_counts` and appends a new row to `count_events`
- Tapping Finished re-locks the kit and re-runs the supervisor-email logic

This means the audit log in `count_events` is the authoritative history of every capture, regardless of how many times the kit was re-opened.

## Supabase schema

```
countlock.projects        (id, org_id → public.orgs, name, csv_filename, created_at)
countlock.project_parts   (project_id, part_id, position, expected)
countlock.kits            (id, project_id, name, status, locked_at, reopened_at, reopen_count, review_note)
countlock.kit_counts      (kit_id, part_id, count, confidence, mode, counted_at)  — current state
countlock.count_events    (kit_id, part_id, count, confidence, mode, predictions, created_at)  — append-only
```

### Audit log immutability

`count_events` has a trigger that blocks `UPDATE` and `DELETE`. Explicit archive operations (when a project is intentionally being purged) require setting a session-level escape hatch:

```sql
set local countlock.allow_archive = 'on';
delete from countlock.count_events where ...;
```

The foreign key from `count_events.kit_id` to `kits.id` is `ON DELETE RESTRICT`, so projects with audit history cannot be hard-deleted by accident.

### RLS

Tables in `countlock.*` have RLS enabled. Authenticated users (when login is added) can `SELECT` rows belonging to their org via membership in `public.org_members`. There are no `INSERT/UPDATE/DELETE` policies — only the service role (used by Netlify functions) can write. This is the architectural enforcement that counts only come from the camera pipeline.

## Operator rules

1. One part group at a time.
2. No overlapping pieces.
3. Use a high-contrast counting mat.
4. Fixed phone mount.
5. Tap **Picture** only after parts are spread out.
6. Tap **Finished** only after every part group has been captured.
7. If a count keeps failing, notify the supervisor.

## Deploy to Netlify

1. Push this folder to GitHub.
2. Create a Netlify site from the repo.
3. Add the env vars from `.env.example`.
4. Deploy.

## Test

```bash
npm test
```

Runs CSV parsing tests against the shared `_csv.js` module.

