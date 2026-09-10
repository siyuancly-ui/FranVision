# Job Update — design

Status: **implemented 2026-09-10** (decisions locked same day). Pairs with `CLAUDE.md`
(see the "Job Update" confirmed-decision bullet there for the shipped behavior). This
file is the rationale/spec; `CLAUDE.md` is the source of truth for what the code does.

## Problem

`Create Job` is a one-shot "create a new job" action. Clicking it again for what the
user considers the same job (e.g. after filling in a Shoot Time that was missing the
first time) resolves to the **same folder path** — `sanitize.buildJobFolderName()` is
deterministic from Shoot Date + Address + Client Name — but `idGenerator.getNextJobId()`
and `jobFiles.writeJobFiles()` both re-run, silently assigning a **new Job ID** and
overwriting `job.json` / `Job Info.txt` in place. Found in real use 2026-09-09: looked
like "Job ID 001 vanished" but nothing was deleted — the second click's `job.json`
write overwrote it.

## Fix, in one line

When `Create Job` is clicked and a job folder with the canonical name **already exists
with a readable `job.json`**, treat it as an **update** of that job: keep its existing
Job ID, re-derive everything else.

## Identity key

`Shoot Date + Address + Client Name` — the exact three fields `buildJobFolderName()`
already uses. Client Name = the listing agent (经纪); confirmed with the user
2026-09-10. "Same agent + same property + same day = two separate shoots" is confirmed
**not** a real case, so this key is safe with no manual "save as new job" escape hatch
needed.

## Detection

- New helper `idGenerator.findExistingJob(jobRootFolder, { shootDate, address, clientName })`
  → returns `{ folderName, folderPath, jobId, createdAt }` if a subfolder with the
  canonical name exists and has a readable `job.json` carrying a `jobId`; else `null`.
- `POST /api/plan` (the live folder-preview endpoint) additionally returns
  `matchesExistingJob: "FVS-…" | null` so the UI can relabel the button **before** the
  click.
- `POST /api/create-job` calls the same helper and branches:
  - **match** → update mode (below).
  - **no match** → unchanged: new Job ID via `getNextJobId()`, new folder.
  - **canonical-named folder exists but `job.json` is missing / unreadable** → block
    with a 400: *"A folder named `<name>` already exists but its job.json can't be read
    — resolve it by hand before creating/updating this job."* Do **not** silently write
    a second identity into it — that is the exact bug being fixed.

## Update mode — what it does

Given the matched folder + its existing `jobId` + original `createdAt`:

1. **Job ID unchanged** — `getNextJobId()` is not called. `createdAt` preserved from
   the existing `job.json`; a fresh `updatedAt` is written.
2. **Pricing + commission recomputed server-side** (same "never trust the client" rule
   as creation), `job.json` + `Job Info.txt` rewritten. `pendingConfirmation`
   recomputed as normal.
3. **Price-change surfaced.** The API response carries `previousTotalCents` /
   `totalCents`; when they differ the UI shows *"Total changed: $X → $Y"* in the result
   panel — never silent.
4. **Component folders diffed** against the new selection
   (`folder-builder.getComponentFolders(order)`):
   - **newly required** folders → created (local; Dropbox best-effort).
   - **no longer required** folders → judged **independently on local and on Dropbox**:
     - **empty** — no real file anywhere in its subtree; `.DS_Store`, `~$*` lock files
       and the sync manifest don't count (reuse `file-sync.js#isExcludedName`) → deleted
       on that side.
     - **not empty** → left untouched on that side, and listed in the response as
       *"kept (contains files): …"* so the user sees it.
5. **Calendar file** (`calendar-file.js`) regenerated from the current Shoot Time /
   notes / images / date. So "added a Shoot Time on the second pass" → `Shoot
   Schedule.ics` (at the job-folder root, images embedded as base64 ATTACH — see
   `CLAUDE.md`) now appears. Clearing the Shoot Time on an update deletes it. Same
   validation as today (Shoot Time well-formed; Shoot Date valid whenever Time is given).
6. **Dropbox**: the hidden `jobId` property tag is not touched (the ID didn't change).
   Only folder add / prune, all best-effort — a Dropbox failure never blocks the local
   update, same contract as the rest of `dropbox-sync.js` / `file-sync.js`. Dropbox not
   configured → the local update still fully works.
7. **Idempotent**: running the same update twice is a no-op (folders already match,
   files rewritten identically, calendar regenerated identically).

## Explicitly out of scope (decided 2026-09-10)

- **No "created jobs" list in the UI.** The top panel stays Drafts-only. Update mode is
  entered purely by the 3-field auto-match — leave the form populated (or retype the
  same Shoot Date + Address + Client Name) and the match kicks in.
- **No folder rename when an identity field is edited.** If Shoot Date / Address /
  Client Name changes, the canonical name changes → no match → it is a **brand-new job**
  (new folder, new Job ID). The old folder is orphaned and must be deleted by hand.
  Accepted limitation. (A future nicety could warn "you changed the date/address/client
  — this creates a NEW job, FVS-XXX is left as-is"; not in v1.)
- **No `jobStatus` field, no "mark complete", no undo.**

## Interaction with Job Drafts

Unchanged and complementary:
- **Draft** = before the first real creation — no Job ID, no Dropbox folder.
- **Update** = after a real job exists — adjust it in place.
- Finalizing a draft via `Create Job` still deletes the draft. If that finalize happens
  to match an existing job folder (same 3 fields), it is an **update** of that job — and
  the draft is still deleted afterward.

## Rough implementation surface

| File | Change |
|---|---|
| `id-generator.js` | + `findExistingJob(root, {shootDate,address,clientName})`, reusing the `collectExistingJobIds` folder scan |
| `folder-builder.js` | + `diffComponentFolders(order, existingSubfolders)` → `{ toCreate, toRemove }` (pure); + a "folder has no real files" check (walk + `isExcludedName`) or factor that walk out of `file-sync.js` |
| `calendar-file.js` | + `readExistingImages(jobFolder)` and `mergeImages(preserved, fresh)` — so an update carries a job's already-attached images forward (the update form has no "load existing job" step). `writeCalendarFile` itself unchanged. |
| `dropbox-sync.js` | + "ensure these folders / prune these empty folders on an existing job" path (best-effort) |
| `job-files.js` | `buildJobJson` / `writeJobFiles` unchanged; caller threads the existing `jobId` + `createdAt` through and adds `updatedAt` |
| `server.js` | `/api/plan` returns `matchesExistingJob`; `/api/create-job` branches create vs update; response gains `mode: "created" \| "updated"`, `previousTotalCents`, `foldersAdded`, `foldersRemoved`, `foldersKeptWithFiles` |
| `public/index.html` | button relabels to `Update FVS-…` when `matchesExistingJob`; result panel shows the price delta + folder-change notes |

## Testing

- **Unit**: `findExistingJob` (match / no-match / malformed job.json → blocked);
  `diffComponentFolders`; "empty folder" detection (bare, with `.DS_Store`, nested
  non-empty).
- **Fake Dropbox client**: folder add; empty-prune; non-empty-keep.
- **Real end-to-end**: create a job → re-open the form with the same 3 fields → add a
  Shoot Time and toggle one service → click **Update FVS-…** → confirm: same Job ID;
  `Shoot Info/Shoot Schedule.ics` now present; the newly-checked service's folder
  created on both sides; an unchecked-but-non-empty folder kept + reported; `job.json`
  shows the new price and an `updatedAt`. Clean up the test job (local + real Dropbox)
  afterward, per `CLAUDE.md`'s testing note.
