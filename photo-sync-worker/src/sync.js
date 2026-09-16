// The sync engine. Pure helpers (collapse / classify / group) are exported
// for unit tests; the runners (runDelta / runBackfill / processPhotoBatch)
// take an injectable `deps` bag so tests can hand in fake Dropbox/Supabase.

import { parseJobPath, isSyncCandidate, folderMatches, matchAncestorFolder, parseFolderList, downloadCopyPath, parseAddressFromJobFolder } from './paths.js';
import { photoId } from './photo-id.js';
import { classifyForVideoSync, readVideoConfig } from './video-sync.js';

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

// ---------------------------------------------------------------------------
// Config read off env
// ---------------------------------------------------------------------------
export function readConfig(env) {
  return {
    root: env.DROPBOX_JOBS_ROOT || '',
    syncFolders: parseFolderList(env.SYNC_FOLDERS),
    downloadSetFolders: parseFolderList(env.DOWNLOAD_SET_FOLDERS),
    // Folders that also get a w2048h1536 "large" render uploaded to
    // Supabase (delivery-page's full-bleed slots: Cover Photo/Closing
    // Photo/Drone Callout/Local Report). Deliberately NOT the whole main
    // gallery (HDR Photos/MLS) -- see photo-sync-worker/CLAUDE.md.
    largeThumbFolders: parseFolderList(env.LARGE_THUMB_FOLDERS),
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

    await sb.patchSyncState({
      cursor,
      last_run_at: now(),
      stats: {
        pages, entries: collected.length, classified: classified.length, jobs: groups.size, skippedJobs, dispatched,
        videoClassified: videoClassified.length, videoJobs: videoGroups.size, videoDispatched,
      },
    });

    if (hasMore) await enqueue({ type: 'delta' });

    log({
      evt: 'delta_done', pages, entries: collected.length, classified: classified.length, jobs: groups.size, dispatched,
      videoClassified: videoClassified.length, videoDispatched, hasMore,
    });
    return { pages, entries: collected.length, dispatched, videoDispatched, hasMore };
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

        const isDownloadSet = folderMatches(item.subFolder, cfg.downloadSetFolders);
        const downloadDropboxPath = isDownloadSet
          ? downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename)
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
  const deliveryItems = succeeded.filter((i) => folderMatches(i.subFolder, cfg.downloadSetFolders));
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
      const dest = downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename);
      try {
        let bytes;
        if (dr['.tag'] === 'success' && dr.thumbnail) {
          bytes = base64ToBytes(dr.thumbnail);
        } else {
          // batch entry failed (or whole batch errored) -> single fallback
          bytes = await dbx.getThumbnailV2(item.path, cfg.downloadThumbSize);
        }
        await dbx.filesUpload(dest, bytes);
      } catch (err) {
        log({ evt: 'download_copy_failed', jobId, path: dest, error: String(err && err.message || err) });
      }
    }
  }

  // ---- large render: a bigger (w2048h1536) copy for delivery-page's
  // full-bleed slots (Cover Photo/Closing Photo/Drone Callout/Local
  // Report), uploaded to Supabase Storage as <photoId>_large.jpg.
  // Separate pass, own thumbnail request -- the main Gallery/Supabase
  // thumb above stays small. Entirely best-effort: the Gallery record is
  // already saved; a failure here just means delivery-page falls back to
  // the small thumb for that one photo.
  const largeItems = succeeded.filter((i) => folderMatches(i.subFolder, cfg.largeThumbFolders));
  for (const part of chunk(largeItems, 25)) {
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
      try {
        let bytes;
        if (lr['.tag'] === 'success' && lr.thumbnail) {
          bytes = base64ToBytes(lr.thumbnail);
        } else {
          // batch entry failed (or whole batch errored) -> single fallback
          bytes = await dbx.getThumbnailV2(item.path, cfg.downloadThumbSize);
        }
        const pid = await photoId(jobId, item.relPathFromJob);
        await sb.uploadLarge(jobId, pid, bytes);
        await sb.rpc('photos_upsert', { p_project_id: jobId, p_photo: { photoId: pid, hasLarge: true } });
      } catch (err) {
        log({ evt: 'large_render_failed', jobId, path: item.path, error: String(err && err.message || err) });
      }
    }
  }

  // ---- deletes: flag pending_review + drop the download copy (derivative)
  for (const item of deletes) {
    try {
      const pid = await photoId(jobId, item.relPathFromJob);
      await sb.rpc('photos_mark_pending', { p_project_id: jobId, p_photo_id: pid });
      if (folderMatches(item.subFolder, cfg.downloadSetFolders)) {
        await dbx.filesDelete(downloadCopyPath(jobFolderPath, cfg.downloadSubfolder, item.filename));
      }
      log({ evt: 'photo_pending_review', jobId, photoId: pid, path: item.path });
    } catch (err) {
      log({ evt: 'delete_error', jobId, path: item.path, error: String(err && err.message || err) });
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

  log({
    evt: 'backfill_dispatched', scope: onlyJobId || 'all', entries: entries.length, files: classified.length, jobs: groups.size, dispatched,
    videoFiles: videoClassified.length, videoJobs: videoGroups.size, videoDispatched,
  });
  return { scope: onlyJobId || 'all', files: classified.length, jobs: groups.size, dispatched, videoFiles: videoClassified.length, videoDispatched };
}
