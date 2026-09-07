// The sync engine. Pure helpers (collapse / classify / group) are exported
// for unit tests; the runners (runDelta / runBackfill / processPhotoBatch)
// take an injectable `deps` bag so tests can hand in fake Dropbox/Supabase.

import { parseJobPath, isSyncCandidate, folderMatches, parseFolderList, downloadCopyPath } from './paths.js';
import { photoId } from './photo-id.js';

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
        subFolder: parsed.subFolder,
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
        subFolder: parsed.subFolder,
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
    downloadSubfolder: env.DOWNLOAD_SUBFOLDER || 'MLS for download',
    thumbSize: env.THUMB_SIZE || 'w1024h768',
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

    const classified = classifyForSync(collapseEntries(collected), cfg);
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

    await sb.patchSyncState({
      cursor,
      last_run_at: now(),
      stats: { pages, entries: collected.length, classified: classified.length, jobs: groups.size, skippedJobs, dispatched },
    });

    if (hasMore) await enqueue({ type: 'delta' });

    log({ evt: 'delta_done', pages, entries: collected.length, classified: classified.length, jobs: groups.size, dispatched, hasMore });
    return { pages, entries: collected.length, dispatched, hasMore };
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

  const upserts = items.filter((i) => i.type === 'upsert');
  const deletes = items.filter((i) => i.type === 'delete');

  let ok = 0;
  let healed = 0;
  let skipped = 0;

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

        const { width, height } = item.dims || { width: null, height: null };
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
        if (res && res.healed) {
          healed++;
          log({ evt: 'photo_healed', jobId, photoId: pid, path: item.path });
        }

        // Best-effort: the downloadable compressed copy written back into
        // Dropbox. A failure here does NOT fail the photo -- the Gallery
        // record is already saved and the next sync/backfill retries this.
        if (downloadDropboxPath) {
          try {
            await dbx.filesUpload(downloadDropboxPath, bytes);
          } catch (err) {
            log({ evt: 'download_copy_failed', jobId, path: downloadDropboxPath, error: String(err && err.message || err) });
          }
        }
      } catch (err) {
        skipped++;
        log({ evt: 'photo_error', jobId, path: item.path, error: String(err && err.message || err) });
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
    rootPath = match.path;
    knownJobId = onlyJobId;
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

  log({ evt: 'backfill_dispatched', scope: onlyJobId || 'all', entries: entries.length, files: classified.length, jobs: groups.size, dispatched });
  return { scope: onlyJobId || 'all', files: classified.length, jobs: groups.size, dispatched };
}
