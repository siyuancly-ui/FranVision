// The video sync engine -- parallel to sync.js's photo pipeline, not merged
// into it, so the two can be read/tested independently and the shipped photo
// path is never touched by this file. Runners take an injectable `deps` bag
// ({ dbx, sb, stream, now }) so tests hand in fakes; no network in tests.

import { parseJobPath, isVideoSyncCandidate, matchAncestorFolder, parseFolderList } from './paths.js';
import { photoId as contentId } from './photo-id.js';

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

export function readVideoConfig(env) {
  return {
    root: env.DROPBOX_JOBS_ROOT || '',
    videoSyncFolders: parseFolderList(env.VIDEO_SYNC_FOLDERS),
  };
}

// From collapsed delta entries (same shape sync.js's classifyForSync reads),
// keep only video files under VIDEO_SYNC_FOLDERS.
export function classifyForVideoSync(entries, { root, videoSyncFolders }) {
  const out = [];
  for (const e of entries || []) {
    const tag = e['.tag'];
    const pathDisplay = e.path_display || e.path_lower;
    if (!pathDisplay) continue;

    if (tag === 'file') {
      if (!isVideoSyncCandidate(pathDisplay, { root, videoSyncFolders })) continue;
      const parsed = parseJobPath(pathDisplay, root);
      out.push({
        type: 'upsert',
        path: pathDisplay,
        jobFolder: parsed.jobFolder,
        jobFolderPath: parsed.jobFolderPath,
        subFolder: matchAncestorFolder(parsed.ancestors, videoSyncFolders),
        relPathFromJob: parsed.relPathFromJob,
        filename: parsed.filename,
        id: e.id || null,
        rev: e.rev || null,
      });
    } else if (tag === 'deleted') {
      if (!isVideoSyncCandidate(pathDisplay, { root, videoSyncFolders })) continue;
      const parsed = parseJobPath(pathDisplay, root);
      out.push({
        type: 'delete',
        path: pathDisplay,
        jobFolder: parsed.jobFolder,
        jobFolderPath: parsed.jobFolderPath,
        subFolder: matchAncestorFolder(parsed.ancestors, videoSyncFolders),
        relPathFromJob: parsed.relPathFromJob,
        filename: parsed.filename,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// processVideoBatch -- kick off a Cloudflare Stream ingest per new/changed
// video, best-effort per item (one bad video never sinks the whole batch).
// ---------------------------------------------------------------------------
export async function processVideoBatch(env, deps, msg) {
  const { dbx, sb, stream, now = () => new Date().toISOString() } = deps;
  const { jobId, items } = msg;

  const upserts = items.filter((i) => i.type === 'upsert');
  const deletes = items.filter((i) => i.type === 'delete');

  let ok = 0;
  let skipped = 0;

  for (const item of upserts) {
    try {
      const videoId = await contentId(jobId, item.relPathFromJob);

      const link = await dbx.getTemporaryLink(item.path);
      const copy = await stream.copyFromUrl(link.link, { jobId, videoId, filename: item.filename });

      await sb.rpc('videos_upsert', {
        p_project_id: jobId,
        p_video: {
          videoId,
          filename: item.filename,
          folder: item.subFolder,
          dropboxFileId: item.id,
          dropboxPath: item.path,
          dropboxRev: item.rev,
          streamUid: copy.uid,
          status: 'processing',
          syncedAt: now(),
        },
      });
      await sb.insertPendingVideo({ projectId: jobId, videoId, streamUid: copy.uid });

      ok++;
    } catch (err) {
      skipped++;
      log({ evt: 'video_error', jobId, path: item.path, error: String(err && err.message || err) });
    }
  }

  for (const item of deletes) {
    try {
      const videoId = await contentId(jobId, item.relPathFromJob);

      // Best-effort: free the Stream copy so deleted videos don't keep
      // accruing storage cost. Never lets a Stream failure block the
      // Supabase pending_review flag below.
      try {
        const existing = await sb.getProjectVideo(jobId, videoId);
        if (existing && existing.streamUid) {
          await stream.deleteVideo(existing.streamUid);
        }
      } catch (err) {
        log({ evt: 'video_stream_delete_failed', jobId, videoId, path: item.path, error: String(err && err.message || err) });
      }

      await sb.rpc('videos_mark_pending', { p_project_id: jobId, p_video_id: videoId });
      log({ evt: 'video_pending_review', jobId, videoId, path: item.path });
    } catch (err) {
      log({ evt: 'video_delete_error', jobId, path: item.path, error: String(err && err.message || err) });
    }
  }

  log({ evt: 'video_batch_done', jobId, upserts: upserts.length, deletes: deletes.length, ok, skipped });
  return { ok, skipped, deletes: deletes.length };
}

// ---------------------------------------------------------------------------
// processVideoPoll -- check every pending Stream ingest; finalize the ones
// that are ready or errored, leave transient/still-encoding ones for the
// next 2-min cron tick.
// ---------------------------------------------------------------------------
export async function processVideoPoll(env, deps) {
  const { sb, stream, now = () => new Date().toISOString() } = deps;

  const pending = await sb.listPendingVideos();
  let ready = 0;
  let errored = 0;
  let stillPending = 0;

  for (const row of pending) {
    let status;
    try {
      status = await stream.getStatus(row.stream_uid);
    } catch (err) {
      // Transient failure (network blip, etc.) -- leave the row, retry next tick.
      log({ evt: 'video_poll_status_failed', videoId: row.video_id, streamUid: row.stream_uid, error: String(err && err.message || err) });
      continue;
    }

    const state = status && status.status && status.status.state;

    if (status && status.readyToStream) {
      await sb.rpc('videos_upsert', {
        p_project_id: row.project_id,
        p_video: {
          videoId: row.video_id,
          streamUid: row.stream_uid,
          status: 'ok',
          durationSec: status.duration,
          playbackUrl: `https://videodelivery.net/${row.stream_uid}/manifest/video.m3u8`,
          thumbnailUrl: status.thumbnail,
          syncedAt: now(),
        },
      });
      await sb.deletePendingVideo(row.id);
      ready++;
      log({ evt: 'video_ready', videoId: row.video_id, streamUid: row.stream_uid });
    } else if (state === 'error') {
      await sb.rpc('videos_upsert', {
        p_project_id: row.project_id,
        p_video: { videoId: row.video_id, streamUid: row.stream_uid, status: 'error', syncedAt: now() },
      });
      await sb.deletePendingVideo(row.id);
      errored++;
      log({ evt: 'video_encode_error', videoId: row.video_id, streamUid: row.stream_uid });
    } else {
      stillPending++;
    }
  }

  log({ evt: 'video_poll_done', total: pending.length, ready, errored, stillPending });
  return { total: pending.length, ready, errored, stillPending };
}
