// The sync engine. Pure helpers (collapse / classify / group) are exported
// for unit tests; the runners (runDelta / runBackfill / processPhotoBatch)
// take an injectable `deps` bag so tests can hand in fake Dropbox/Supabase.

import { parseJobPath, isSyncCandidate, folderMatches, matchAncestorFolder, parseFolderList, downloadCopyPath, parseAddressFromJobFolder, imageContentType, downloadSubdirFor } from './paths.js';
import { photoId } from './photo-id.js';
import { classifyForVideoSync, readVideoConfig } from './video-sync.js';
import { classifyForTourLink, readTourLinkConfig } from './tour-link-sync.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Dropbox delta entries are ordered; the LAST entry for a given path is its
// current state. Collapse to one entry per path_lower, preserving the order
// of last appearance.
export function collapseEntries(entries) {
  const byPath = new Map();
  for (const e of entries || []) {
    const key = (e.path_lower || e.path_display || '').toLowerCase();
    if (!key) continue;
    byPath.delete(key); // drop the earlier position...
    byPath.set(key, e); // ...re-insert at the end
  }
  return [...byPath.values()];
}

// From collapsed entries, keep only the ones we act on:
//   { type: 'upsert', ... }  for a file under a SYNC_FOLDERS sub-folder
//   { type: 'delete', ... }  for a deleted path with that same shape
export function classifyForSync(entries, { root, syncFolders }) {
  const out = [];
  for (const e of entries || []) {
    const tag = e['.tag'];
    const pathDisplay = e.path_display || e.path_lower;
    if (!pathDisplay) continue;

    if (tag === 'file') {
      if (!isSyncCandidate(pathDisplay, { root, syncFolders })) continue;
      const parsed = parseJobPath(pathDisplay, root);
      out.push({
        type: 'upsert',
        path: pathDisplay,
        jobFolder: parsed.jobFolder,
        jobFolderPath: parsed.jobFolderPath,
        // The matched folder name, not always parsed.subFolder -- lets a
        // recognized folder (e.g. "Drone Callout") be nested inside another
        // one (e.g. "HDR Photos/Drone Callout/x.jpg") and still be
        // classified by its own, more specific name. See matchAncestorFolder.
        subFolder: matchAncestorFolder(parsed.ancestors, syncFolders),
        relPathFromJob: parsed.relPathFromJob,
        filename: parsed.filename,
        id: e.id || null,
        rev: e.rev || null,
        // keep only what we use -- queue messages have a 128 KB cap
        dims: dimsFromMediaInfo(e.media_info),
      });
    } else if (tag === 'deleted') {
      if (!isSyncCandidate(pathDisplay, { root, syncFolders })) continue;
      const parsed = parseJobPath(pathDisplay, root);
      out.push({
        type: 'delete',
        path: pathDisplay,
        jobFolder: parsed.jobFolder,
        jobFolderPath: parsed.jobFolderPath,
        subFolder: matchAncestorFolder(parsed.ancestors, syncFolders),
        relPathFromJob: parsed.relPathFromJob,
        filename: parsed.filename,
      });
    }
    // folders and anything else: ignored
  }
  return out;
}

// classified items -> Map<jobFolder, { jobFolderPath, items[] }>
export function groupByJob(classified) {
  const groups = new Map();
  for (const item of classified || []) {
    let g = groups.get(item.jobFolder);
    if (!g) {
      g = { jobFolderPath: item.jobFolderPath, items: [] };
      groups.set(item.jobFolder, g);
    }
    g.items.push(item);
  }
  return groups;
}

// Dropbox media_info -> { width, height } | { width: null, height: null }
export function dimsFromMediaInfo(mediaInfo) {
  const md = mediaInfo && (mediaInfo.metadata || (mediaInfo['.tag'] === 'metadata' ? mediaInfo : null));
  const d = md && md.dimensions;
  if (d && Number.isFinite(d.width) && Number.isFinite(d.height)) {
    return { width: d.width, height: d.height };
  }
  return { width: null, height: null };
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Mirrors delivery-page/src/render.js's pickPhotos() + fallbackPhoto() +
// hero/closing dedup EXACTLY -- these are the (at most two) gallery photos
// (3rd/5th by filename, clamped to whatever's available, deduped when the
// gallery is small) delivery-page's hero/closing sections actually display
// when a Job has no Cover/Closing override folder (2026-09-17: this used to
// stay on the small w1024h768 thumb forever in that case -- see
// LARGE_THUMB_FOLDERS' note in CLAUDE.md -- this is what changed that).
// Deliberately does NOT check for a Cover/Closing override existing (unlike
// render.js's dedup, which skips the swap when hero comes from a Cover
// override instead of the fallback) -- the worst case of that simplification
// is one harmless unused large render sitting in Storage, never fetched by
// delivery-page, not a functional bug. Pure, no I/O.
export function pickGalleryFallbackTargets(photos, galleryFolders) {
  const wanted = new Set((galleryFolders || []).map((f) => f.toLowerCase()));
  const gallery = (photos || [])
    .filter((p) => p && p.status === 'ok' && p.hasThumb && wanted.has(String(p.folder || '').toLowerCase()))
    .sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));

  if (!gallery.length) return [];

  const at = (i) => gallery[i] || gallery[gallery.length - 1];
  const hero = at(2);
  let closing = at(4);
  if (closing.photoId === hero.photoId && gallery.length > 1) {
    const last = gallery[gallery.length - 1];
    closing = last.photoId !== hero.photoId ? last : gallery[0];
  }

  return hero.photoId === closing.photoId ? [hero] : [hero, closing];
}

// ---------------------------------------------------------------------------
// Config read off env
// ---------------------------------------------------------------------------
export function readConfig(env) {
  return {
    root: env.DROPBOX_JOBS_ROOT || '',
    syncFolders: parseFolderList(env.SYNC_FOLDERS),
    downloadSetFolders: parseFolderList(env.DOWNLOAD_SET_FOLDERS),
    // nested folders (under a download-set folder) whose copies keep their folder in the download tree
    downloadNestedFolders: parseFolderList(env.DOWNLOAD_NESTED_FOLDERS || 'Callout'),
    // Folders that also get a w2048h1536 "large" render uploaded to
    // Supabase (delivery-page's full-bleed slots: Cover&Closing/Drone
    // Callout/Local Report). Deliberately NOT the whole main
    // gallery (HDR Photos/MLS) -- see photo-sync-worker/CLAUDE.md.
    largeThumbFolders: parseFolderList(env.LARGE_THUMB_FOLDERS),
    // Subset of largeThumbFolders that gets the TRUE original file bytes
    // instead of a Dropbox-thumbnail-API render (2026-09-18) -- for a
    // folder like Floorplan where the source is already small, so a
    // w2048h1536 derivative just adds JPEG re-compression for no size
    // benefit. See supabase.js#uploadLarge and dropbox.js#downloadFile.
    originalRenderFolders: parseFolderList(env.ORIGINAL_RENDER_FOLDERS),
    downloadSubfolder: env.DOWNLOAD_SUBFOLDER || 'MLS for download',
    thumbSize: env.THUMB_SIZE || 'w1024h768',
    // Bigger render for the downloadable delivery set written back to
    // Dropbox. Dropbox tops out at w2048h1536 (a 3:2 landscape -> 2048x1365).
    downloadThumbSize: env.DOWNLOAD_THUMB_SIZE || 'w2048h1536',
    templateId: env.DROPBOX_TEMPLATE_ID,
    maxDeltaEntries: Number.isFinite(Number(env.MAX_DELTA_ENTRIES_PER_RUN))
      ? Number(env.MAX_DELTA_ENTRIES_PER_RUN)
      : 2000,
  };
}

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

// ---------------------------------------------------------------------------
// resolveJobId -- read the hidden `jobId` property off a job folder
// ---------------------------------------------------------------------------
export async function resolveJobId(dbx, jobFolderPath, templateId, cache) {
  if (cache && cache.has(jobFolderPath)) return cache.get(jobFolderPath);
  let jobId = null;
  try {
    const md = await dbx.getMetadata(jobFolderPath, { withPropertyGroups: true });
    for (const g of md.property_groups || []) {
      if (templateId && g.template_id !== templateId) continue;
      for (const f of g.fields || []) {
        if (f.name === 'jobId' && f.value) jobId = f.value;
      }
    }
  } catch (err) {
    log({ evt: 'resolve_jobid_failed', jobFolderPath, error: String(err && err.message || err) });
  }
  if (cache) cache.set(jobFolderPath, jobId);
  return jobId;
}

// ---------------------------------------------------------------------------
// runDelta -- pull Dropbox changes since the stored cursor and fan out
// one photo-batch queue message per affected job.
// ---------------------------------------------------------------------------
export async function runDelta(env, deps) {
  const cfg = readConfig(env);
  const { dbx, sb, enqueue, now = () => new Date().toISOString() } = deps;
  const LEASE_MS = 90_000;

  const lease = await sb.acquireLease(LEASE_MS);
  if (!lease) {
    log({ evt: 'delta_skipped_locked' });
    return { skipped: 'locked' };
  }

  try {
    const state = await sb.getSyncState();

    if (!state || !state.cursor) {
      const cursor = await dbx.listFolderGetLatestCursor(cfg.root);
      await sb.patchSyncState({ cursor, last_run_at: now() });
      log({ evt: 'delta_initialized', cursor_len: cursor.length });
      return { initialized: true };
    }

    let cursor = state.cursor;
    const collected = [];
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 100; // belt-and-suspenders against a pathological continue loop
    while (hasMore && collected.length < cfg.maxDeltaEntries && pages < MAX_PAGES) {
      const res = await dbx.listFolderContinue(cursor);
      collected.push(...(res.entries || []));
      cursor = res.cursor;
      hasMore = !!res.has_more;
      pages++;
    }

    const collapsed = collapseEntries(collected);
    const classified = classifyForSync(collapsed, cfg);
    const groups = groupByJob(classified);

    const jobCache = new Map();
    let dispatched = 0;
    let skippedJobs = 0;
    for (const [jobFolder, g] of groups) {
      const jobId = await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache);
      if (!jobId) {
        skippedJobs++;
        continue;
      }
      for (const part of chunk(g.items, 100)) {
        await enqueue({ type: 'photo-batch', jobId, jobFolderPath: g.jobFolderPath, items: part });
        dispatched++;
      }
      void jobFolder;
    }

    // Video: same collapsed delta entries, filtered/grouped independently of
    // the photo pass above -- additive, never touches the photo dispatch.
    const videoCfg = readVideoConfig(env);
    const videoClassified = classifyForVideoSync(collapsed, videoCfg);
    const videoGroups = groupByJob(videoClassified);
    let videoDispatched = 0;
    for (const [, g] of videoGroups) {
      const jobId = await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache);
      if (!jobId) continue;
      for (const part of chunk(g.items, 100)) {
        await enqueue({ type: 'video-batch', jobId, jobFolderPath: g.jobFolderPath, items: part });
        videoDispatched++;
      }
    }

    // Tour Link: same collapsed delta entries, filtered/grouped independently
    // -- a third parallel pipeline (see tour-link-sync.js), additive, never
    // touches the photo or video dispatch above.
    const tourLinkCfg = readTourLinkConfig(env);
    const tourLinkClassified = classifyForTourLink(collapsed, tourLinkCfg);
    const tourLinkGroups = groupByJob(tourLinkClassified);
    let tourLinkDispatched = 0;
    for (const [, g] of tourLinkGroups) {
      const jobId = await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache);
      if (!jobId) continue;
      await enqueue({ type: 'tour-link-batch', jobId, jobFolderPath: g.jobFolderPath, items: g.items });
      tourLinkDispatched++;
    }

    await sb.patchSyncState({
      cursor,
      last_run_at: now(),
      stats: {
        pages, entries: collected.length, classified: classified.length, jobs: groups.size, skippedJobs, dispatched,
        videoClassified: videoClassified.length, videoJobs: videoGroups.size, videoDispatched,
        tourLinkClassified: tourLinkClassified.length, tourLinkDispatched,
      },
    });

    if (hasMore) await enqueue({ type: 'delta' });

    log({
      evt: 'delta_done', pages, entries: collected.length, classified: classified.length, jobs: groups.size, dispatched,
      videoClassified: videoClassified.length, videoDispatched, tourLinkClassified: tourLinkClassified.length, tourLinkDispatched, hasMore,
    });
    return { pages, entries: collected.length, dispatched, videoDispatched, tourLinkDispatched, hasMore };
  } finally {
    await sb.releaseLease().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// processPhotoBatch -- do the actual thumbnail + upload + upsert work for
// one job. Per-photo failures are logged and skipped; only whole-batch
// infra failures throw (so the queue message retries).
// ---------------------------------------------------------------------------
export async function processPhotoBatch(env, deps, msg) {
  const cfg = readConfig(env);
  const { dbx, sb, now = () => new Date().toISOString() } = deps;
  const { jobId, jobFolderPath, items } = msg;

  // Best-effort: keep delivery-page's `address` fresh from the Dropbox job
  // folder name (interim measure -- see paths.js#parseAddressFromJobFolder).
  // Idempotent overwrite, never blocks the actual photo sync below.
  try {
    const jobFolder = String(jobFolderPath || '').split('/').filter(Boolean).pop();
    const address = parseAddressFromJobFolder(jobFolder);
    if (address) {
      await sb.rpc('project_set_delivery_info', { p_project_id: jobId, p_fields: { address } });
    }
  } catch (err) {
    log({ evt: 'address_sync_failed', jobId, error: String(err && err.message || err) });
  }

  const upserts = items.filter((i) => i.type === 'upsert');
  const deletes = items.filter((i) => i.type === 'delete');

  let ok = 0;
  let healed = 0;
  let skipped = 0;
  const succeeded = []; // items whose Gallery record was saved -> eligible for a delivery copy

  // ---- upserts: thumbnail (batched 25) -> storage + optional download copy -> rpc
  for (const part of chunk(upserts, 25)) {
    let batch;
    try {
      batch = await dbx.getThumbnailBatch(part.map((i) => i.path), cfg.thumbSize);
    } catch (err) {
      // whole-chunk Dropbox failure -> let the queue retry the message
      throw new Error(`get_thumbnail_batch failed for job ${jobId}: ${err && err.message || err}`);
    }

    const results = (batch && batch.entries) || [];
    for (let k = 0; k < part.length; k++) {
      const item = part[k];
      const r = results[k] || {};
      if (r['.tag'] !== 'success' || !r.thumbnail) {
        skipped++;
        log({ evt: 'thumb_skip', jobId, path: item.path, reason: r['.tag'] || 'no_result', detail: r.failure || null });
        continue;
      }
      try {
        const bytes = base64ToBytes(r.thumbnail);
        const pid = await photoId(jobId, item.relPathFromJob);

        // Critical path: the Gallery / Feature Sheet Builder thumbnail.
        await sb.uploadThumb(jobId, pid, bytes);

        const dlSubdir = downloadSubdirFor(item, cfg);
        const downloadDropboxPath = dlSubdir !== null
          ? downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename, dlSubdir)
          : undefined;

        // Dropbox generates media_info asynchronously after upload, so the
        // delta entry often has no dimensions yet. By the time this runs
        // (webhook -> queue, ~10-30s later) a fresh get_metadata usually
        // has them. Best-effort: never fail the photo over missing dims.
        let { width, height } = item.dims || { width: null, height: null };
        if (width == null || height == null) {
          try {
            const md = await dbx.getMetadata(item.path, { includeMediaInfo: true });
            ({ width, height } = dimsFromMediaInfo(md.media_info));
          } catch (err) {
            log({ evt: 'dims_refetch_failed', jobId, path: item.path, error: String(err && err.message || err) });
          }
        }

        const record = {
          photoId: pid,
          filename: item.filename,
          width,
          height,
          hasThumb: true,
          dropboxFileId: item.id,
          dropboxPath: item.path,
          dropboxRev: item.rev,
          folder: item.subFolder,
          status: 'ok',
          syncedAt: now(),
        };
        if (downloadDropboxPath) record.downloadDropboxPath = downloadDropboxPath;

        const res = await sb.rpc('photos_upsert', { p_project_id: jobId, p_photo: record });
        ok++;
        succeeded.push(item);
        if (res && res.healed) {
          healed++;
          log({ evt: 'photo_healed', jobId, photoId: pid, path: item.path });
        }
      } catch (err) {
        skipped++;
        log({ evt: 'photo_error', jobId, path: item.path, error: String(err && err.message || err) });
      }
    }
  }

  // ---- delivery set: a bigger (w2048h1536) render written back to Dropbox
  // as the human-downloadable "MLS for download" copy. Separate pass, own
  // thumbnail request -- the Gallery/Supabase side stays on the small
  // thumbSize. Entirely best-effort: the Gallery records are already
  // saved above; a failure here is logged and picked up next sync/backfill.
  // downloadCopyPath() normalizes every filename to the SAME .jpg destination
  // regardless of the source's own extension. So a photo replaced by deleting
  // the old file and dragging in a new one under a different extension (e.g.
  // FVM076.jpg -> FVM076.jpeg -- found in real use 2026-09-16) produces an
  // upsert AND a delete in the same batch that both resolve to the identical
  // download-copy path. Upserts are processed before deletes below, so
  // without this tracking the delete pass would wipe out the replacement's
  // brand new copy right after this loop just wrote it. Track what THIS
  // batch actually wrote so the deletes pass can tell "a real deletion" from
  // "the old half of a same-batch replacement" and skip the latter.
  const deliveredDestPaths = new Set();
  const deliveryItems = succeeded.filter((i) => downloadSubdirFor(i, cfg) !== null);
  for (const part of chunk(deliveryItems, 25)) {
    let dbatch = null;
    try {
      dbatch = await dbx.getThumbnailBatch(part.map((i) => i.path), cfg.downloadThumbSize);
    } catch (err) {
      log({ evt: 'delivery_batch_failed', jobId, size: cfg.downloadThumbSize, error: String(err && err.message || err) });
    }
    const dresults = (dbatch && dbatch.entries) || [];
    for (let k = 0; k < part.length; k++) {
      const item = part[k];
      const dr = dresults[k] || {};
      const dest = downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename, downloadSubdirFor(item, cfg));
      try {
        let bytes;
        if (dr['.tag'] === 'success' && dr.thumbnail) {
          bytes = base64ToBytes(dr.thumbnail);
        } else {
          // batch entry failed (or whole batch errored) -> single fallback
          bytes = await dbx.getThumbnailV2(item.path, cfg.downloadThumbSize);
        }
        await dbx.filesUpload(dest, bytes);
        deliveredDestPaths.add(dest);
      } catch (err) {
        const message = String(err && err.message || err);
        log({ evt: 'download_copy_failed', jobId, path: dest, error: message });
        try {
          await sb.insertPendingRender({
            projectId: jobId, kind: 'download_copy', sourcePath: item.path, destPath: dest, filename: item.filename, error: message,
          });
        } catch (pendingErr) {
          log({ evt: 'render_pending_insert_failed', jobId, path: dest, error: String(pendingErr && pendingErr.message || pendingErr) });
        }
      }
    }
  }

  // ---- large render: a bigger (w2048h1536) copy for delivery-page's
  // full-bleed slots (Cover&Closing/Drone Callout/Local Report/Floorplan),
  // uploaded to Supabase Storage as <photoId>_large.jpg. Separate pass, own
  // thumbnail request -- the main Gallery/Supabase thumb above stays small.
  // Entirely best-effort: the Gallery record is already saved; a failure
  // here just means delivery-page falls back to the small thumb for that
  // one photo. Split by originalRenderFolders (2026-09-18): those items get
  // the TRUE original file, not a Dropbox-thumbnail-API render -- see
  // readConfig's originalRenderFolders comment. Not worth batching (one
  // downloadFile call per item, no thumbnail-batch-style endpoint for it).
  const allLargeItems = succeeded.filter((i) => folderMatches(i.subFolder, cfg.largeThumbFolders));
  const originalItems = allLargeItems.filter((i) => folderMatches(i.subFolder, cfg.originalRenderFolders));
  const thumbLargeItems = allLargeItems.filter((i) => !folderMatches(i.subFolder, cfg.originalRenderFolders));

  for (const item of originalItems) {
    const pid = await photoId(jobId, item.relPathFromJob);
    try {
      const bytes = await dbx.downloadFile(item.path);
      await sb.uploadLarge(jobId, pid, bytes, imageContentType(item.filename));
      await sb.rpc('photos_upsert', { p_project_id: jobId, p_photo: { photoId: pid, hasLarge: true } });
    } catch (err) {
      const message = String(err && err.message || err);
      log({ evt: 'large_render_failed', jobId, path: item.path, error: message });
      try {
        await sb.insertPendingRender({
          projectId: jobId, kind: 'large', sourcePath: item.path, photoId: pid, filename: item.filename, error: message,
        });
      } catch (pendingErr) {
        log({ evt: 'render_pending_insert_failed', jobId, path: item.path, error: String(pendingErr && pendingErr.message || pendingErr) });
      }
    }
  }

  for (const part of chunk(thumbLargeItems, 25)) {
    let lbatch = null;
    try {
      lbatch = await dbx.getThumbnailBatch(part.map((i) => i.path), cfg.downloadThumbSize);
    } catch (err) {
      log({ evt: 'large_batch_failed', jobId, size: cfg.downloadThumbSize, error: String(err && err.message || err) });
    }
    const lresults = (lbatch && lbatch.entries) || [];
    for (let k = 0; k < part.length; k++) {
      const item = part[k];
      const lr = lresults[k] || {};
      const pid = await photoId(jobId, item.relPathFromJob);
      try {
        let bytes;
        if (lr['.tag'] === 'success' && lr.thumbnail) {
          bytes = base64ToBytes(lr.thumbnail);
        } else {
          // batch entry failed (or whole batch errored) -> single fallback
          bytes = await dbx.getThumbnailV2(item.path, cfg.downloadThumbSize);
        }
        await sb.uploadLarge(jobId, pid, bytes);
        await sb.rpc('photos_upsert', { p_project_id: jobId, p_photo: { photoId: pid, hasLarge: true } });
      } catch (err) {
        const message = String(err && err.message || err);
        log({ evt: 'large_render_failed', jobId, path: item.path, error: message });
        try {
          await sb.insertPendingRender({
            projectId: jobId, kind: 'large', sourcePath: item.path, photoId: pid, filename: item.filename, error: message,
          });
        } catch (pendingErr) {
          log({ evt: 'render_pending_insert_failed', jobId, path: item.path, error: String(pendingErr && pendingErr.message || pendingErr) });
        }
      }
    }
  }

  // ---- deletes: flag pending_review + drop the download copy (derivative)
  for (const item of deletes) {
    try {
      const pid = await photoId(jobId, item.relPathFromJob);
      await sb.rpc('photos_mark_pending', { p_project_id: jobId, p_photo_id: pid });
      const delSubdir = downloadSubdirFor(item, cfg);
      if (delSubdir !== null) {
        const dest = downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename, delSubdir);
        if (deliveredDestPaths.has(dest)) {
          // This delete is the OLD half of a same-batch replacement (e.g. a
          // filename/extension change) -- the upsert pass above already
          // wrote the replacement's copy at this exact normalized path.
          // Deleting it now would destroy the brand new file, not clean up
          // a stale one. See deliveredDestPaths' comment above.
          log({ evt: 'download_copy_delete_skipped_same_batch_replacement', jobId, path: dest });
        } else {
          await dbx.filesDelete(dest);
        }
      }
      log({ evt: 'photo_pending_review', jobId, photoId: pid, path: item.path });
    } catch (err) {
      log({ evt: 'delete_error', jobId, path: item.path, error: String(err && err.message || err) });
    }
  }

  // ---- gallery hero/closing fallback large render: only the (at most two)
  // gallery photos delivery-page's hero/closing fallback would actually pick
  // (3rd/5th by filename -- see pickGalleryFallbackTargets) get a large
  // render, not the whole gallery (LARGE_THUMB_FOLDERS stays deliberately
  // scoped to Cover&Closing/Callout/Local Report -- see CLAUDE.md). Only
  // worth re-checking when this batch actually touched a gallery-folder
  // item (upsert or delete), since that's the only thing that can shift
  // which photo is "3rd/5th" -- reads the CURRENT full gallery from
  // Supabase, not just this batch's items, since an earlier batch's photo
  // can be the one that needs it.
  const galleryTouched = items.some((i) => folderMatches(i.subFolder, cfg.downloadSetFolders));
  if (galleryTouched) {
    try {
      const allPhotos = await sb.getProjectPhotos(jobId);
      const targets = pickGalleryFallbackTargets(allPhotos, cfg.downloadSetFolders).filter((p) => !p.hasLarge);
      for (const target of targets) {
        try {
          const bytes = await dbx.getThumbnailV2(target.dropboxPath, cfg.downloadThumbSize);
          await sb.uploadLarge(jobId, target.photoId, bytes);
          await sb.rpc('photos_upsert', { p_project_id: jobId, p_photo: { photoId: target.photoId, hasLarge: true } });
        } catch (err) {
          const message = String(err && err.message || err);
          log({ evt: 'gallery_fallback_large_render_failed', jobId, photoId: target.photoId, error: message });
          try {
            await sb.insertPendingRender({
              projectId: jobId, kind: 'large', sourcePath: target.dropboxPath, photoId: target.photoId, filename: target.filename, error: message,
            });
          } catch (pendingErr) {
            log({ evt: 'render_pending_insert_failed', jobId, path: target.dropboxPath, error: String(pendingErr && pendingErr.message || pendingErr) });
          }
        }
      }
    } catch (err) {
      log({ evt: 'gallery_fallback_lookup_failed', jobId, error: String(err && err.message || err) });
    }
  }

  log({ evt: 'photo_batch_done', jobId, upserts: upserts.length, deletes: deletes.length, ok, healed, skipped });
  return { ok, healed, skipped, deletes: deletes.length };
}

// ---------------------------------------------------------------------------
// runBackfill -- manual, cursor-independent re-sync of one job or all jobs.
// ---------------------------------------------------------------------------
export async function runBackfill(env, deps, { jobId: onlyJobId } = {}) {
  const cfg = readConfig(env);
  const { dbx, enqueue } = deps;

  let rootPath = cfg.root;
  let knownJobId = null;

  if (onlyJobId) {
    const match = await dbx.propertiesSearch(onlyJobId, cfg.templateId);
    if (!match || !match.path) {
      log({ evt: 'backfill_job_not_found', jobId: onlyJobId });
      return { error: 'job folder not found for jobId', jobId: onlyJobId };
    }
    // properties/search's own `path` field can be stale (observed
    // 2026-09-16: it kept returning a nonexistent path after some
    // combination of property add/search/remove churn on the account,
    // breaking backfill with a path/not_found even though the folder
    // hadn't moved). `match.id` is a stable Dropbox file id -- resolving
    // through get_metadata by id always returns the CURRENT real path,
    // so re-resolve rather than trusting the search result's path as-is.
    rootPath = match.path;
    if (match.id) {
      try {
        const md = await dbx.getMetadata(match.id, {});
        if (md && md.path_display) rootPath = md.path_display;
      } catch (err) {
        log({ evt: 'backfill_path_resolve_failed', jobId: onlyJobId, error: String(err && err.message || err) });
      }
    }
    knownJobId = onlyJobId;
    log({ evt: 'backfill_root_resolved', jobId: onlyJobId, path: rootPath, searchPath: match.path });
  }

  // Walk the target subtree.
  const entries = [];
  let res = await dbx.listFolder(rootPath);
  entries.push(...(res.entries || []));
  while (res.has_more) {
    res = await dbx.listFolderContinue(res.cursor);
    entries.push(...(res.entries || []));
  }

  const classified = classifyForSync(entries, cfg).filter((i) => i.type === 'upsert');
  const groups = groupByJob(classified);

  const jobCache = new Map();
  let dispatched = 0;
  for (const [, g] of groups) {
    const jid = knownJobId || (await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache));
    if (!jid) continue;
    for (const part of chunk(g.items, 100)) {
      await enqueue({ type: 'photo-batch', jobId: jid, jobFolderPath: g.jobFolderPath, items: part });
      dispatched++;
    }
  }

  // Video: same walked entries, classified/grouped independently (mirrors runDelta).
  const videoCfg = readVideoConfig(env);
  const videoClassified = classifyForVideoSync(entries, videoCfg).filter((i) => i.type === 'upsert');
  const videoGroups = groupByJob(videoClassified);
  let videoDispatched = 0;
  for (const [, g] of videoGroups) {
    const jid = knownJobId || (await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache));
    if (!jid) continue;
    for (const part of chunk(g.items, 100)) {
      await enqueue({ type: 'video-batch', jobId: jid, jobFolderPath: g.jobFolderPath, items: part });
      videoDispatched++;
    }
  }

  // Tour Link: same walked entries, classified/grouped independently (mirrors runDelta).
  const tourLinkCfg = readTourLinkConfig(env);
  const tourLinkClassified = classifyForTourLink(entries, tourLinkCfg).filter((i) => i.type === 'upsert');
  const tourLinkGroups = groupByJob(tourLinkClassified);
  let tourLinkDispatched = 0;
  for (const [, g] of tourLinkGroups) {
    const jid = knownJobId || (await resolveJobId(dbx, g.jobFolderPath, cfg.templateId, jobCache));
    if (!jid) continue;
    await enqueue({ type: 'tour-link-batch', jobId: jid, jobFolderPath: g.jobFolderPath, items: g.items });
    tourLinkDispatched++;
  }

  log({
    evt: 'backfill_dispatched', scope: onlyJobId || 'all', entries: entries.length, files: classified.length, jobs: groups.size, dispatched,
    videoFiles: videoClassified.length, videoJobs: videoGroups.size, videoDispatched,
    tourLinkFiles: tourLinkClassified.length, tourLinkJobs: tourLinkGroups.size, tourLinkDispatched,
  });
  return {
    scope: onlyJobId || 'all', files: classified.length, jobs: groups.size, dispatched,
    videoFiles: videoClassified.length, videoDispatched,
    tourLinkFiles: tourLinkClassified.length, tourLinkDispatched,
  };
}

// A row that has failed this many times is abandoned (deleted, logged) rather
// than retried forever -- a persistently-failing render (e.g. the source
// photo was deleted from Dropbox in the meantime) shouldn't retry every 2
// minutes indefinitely. At one retry per cron tick this is ~40 min of retries.
export const MAX_RENDER_RETRY_ATTEMPTS = 20;

// ---------------------------------------------------------------------------
// processRenderRetryPoll -- retry every pending delivery-copy/large render
// (see photo_render_pending in schema.sql) on the same 2-min cron as the
// video poll. Mirrors processVideoPoll's shape: read the pending rows, retry
// each independently, one bad row never blocks the rest.
// ---------------------------------------------------------------------------
export async function processRenderRetryPoll(env, deps) {
  const cfg = readConfig(env);
  const { dbx, sb } = deps;

  const pending = await sb.listPendingRenders();
  let succeeded = 0;
  let failed = 0;
  let abandoned = 0;

  for (const row of pending) {
    try {
      if (row.kind === 'download_copy') {
        const bytes = await dbx.getThumbnailV2(row.source_path, cfg.downloadThumbSize);
        await dbx.filesUpload(row.dest_path, bytes);
      } else {
        // 'large' -- re-derive whether this photo's folder is an
        // ORIGINAL_RENDER_FOLDERS one from source_path itself (the pending
        // row doesn't store subFolder separately, and doesn't need to).
        const parsed = parseJobPath(row.source_path, cfg.root);
        const useOriginal = parsed && !!matchAncestorFolder(parsed.ancestors, cfg.originalRenderFolders);
        const bytes = useOriginal
          ? await dbx.downloadFile(row.source_path)
          : await dbx.getThumbnailV2(row.source_path, cfg.downloadThumbSize);
        await sb.uploadLarge(row.project_id, row.photo_id, bytes, useOriginal ? imageContentType(row.filename) : undefined);
        await sb.rpc('photos_upsert', { p_project_id: row.project_id, p_photo: { photoId: row.photo_id, hasLarge: true } });
      }
      await sb.deletePendingRender(row.id);
      succeeded++;
      log({ evt: 'render_retry_succeeded', jobId: row.project_id, kind: row.kind, path: row.source_path, attempts: (row.attempts || 0) + 1 });
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      const message = String(err && err.message || err);
      if (attempts >= MAX_RENDER_RETRY_ATTEMPTS) {
        await sb.deletePendingRender(row.id);
        abandoned++;
        log({ evt: 'render_retry_abandoned', jobId: row.project_id, kind: row.kind, path: row.source_path, attempts, error: message });
      } else {
        await sb.updatePendingRender(row.id, { attempts, last_error: message });
        failed++;
        log({ evt: 'render_retry_failed', jobId: row.project_id, kind: row.kind, path: row.source_path, attempts, error: message });
      }
    }
  }

  log({ evt: 'render_retry_poll_done', total: pending.length, succeeded, failed, abandoned });
  return { total: pending.length, succeeded, failed, abandoned };
}
