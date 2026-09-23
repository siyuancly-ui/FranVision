# CLAUDE.md — Feature Sheet Builder

Guidance for Claude Code (and any developer) working in `feature-sheet-builder/`.
This file reflects the **code as it actually is**; where the repo-root
`../FranVision_整体架构总览.md` disagrees, this file wins (per the root
`CLAUDE.md` convention).

---

## 1. What this module is

A **client-facing, no-login web app**. A real-estate agent's client opens a
shareable URL, uploads a batch of property photos, drags them into a **fixed
2-page Feature Sheet template**, adjusts each crop, previews both pages,
confirms, and either exports a print PDF or submits the sheet to the studio.

- A "project" **is** a URL: `?p=<projectId>`. Opening `/` with no `p` creates a
  project and rewrites the address bar. No accounts, no auth.
- One printed piece = one 11×17 in sheet, folded once at the centre → 4 panels.
  "Page 1" = outside spread (back cover | front cover); "Page 2" = inside spread
  (left | right photo panels).
- Standalone today; designed to be **iframe-embedded in the Wix platform** later
  and eventually to **read photos from Dropbox delivery instead of its own
  uploads** (see §9).

---

## 2. How to run locally

```
cd feature-sheet-builder
node server.js            # -> http://localhost:4180
npm test                  # node --test  (78 tests across this module)
```

Or double-click `../Feature Sheet Builder.command` in Finder (starts the server,
opens the browser).

**Which backend the browser uses is decided in `public/js/config.js`, not by the
server:**

| `config.js` state | Backend the browser talks to |
|---|---|
| `supabaseUrl` + `supabaseAnonKey` **set** (current committed state) | **Supabase directly** (production DB + storage). `node server.js` is then just a static file host. |
| those fields **blank** | the local Node API in `server.js`, data under `./data/` (git-ignored) |
| any state, but URL has **`?local=1`** | forces the local Node API even with Supabase creds present — use this for throwaway testing without touching live data |

So `http://localhost:4180/` on a normal checkout hits **production Supabase**.
Add `?local=1` for a safe sandbox.

---

## 3. Architecture at a glance

```
public/                      the entire frontend (no build step; classic <script> tags, ES5-ish)
  index.html                 loads shared modules + CDN libs + app modules, in dependency order
  js/
    config.js                Supabase URL + anon (publishable) key + bucket name
    store.js                 *** the ONLY client<->backend seam *** — 'supabase' | 'local' impls behind one interface
    photo-source.js          *** the ONLY editor<->"where photos come from" seam *** — v1 = this project's uploads
    job-gallery.js           pure helpers for a sheet CONNECTED to a Job: Job-ID validation, which worker-synced photos the picker
                             shows, synced-photo file names. Unit-tested; loaded before store.js
    app.js                   controller: in-memory project, debounced autosave, event bus, ?p= contract
    template-render-v2.js    (template spec + project) -> DOM. Used by editor, preview, export. Single geometry gate.
    editor.js                drag/drop into slots, in-slot pan & zoom
    photo-library.js         upload grid + dropzone + drag source
    photo-picker.js          per-slot "choose a photo" popover
    info-form.js             the only text the client types; writes propertyInfo / agentInfo / colorTheme
    preview.js               full-size read-only 2-page preview
    export-pdf.js            2-page print PDF (admin export + studio submission)
    submit.js                "Confirm & Submit" -> upload PDF -> notify-submission edge fn
    admin.js                 Franky's ?admin=<token> management list + recycle bin
    qr.js / util.js          QR from Online Tour URL; DOM + misc helpers

templates/
  fsb-v2/                    *** the live template system *** (see §5)
    geometry.js              shared frame + page-1-right + all of page 2, as fractions of the 1224x792pt trim
    geometry-estate.js       the "Estate" layout's page 1 (different slot-id namespace)
    themes.js                the 7 selectable themes (palette + background + which layout)
    modules.js               conditional page-1 bands (description present? second agent?)
    layout-engine.js         vertical band reflow for the standard left column
    registry.js              FSB_V2.compose(project) / blankProject() / slotIds() / list()  <- app talks to this
    text-util.js             splitAddress / formatPhone (shared, unit-tested)
    template-render-v2 ...    (renderer lives in public/js, listed above)
  jason-fs-v1/               *** LEGACY / DORMANT *** original single-template system (template-config.js +
                             ../public/js/template-render.js). Still in the tree and still copied by
                             prepare-static.js + referenced by registry.js DEFAULT_ID, but index.html does
                             NOT load template-render.js — nothing in the running app uses jason-fs-v1.
  registry.js               old top-level template registry (jason-fs-v1 only) — legacy, paired with the above

server.js                    zero-dep Node http server: static host + JSON/binary API + image serving + /shared/* + admin routes
storage.js                   persistence interface + LocalDiskStorage (per-project write lock). SupabaseStorage hook exists, unused.
thumbnailer.js               `sips` shell-out for thumbnails/dimensions (local backend, macOS; degrades elsewhere)
crop-math.js                 "photo always covers its slot" pan/zoom clamping — shared browser + Node
prepare-static.js            copies /shared/* and /template-assets/* into public/ for the static Cloudflare deploy
supabase/functions/          two Deno edge functions (see §4)
```

**Two deliberate seams** — everything else is built so these are the only files
that change when the environment changes:

- **`public/js/store.js`** — swap the whole persistence layer (local Node ↔
  Supabase ↔ future Wix) without touching the editor, template, crop math or
  export.
- **`public/js/photo-source.js`** — swap *where the photo list comes from* (this
  project's uploads ↔ a future "Wix Gallery / Dropbox delivery" read-only
  source). The editor, library, renderer, preview and export never read
  `project.photos` or call storage directly; they go through this interface.
  A read-only source just returns `supportsUpload() === false` and the upload
  UI disappears.

---

## 4. Supabase (production backend)

One Postgres table + one storage bucket + two edge functions. Project ref
`papaswihicvajzcubbri`.

- **`public.projects`** — `id text pk`, `data jsonb`, `created_at`, `updated_at`.
  The whole project object lives in `data` (propertyInfo, agentInfo, agentInfo2,
  photos[], pages.slots, colorTheme, confirmed, deletedAt, …). RLS is
  **deliberately wide open** to `anon` (select/insert/update/delete) — no auth is
  in scope; project ids are random 12-hex so not guessable, and there is no
  sensitive data.
- **Storage bucket `photos`** (public) — originals at
  `<projectId>/<photoId>.<ext>`, browser-generated thumbnails at
  `<projectId>/<photoId>_thumb.jpg`, and submission PDFs at
  `submissions/<projectId>.pdf` (reuses this bucket; a dedicated private bucket
  refused anon writes — the path is just never shown in the UI).
- **Edge function `list-projects`** (`supabase/functions/list-projects/index.ts`)
  — powers `admin.js`. Gated by a shared `ADMIN_TOKEN` secret, reads with the
  service role. `view:"trash"` returns the recycle bin. Redeploy on change:
  `supabase functions deploy list-projects --project-ref papaswihicvajzcubbri`.
- **Edge function `notify-submission`**
  (`supabase/functions/notify-submission/index.ts`) — called by `submit.js` after
  the PDF is uploaded; emails the studio via **Resend**. Needs `RESEND_API_KEY`
  in Edge Function Secrets (optional `SUBMIT_TO` / `SUBMIT_FROM` /
  `APP_BASE_URL`). Redeploy on change: `supabase functions deploy
  notify-submission`. Until set up, Confirm & Submit still saves + locks the
  design but the email step errors (agent can retry).

**Connecting a sheet to a Job's Dropbox gallery (2026-09-19).** A sheet keeps its OWN random id/row (its headshot/logo and
everything the FSB owns live there, and Franky's habit of *Duplicate a sheet* keeps working). To use a Job's photos,
Franky (admin link only) types the Job ID (`FVS-YYYYMMDD-NNN`) into the **Job photos** box at the top of the form and
clicks Connect; that stores `jobId` on the sheet (`store.js` `DATA_KEYS`). The Job's own row (id = jobId) belongs to the
photo-sync-worker / delivery-page (`photos[]`, `videos[]`, `address`, `tourUrl`) and the FSB **only reads it**
(`store.getJobGallery`, cached in `photo-source.js`); every FSB write path refuses an `FVS-` id (a whole-blob save would
wipe the worker's keys), and opening `?p=FVS-…` shows an explanatory card instead of a sheet.
- Once connected the picker/library list that Job's `HDR Photos`/`MLS` photos, read-only, in natural filename order
  (`job-gallery.js`). **The editor, preview and picker all use the 1024 `_thumb.jpg`** (the preview keeps its watermark),
  read from the Job's folder in the `photos` bucket; the sheet's own headshot/logo stay under the sheet's folder.
  Nothing larger goes in Supabase on purpose: the 2048 set and the originals are the paid deliverable. Placed photos are
  stored only as ids in `pages.*.slots`. The Job's address fills a blank street-address field on connect.
- Switching to a different Job (or Disconnect) clears the photos placed from the old one (their ids don't exist in the new
  gallery); the agent info / headshot / logo are untouched.
- **PDF export** (admin `?admin=<token>` only) fetches the **true HDR original** of each *placed* photo (not the 2048
  `MLS for download` copy) from the photo-sync-worker's bearer-gated `GET /render/<jobId>/<photoId>`
  (`photo-source.js#preparePrint` -> blob URLs -> renderer `setPrintMode`); the worker streams the file from the photo's
  `HDR Photos`/`MLS` Dropbox path (no fallback to a smaller render). Needs `photoSyncUrl` in `config.js` and the worker
  secret `RENDER_TOKEN` = the FSB admin token. A failed fetch aborts the export (never a soft PDF).
- A **client's** Confirm & Submit on a connected sheet doesn't build/upload a PDF (no token to fetch the originals); it only
  notifies the studio, who exports. `notify-submission` shows the "Download print PDF" button only when the PDF file exists,
  otherwise tells the studio to use the admin link (**redeploy that edge function** after editing it). An admin's submit still
  builds and uploads the PDF.
- Not built: the delivery-page entry point, and the order/payment flow (when it exists, gate `/render` on "paid" too).

**Full one-time SQL schema + RLS policies live in `NOTES.md` §7** — run it once
in the Supabase SQL Editor. That is the authoritative copy; keep it there, not
duplicated here.

**Free-tier limits:** 500 MB DB / 1 GB storage / project pauses after ~1 week
idle. A few dozen sheets of 30–80 photos fills 1 GB — upgrade to Pro when volume
is real.

### Local backend (`server.js` + `storage.js`)

Same feature surface (create / get / update / confirm / photos / soft-delete +
recycle bin / restore / purge / duplicate / clear library / admin list). Stores
under `./data/<projectId>/` (`project.json` + `photos/` + `thumbs/`). Per-project
write lock in `LocalDiskStorage`. Admin routes are gated by `ADMIN_TOKEN` env
(default `dev-admin`). `FSB_STORAGE` / `SupabaseStorage` server-side hook exists
but is unused — the browser goes straight to Supabase instead.

---

## 5. The template system (`fsb-v2`)

`app.js` and the renderer talk to **`FSB_V2` (`templates/fsb-v2/registry.js`)**
only. Key calls: `FSB_V2.compose(project)` → fully resolved render spec;
`FSB_V2.blankProject(themeId)`; `FSB_V2.slotIds(project)` → the slot ids valid
for the project's *current* theme/layout; `FSB_V2.list()` → the selectable
themes.

- Every rect is `[x, y, w, h]` as a **fraction (0–1) of the 1224 × 792 pt trim**.
  The renderer multiplies by the rendered page px size; font points scale by
  `pageWpx / 1224`. Geometry was lifted from the original InDesign/IDML files in
  `../Feature Sheet Template/` via `templates/fsb-v2/tools/idml_parse.py` — **not
  eyeballed**.
- **7 themes, 2 layout families** (`themes.js`):
  - **Standard** — `navy` / `marble` / `burgundy`. Share `geometry.js`. Support a
    second co-listing agent, a bed/bath/garage icon row, and a
    description-present vs. 6-photo-collage left column (chosen automatically from
    what the agent fills in — see `modules.js` + `layout-engine.js`).
  - **Estate ("华邸")** — `estate-navy` / `estate-burgundy` / `estate-emerald` /
    `estate-charcoal`. Marked `layout: 'jason'`, use `geometry-estate.js`, single
    agent only, velvet-artwork background + metal chevron/bar, all-white copy.
- **Page-1 slot id namespaces differ by layout** and this matters:
  - standard page 1: `p1L-1..6` (collage) + `p1R-hero`
  - Estate page 1: `p1-c1..5` (collage) + `p1-hero`
  - **page 2 ids are identical in both** (`p2L-hero`, `p2L-1..4`, `p2R-hero`,
    `p2R-1..4`) — defined once in `geometry.js`, reused by `geometry-estate.js`.
  - `app.js` `migratePage1Slots()` carries photo assignments across the
    standard↔Estate boundary by position when `colorTheme` changes, so switching
    theme never silently drops the agent's picks. `app.slotsUsingPhoto()` counts
    only slots in `FSB_V2.slotIds(project)` so the "used ×N" badge stays honest
    after a switch.
- **16 photo slots total** (6 on page 1, 10 on page 2) + headshot + brokerage
  logo + a QR block. Per-slot state is `{ photoId, positionX, positionY, scale }`.
- Fonts are **self-hosted** in `public/css/app.css` (`@font-face` →
  `public/fonts/*`), not linked from Google Fonts, so the rasterised PDF matches
  the editor exactly.

Adding a theme = one more `theme(...)` entry in `themes.js`. Adding a whole new
layout = a new `geometry-*.js` + a branch in `registry.js` `compose()` +
`template-render-v2.js`.

---

## 6. PDF export

`export-pdf.js`: render each page's DOM at ~4.2× (~300 dpi) → `html-to-image`
JPEG → `jsPDF` page at the **exact trim size** (1224 × 792 pt, landscape, 2
pages). **No bleed, no crop/fold marks** — the PDF is exactly the trim box. A
print-ready path (real 3 mm bleed + vector marks + CMYK + vector text) would
replace `renderPageToDataUrl()`; nothing else changes. Uses CDN libs (`jspdf`,
`html-to-image`, `qrcodejs`) — needs internet on first load. Images come through
`photo-source.js` → the Supabase `photos` bucket; **export never touches
Dropbox** (the "pull HD originals from Dropbox for the PDF" idea in the overview
doc is not built).

---

## 7. Deploy (Cloudflare)

Cloudflare merged Pages into Workers, so this ships as an **assets-only Worker**
(no compute) — `wrangler.jsonc` at the **repo root**, worker name **`franvision`**
(renamed from `feature-sheet-generator` on 2026-09-03 — the name in
`wrangler.jsonc` MUST match the dashboard or deploys silently hit the wrong
worker). `assets.directory` = `feature-sheet-builder/public`.

Live URL: **`https://fs.realgta.ca/`** (Cloudflare Custom Domain bound to the
`franvision` Worker in the dashboard, 2026-09-21 — deliberately NOT in `wrangler.jsonc`, the
auto-build's credentials may not be allowed to edit domains). The old
`franvision.frankystudio-6f3.workers.dev` still works, but is a shared domain Chrome flagged as
unsafe, so give out `fs.realgta.ca` links only.

Two ways to ship:

1. **Auto** — Cloudflare dashboard GitHub App builds on push to `main`.
   Build command: `node feature-sheet-builder/prepare-static.js`. Deploy command:
   `npx wrangler deploy` (default). Verified working (see commits around
   `d5d1877`); typically live within ~30 s of the push.
2. **Manual fallback** — `bash deploy.sh` from the repo root (one-time
   `npx wrangler login`). Runs `prepare-static.js` then `npx wrangler deploy`.

`prepare-static.js` regenerates the **git-ignored** `public/shared/` and
`public/template-assets/` (the files `server.js` serves dynamically in dev) so
the static host has them. Never commit those directories.

**Only push to `main` / deploy with an explicit go-ahead from Franky.**

---

## 8. Conventions / gotchas

- **Zero-dependency Node**, same spirit as `job-generator/` — `server.js`,
  `storage.js`, `thumbnailer.js`, `crop-math.js` use built-ins only. The frontend
  pulls `jspdf` / `html-to-image` / `qrcodejs` / `supabase-js` from CDN in
  `index.html`; there is **no bundler and no `npm install`** (the only dep is
  `node --test` via `npm test`).
- **Real credentials never enter the repo.** `config.js` holds only the Supabase
  URL + **publishable** anon key (safe in client code, gated by RLS). The
  `service_role` key, `ADMIN_TOKEN`, and `RESEND_API_KEY` live only in Supabase
  Edge Function Secrets.
- **A sheet row is created lazily, and only once it holds real content** (`FSB_V2.hasContent`: typed text, a library
  photo, or a placed photo). Opening the bare root URL and only changing the theme leaves NO row (the top bar says
  "Not saved yet"); an explicit Save, a headshot/logo upload and Confirm & Submit force creation. This exists because
  empty drafts kept appearing in Franky's admin list from people just opening the root URL and touching the theme.
  Each new row records where it came from in `data.createdVia` (`root` / `notfound-card` / `admin-new` / `duplicate`)
  and, for root visits, `createdRef` (the referrer's hostname) -- so a stray draft can be traced. `createdVia`/`createdRef`
  are in store.js `DATA_KEYS`, so whole-blob saves keep them.
- **Last-write-wins** on the whole project document — fine for one client at a
  time; two people on the same link can clobber each other. No optimistic
  concurrency yet.
- **The admin page's recycle bin** (`admin.js`): "Delete forever" / "Empty bin" ask for confirmation in an in-app dialog, and
  `store.purgeProject` removes EVERY file under `<id>/` (storage.list caps at 100 per call, so it pages) before deleting the row,
  and refuses to say "done" if the row survived. `util.toast` creates its own container, because the admin page has none --
  before that every admin-page message (errors included) was silently dropped, which made a failed delete look like "nothing
  happened". `emptyTrash` tries every sheet and reports how many failed.
- **Delete is soft** → recycle bin (`deletedAt` in `data`). Permanent purge needs
  the `delete` grant/policy from the `NOTES.md` schema block.
- Confirming a sheet (`confirmed: true`) makes the editor **read-only**; an admin
  (`?admin=<token>`) can re-open it.
- `NOTES.md` = template-fidelity items still pending Franny's confirmation (fonts
  are Google-Fonts approximations of the original faces; a few assets are
  CSS-recreated). `QA-CHECKLIST.md` = manual pass covering every operation.
- Legacy `jason-fs-v1` + `templates/registry.js` + `public/js/template-render.js`
  are dead weight kept for history — don't build on them; `fsb-v2` is the system.

---

## 9. Known future direction (not yet built)

Recorded so nobody mistakes intent for current behaviour:

- **Kill the standalone upload.** End state: the whole platform has **one upload
  entry — Dropbox** — and the Feature Sheet Builder becomes a **read-only
  consumer** of already-delivered photos. The `photo-source.js` seam exists
  precisely for this swap; the editor/template/export don't change.
- **Shared display data.** The Supabase `projects` table / thumbnails are the
  Feature Sheet Builder's own today. The vision is for a future Gallery to read
  the same lightweight display layer.
- **Job ID as the key.** Future projects created from a Job Generator job would
  use that `FVS-YYYYMMDD-XXX` JobID as the `projects.id`. Not wired.
- **HD ↔ selection link.** Idea: each photo carries a `dropboxFileId`; PDF export
  pulls the selected HD originals from Dropbox. **Not implemented** — current
  photo meta is `{ photoId, filename, ext, width, height, hasThumb, bytes,
  uploadedAt, role? }` and export uses the Supabase bucket.
- **OPEN ISSUE — Android phone display is broken (reported 2026-09-21, not yet
  diagnosed).** The editor was built for desktop. On iPhone the overall layout
  is fine; on Android it has "relatively big" problems (exact symptoms unknown —
  the user owes screenshots + phone model + browser). Do NOT guess-fix; get
  screenshots first. Debug via Chrome `chrome://inspect#devices` (USB debugging)
  or serve the local dev server on the LAN (`node server.js`, open
  `http://<mac-ip>:4180` on the phone). What IS fixed (branch `fsb-mobile`,
  merged to `main` 2026-09-21, live at fs.realgta.ca): on `@media (hover: none)`
  devices the hover-only slot tools/Move handle are hidden (they stuck "on" after
  a tap and covered small photos so a tap couldn't open the picker), zoom/reset
  moved into the picker bar, library delete ✕ enlarged, and `pointercancel`
  (browser took a touch scroll) no longer opens the picker. Known remaining
  limits: no vertical one-finger pan of a photo on touch (`touch-action: pan-y`
  so the page can scroll), no two-finger pinch zoom on slots. Desktop behaviour
  is unchanged by design.
- **Admin console** folds into the unified FranVision management system; custom
  domain gets bound. Both are config-level, later.

---

## 10. Keep in sync

When this module changes in a way that affects architecture, backend, deploy, or
the template system, update **this file** and the root `../CLAUDE.md`
`feature-sheet-builder/` bullet. Where a change contradicts
`../FranVision_整体架构总览.md` §3.3 / §4, flag it to Franky for a doc rewrite
(that file records decision background and is allowed to lag, but shouldn't be
left wrong).
