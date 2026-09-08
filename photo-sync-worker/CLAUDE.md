# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this directory (`photo-sync-worker/`). See the repo-root `CLAUDE.md` for how this module fits into the rest of FranVision. `DESIGN.md` (design + rationale) and `README.md` (ops runbook) alongside this file go deeper.

## What this is

A standalone **Cloudflare Worker** (`franvision-photo-sync`) that mirrors compressed thumbnails of the photos in Dropbox job folders into the **same Supabase project the Feature Sheet Builder uses**, so the (not-yet-built) Wix Gallery and the Feature Sheet Builder can display and pick from them without ever talking to Dropbox directly.

- Originals stay in Dropbox and remain the only archive. Each synced photo record keeps a `dropboxFileId` pointing back to the high-res file for the future print/PDF path.
- Supabase here is a **display cache + index**. Wiping Supabase Storage loses nothing permanent — re-run the backfill and every thumbnail regenerates.
- It also writes a **larger delivery render back into Dropbox** (see "Two renders" below) — so unlike every other module, this Worker both reads *and writes* the studio's live Dropbox.

Independent service, its own repo-in-waiting: `photo-sync-worker/` is self-contained and can be split into its own GitHub repo later. It is **not** part of the Feature Sheet Builder despite sharing its Supabase project.

## Requires the Workers Paid plan

Cloudflare **Queues** (per-message retries + batching) and the higher subrequest limit are used — the free plan cannot run this. `wrangler.jsonc` declares the queue producer/consumer, a `*/2 * * * *` cron, and all non-secret vars.

## Running it

```bash
cd photo-sync-worker
npm install                     # devDependency: wrangler only (zero runtime deps)
cp .dev.vars.example .dev.vars  # fill in for local runs; prod uses `wrangler secret put`
npx wrangler dev                # local; GET / , GET /webhook?challenge=x , POST /admin/* work
```

Zero runtime dependencies — Dropbox and Supabase are both driven with raw `fetch`. ESM (`"type": "module"`).

## Tests

```bash
cd photo-sync-worker
npm test           # node --test, 43 cases, NO network
```

Pure helpers (`paths.js`, `photo-id.js`, `webhook.js`, the classify/collapse/group functions in `sync.js`) are unit-tested directly. The runners (`runDelta` / `processPhotoBatch` / `runBackfill`) take an injectable `deps` bag (`{ dbx, sb, enqueue, now }`) so tests hand in fake Dropbox/Supabase objects — the real API is never hit in tests.

**Verifying anything beyond the fake-`deps` tests means running against the studio's real, live production Dropbox account AND the live Supabase project the Feature Sheet Builder uses.** Same rule as `job-generator/`: use an obviously-fake job name, and delete whatever you create (Dropbox folder, the `projects` row, its Storage objects) when done.

## Deploy

```bash
cd photo-sync-worker
npx wrangler queues create photo-sync-jobs        # once
npx wrangler queues create photo-sync-dlq         # once
npx wrangler secret put DROPBOX_APP_KEY           # + APP_SECRET, REFRESH_TOKEN,
                                                 #   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN
npx wrangler deploy
# then: run supabase/schema.sql once in the Supabase SQL editor,
#       and register https://<worker>/webhook in the Dropbox App Console (FranVision OS -> Settings -> Webhooks)
```

Live as of 2026-09-08: deployed to the **`Frankystudio`** Cloudflare account at `https://franvision-photo-sync.frankystudio-6f3.workers.dev`; the Dropbox webhook is registered and Enabled on the **FranVision OS** app; end-to-end acceptance (job create → photo upload → thumbnail + record + delivery copy → delete/self-heal) has passed against real Dropbox + Supabase.

## Architecture: the pipeline

```
Dropbox change ─webhook (HMAC-verified)─┐
2-min cron (reconciliation) ────────────┤─▶ enqueue {type:"delta"} ─▶ Queue photo-sync-jobs
                                                                         │
   delta message: acquire lease lock in photo_sync_state, read cursor,   │
   files/list_folder/continue, collapse to last-state-per-path, keep     │
   only files/deletes under SYNC_FOLDERS, group by top-level job folder, │
   resolve the hidden jobId property per folder (skip untagged), fan out │
   one {type:"photo-batch", jobId, items} per job, advance the cursor. ──┤
                                                                         ▼
   photo-batch message, per job:
     1. get_thumbnail_batch(THUMB_SIZE=w1024h768) -> Supabase Storage
        photos/<jobId>/<photoId>_thumb.jpg  +  photos_upsert() RPC into projects.data.photos[]
     2. (MLS only) second get_thumbnail_batch(DOWNLOAD_THUMB_SIZE=w2048h1536)
        -> files/upload to <jobFolder>/MLS for download/<name>.jpg   (best-effort)
     deletes -> photos_mark_pending() + delete the MLS-for-download copy
```

### Module map

| File | Role |
|---|---|
| `src/index.js` | The three handlers: `fetch` (webhook GET/POST + `/admin/*`), `queue` (dispatch by `msg.type`, ack/retry per message), `scheduled` (cron → enqueue a delta) |
| `src/webhook.js` | Dropbox `X-Dropbox-Signature` HMAC-SHA256 verification (`DROPBOX_APP_SECRET`), constant-time compare |
| `src/dropbox.js` | Raw-fetch Dropbox client bound to `env`; module-scope access-token cache (minted from the refresh token, 401 → force-refresh-once). `list_folder`(+`get_latest_cursor`,`/continue`), `get_metadata` (property groups / media_info), `get_thumbnail_batch`, `get_thumbnail_v2` (single-file fallback), `files/upload`, `files/delete_v2`, `file_properties/properties/search` |
| `src/supabase.js` | Raw-fetch: Storage upload (`x-upsert`), PostgREST `/rpc/*`, and `photo_sync_state` read/write incl. the lease lock (one conditional `PATCH`) |
| `src/sync.js` | The engine. Pure helpers (`collapseEntries`, `classifyForSync`, `groupByJob`, `dimsFromMediaInfo`) + the runners `runDelta` / `processPhotoBatch` / `runBackfill` (injectable `deps`) |
| `src/paths.js` | Pure path parsing: job folder / sub-folder / relative path / extension, `SYNC_FOLDERS` matching, the `MLS for download` loop-guard, `downloadCopyPath` |
| `src/photo-id.js` | `photoId = base64url(sha256(jobId + '/' + relPathFromJob)).slice(0,22)` |
| `supabase/schema.sql` | Run once in the Supabase SQL editor — the 3 objects below |

### What it adds to the shared Supabase project (`papaswihicvajzcubbri`, the Feature Sheet Builder's)

- **`photo_sync_state`** table — one row (`id='default'`): the Dropbox `list_folder` cursor + a `locked_until` lease lock. No `anon` access.
- **`photos_upsert(p_project_id, p_photo jsonb)`** — atomic merge of one photo into `projects.data.photos[]`: creates the row if missing, `SELECT … FOR UPDATE` serializes concurrent writers (this Worker's own batches AND a human in the Feature Sheet Builder), matches by `photoId`, shallow-merges so Feature-Sheet-Builder-owned keys (`role`, sort order, …) survive.
- **`photos_mark_pending(p_project_id, p_photo_id)`** — flag one photo `status:"pending_review"`, remove nothing.
- New keys the Worker writes on each `projects.data.photos[]` entry: `photoId`, `filename`, `width`, `height`, `hasThumb`, `dropboxFileId`, `dropboxPath`, `dropboxRev`, `folder`, `status`, `syncedAt`, and (MLS only) `downloadDropboxPath`. Storage bucket + path rule are unchanged from the Feature Sheet Builder: `photos/<jobId>/<photoId>_thumb.jpg`.

## Confirmed design decisions (several were the road not taken first — re-read before "fixing")

- **No Cloudflare Image Resizing / no WASM. Dropbox does all image work.** Thumbnails come from Dropbox's own `get_thumbnail_batch` (25/call) with `get_thumbnail_v2` as a per-file fallback. The `fetch(..., {cf:{image}})` path was rejected: it needs a zone + a specific plan and *silently returns the original* when unavailable. The Worker never decodes or resizes an image itself.
- **Two renders per MLS photo, each fit for purpose.** `THUMB_SIZE` (`w1024h768`) → Supabase, for Gallery / Feature Sheet Builder *display and selection*. `DOWNLOAD_THUMB_SIZE` (`w2048h1536`, Dropbox's largest; a 3:2 landscape → 2048×1365, ~0.4–0.9 MB) → written back into Dropbox `<job>/MLS for download/` as the human-downloadable *delivery* set. Franky judged 1024 too soft for MLS delivery (2026-09-08). `w2048h1536` on the *batch* endpoint is not 100% confirmed in production — the `get_thumbnail_v2` fallback covers it if a batch entry fails.
- **`photoId` is path-derived, NOT the Dropbox file id.** `hash(jobId + '/' + relPathFromJob)`. A delete + re-upload of the same name produces a *new* Dropbox file id but the *same* path → same `photoId` → the self-heal falls out for free. A pure rename changes the path and thus the id (treated as delete+add — acceptable, renames are rare).
- **Self-heal (implemented + end-to-end verified 2026-09-08).** Dropbox delete → `status:"pending_review"` on the record (nothing removed) + the `MLS for download` copy is hard-deleted (pure derivative). A same-name re-upload lands on the same `photoId` → `photos_upsert` flips it back to `"ok"`, rebuilds the delivery copy, logs `photo_healed`. A different name leaves the old record `pending_review` for a human. There is no filename-fuzzy-matching — it is exact same relative path.
- **`SYNC_FOLDERS` = `MLS, Virtual Staging, Floorplan, Local Report`.** Only web-image extensions (`.jpg/.jpeg/.png/.webp`) under these sub-folders of a tagged job folder are synced. `0 RAW`, `Home Report`, videos, PDFs, `MLS for download` itself (loop guard) are all ignored. `DOWNLOAD_SET_FOLDERS` = `MLS` only.
- **`DROPBOX_JOBS_ROOT=""`** — the Dropbox app is Full Dropbox and Job Generator creates job folders at the account root. If jobs ever move under one parent folder, set this var to that path; no code change.
- **Webhook responds 200 immediately; all work is in the queue.** Dropbox webhooks carry no change list — the Worker keeps a recursive `list_folder` cursor in `photo_sync_state` and diffs on each run. The lease lock makes delta runs serial (concurrent/duplicate webhooks that can't take the lease just `ack` after logging `delta_skipped_locked`).
- **Idempotent throughout.** Delta collapsed to last-state-per-path; `projects` writes via the atomic RPC keyed on `photoId`; Storage upload is `x-upsert`; delivery copy is `mode:overwrite` at a deterministic path.
- **Best-effort layering.** A single bad photo is logged (`thumb_skip` / `photo_error`) and skipped, never sinking the batch. The delivery-copy pass is entirely best-effort (`download_copy_failed` / `delivery_batch_failed`) — the Gallery record is already saved; the next sync/backfill retries. Only a whole-batch infra failure (`get_thumbnail_batch` throws, Supabase down) throws, so the Queue message retries with backoff; after `max_retries: 5` it lands in `photo-sync-dlq`.
- **`width`/`height`** come from the delta entry's `media_info`; Dropbox generates that asynchronously after upload, so when it's missing the Worker does one `get_metadata(include_media_info)` refetch, and still tolerates `null`.
- **Backfill is manual and cursor-independent.** `POST /admin/backfill` (bearer `ADMIN_TOKEN`), empty body = all tagged jobs, `{"jobId":"FVS-…"}` = one. Not run on deploy. Use it to seed pre-existing jobs, or to re-generate every delivery copy after changing `DOWNLOAD_THUMB_SIZE`.

## Environment / secrets

Set with `wrangler secret put` (never a committed file; `.dev.vars` is gitignored, `.dev.vars.example` documents the list):
`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` (the **same** three the Job Generator uses — same "FranVision OS" app, Full Dropbox; the token needs `files.metadata.read/write` + `files.content.read/write`, which cover the File Properties API too — there is no separate `file_properties` scope), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (service-role — bypasses RLS), `ADMIN_TOKEN` (guards `/admin/*`).
Non-secret config is `vars` in `wrangler.jsonc`: `DROPBOX_JOBS_ROOT`, `SYNC_FOLDERS`, `THUMB_SIZE`, `DOWNLOAD_THUMB_SIZE`, `DROPBOX_TEMPLATE_ID` (`ptid:R599LCPosWEAAAAAAAAIFA`, the shared jobId PropertyGroupTemplate), `DOWNLOAD_SET_FOLDERS`, `DOWNLOAD_SUBFOLDER`, `MAX_DELTA_ENTRIES_PER_RUN`.

## Observability

`npx wrangler tail --format pretty` (add `--search "<jobId>"` to cut through webhook noise during a bulk upload). Structured `console.log` events: `delta_done`, `photo_batch_done`, `photo_healed`, `photo_pending_review`, `thumb_skip`, `photo_error`, `download_copy_failed`, `delivery_batch_failed`, `dims_refetch_failed`, `webhook_bad_signature`, `delta_skipped_locked`. `GET /admin/status` (bearer auth) returns the cursor state + last run stats.

## Known limitations

- **A `w2048h1536` batch response has not been confirmed in production.** If Dropbox rejects it per-entry the code falls back to `get_thumbnail_v2` one file at a time (more subrequests, fine on paid) — but if the *whole* batch endpoint rejects the size, watch for `delivery_batch_failed` then per-file fallbacks in `wrangler tail` on the first real MLS batch.
- **Old delivery copies are not auto-upgraded** when `DOWNLOAD_THUMB_SIZE` changes — run `POST /admin/backfill` (all or per-job) to re-render them.
- **Webhook storm during a photographer's bulk upload**: every changed file fires a webhook → many cheap `delta_done` runs (mostly `entries:0`, most changes land in `0 RAW` and are filtered out). Harmless and keeps up in real time; there is deliberately **no debounce** yet.
- **A queued `photo-batch` message lost after the cursor advanced** is not recovered by the cron (which resumes from the advanced cursor) — it relies on Cloudflare Queues' at-least-once delivery, with `POST /admin/backfill` as the manual repair. Low risk; noted.
- **No retention/cleanup** for the Supabase free tier (1 GB) yet — a cron to drop thumbnails + `pending_review` rows for jobs older than N months is a future item (originals are safe in Dropbox; backfill rebuilds).
- **`pending_review` has no human-facing surface yet** — it's a field in `projects.data.photos[]`; showing it is a Gallery / Feature Sheet Builder UI concern.
- **Video / VLOG** are out of scope — a Dropbox link does not embed/play reliably in Wix; a real video host (Vimeo/YouTube) is the plan, wired in later.
