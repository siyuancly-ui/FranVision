# FranVision Photo Sync Worker

A standalone Cloudflare Worker that mirrors **compressed thumbnails** of the
photos in Dropbox job folders into Supabase, so the FranVision **Gallery**
and **Feature Sheet Builder** can display and pick from them without touching
Dropbox directly.

- The originals stay in Dropbox and remain the only archive. Each synced
  photo record stores `dropboxFileId` pointing back to the high-res file for
  the print/PDF path.
- Supabase here is a **display cache + index**. Wiping Supabase Storage loses
  nothing permanent — re-run the backfill and every thumbnail regenerates.

Full design + rationale: [`DESIGN.md`](./DESIGN.md).

---

## How it works

```
Dropbox change ──webhook──▶  POST /webhook  ──enqueue {type:"delta"}──▶ Queue
Cron (every 2 min) ─────────────────────────enqueue {type:"delta"}────▶ Queue
                                                                         │
                                                            ┌────────────┴───────────┐
                                                            ▼                        ▼
                                                     delta message           photo-batch message
                                          (lease-locked; pull list_folder    (per job: get_thumbnail_batch
                                           delta, collapse, filter to         → Supabase Storage + projects
                                           SYNC_FOLDERS, resolve jobId,        row via photos_upsert; for MLS
                                           fan out photo-batch msgs,           also write a compressed copy
                                           advance cursor)                     back to "MLS for download/")
```

- **`SYNC_FOLDERS`** (`MLS, Virtual Staging, Floorplan, Local Report`): only
  images (`.jpg/.jpeg/.png/.webp`) under these sub-folders of a job folder
  are mirrored. `0 RAW`, `Home Report`, videos, PDFs, etc. are ignored.
- **`DOWNLOAD_SET_FOLDERS`** (`MLS`): these also get the 1024px JPEG written
  back into Dropbox at `<job>/MLS for download/<name>.jpg` as a downloadable
  delivery set. The same compressed bytes are reused — one compression.
- **Self-heal**: a Dropbox-side delete flags the photo `status:"pending_review"`
  in Supabase (nothing is removed) and deletes the derived `MLS for download`
  copy. Re-uploading a file with the **same name** in the same folder → same
  `photoId` → the record flips back to `ok` and the copy is rebuilt. A
  different name leaves the old record `pending_review` for a human.

---

## One-time setup

### 1. Supabase (same project as Feature Sheet Builder)

Run [`supabase/schema.sql`](./supabase/schema.sql) once in the Supabase SQL
editor. It adds:

- `photo_sync_state` — one row holding the Dropbox delta cursor + a lease lock
- `photos_upsert(project_id, photo jsonb)` — atomic merge of one photo into
  `projects.data.photos[]` (row-locked; preserves Feature-Sheet-Builder-owned
  keys like `role`)
- `photos_mark_pending(project_id, photo_id)` — flag a photo `pending_review`

Nothing is exposed to `anon`; only the Worker (service-role key) calls these.

### 2. Cloudflare

Requires the **Workers Paid plan** (Queues + higher subrequest limits).

```bash
cd photo-sync-worker
npm install

# queues (main + dead-letter)
npx wrangler queues create photo-sync-jobs
npx wrangler queues create photo-sync-dlq

# secrets (values are never committed; see .dev.vars.example for the list)
npx wrangler secret put DROPBOX_APP_KEY
npx wrangler secret put DROPBOX_APP_SECRET
npx wrangler secret put DROPBOX_REFRESH_TOKEN
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ADMIN_TOKEN          # long random string; guards /admin/*

npx wrangler deploy
```

Non-secret config lives in [`wrangler.jsonc`](./wrangler.jsonc) `vars`
(`DROPBOX_JOBS_ROOT`, `SYNC_FOLDERS`, `DOWNLOAD_SET_FOLDERS`, …). The Dropbox
app is **Full Dropbox**; `DROPBOX_JOBS_ROOT` is `""` because Job Generator
creates job folders at the Dropbox root. If jobs are ever consolidated under
one parent folder, set `DROPBOX_JOBS_ROOT` to that path and redeploy.

### 3. Dropbox webhook

In the Dropbox App Console → the FranVision app → **Webhooks**, add:

```
https://franvision-photo-sync.<your-subdomain>.workers.dev/webhook
```

Dropbox immediately GETs `…/webhook?challenge=…`; the Worker echoes it back.
POST notifications are HMAC-verified with the app secret.

### 4. First cursor

The first `delta` run (cron fires within 2 min, or `curl -X POST …/admin/backfill`
then hit `/admin/status`) stores a "from now on" cursor via
`list_folder/get_latest_cursor` — it does **not** enumerate the whole Dropbox.
Only changes after that point are processed. Existing jobs are picked up only
by an explicit backfill.

---

## Operations

| Action | How |
|---|---|
| Health | `GET /` |
| Status / cursor / last run | `GET /admin/status` with `Authorization: Bearer $ADMIN_TOKEN` |
| Backfill everything | `POST /admin/backfill` (bearer auth), empty body |
| Backfill one job | `POST /admin/backfill` body `{"jobId":"FV-XXXX"}` |
| Live logs | `npx wrangler tail` (structured JSON lines) |
| Poison messages | land in the `photo-sync-dlq` queue after 5 retries |

Log events worth grepping: `delta_done`, `photo_batch_done`, `photo_healed`,
`photo_pending_review`, `thumb_skip`, `photo_error`, `download_copy_failed`,
`webhook_bad_signature`.

---

## Development

```bash
npm test                 # node --test, no network (fakes for Dropbox/Supabase)
cp .dev.vars.example .dev.vars   # fill in, then:
npx wrangler dev
```

Zero runtime dependencies — Dropbox and Supabase are called with raw `fetch`.
`devDependencies` is just `wrangler`.

---

## Not in v1 (see DESIGN.md §10)

- The 1620×1080 delivery set (option 2) — only if 1024 proves too soft for
  final MLS delivery; needs a real resize pipeline, not the Dropbox thumbnail
  API.
- Video / VLOG links.
- Storage retention/cleanup for the Supabase free tier (1 GB).
- A human-facing view of `pending_review` photos (Gallery / FSB UI concern).
