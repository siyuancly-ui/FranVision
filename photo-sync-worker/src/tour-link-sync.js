// Tour Link sync -- a THIRD parallel pipeline alongside sync.js (photos) and
// video-sync.js (video), deliberately kept just as separate. A human drops
// ONE well-known .txt file directly at a job folder's root (not nested in
// any sub-folder -- see paths.js#isTourLinkCandidate), its content is the
// Floor Tour or 3D Tour URL, pasted as-is. Both providers render in the
// exact same iframe slot on delivery-page with no visual difference (see
// delivery-page/src/render.js#tourHtml), so there's deliberately no
// filename/type distinction to parse here -- just a link. Same "no data
// entry, just a file" shape as Cover/Closing/Callout/Local Report, but a
// plain text file instead of a folder of photos since there's only ever one
// link to hold.

import { parseJobPath, isTourLinkCandidate } from './paths.js';

const log = (obj) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

export function readTourLinkConfig(env) {
  return {
    root: env.DROPBOX_JOBS_ROOT || '',
    tourLinkFilename: env.TOUR_LINK_FILENAME || 'Tour Link.txt',
  };
}

// From collapsed delta entries (same shape sync.js/video-sync.js read), keep
// only upsert/delete events for the Tour Link file.
export function classifyForTourLink(entries, { root, tourLinkFilename }) {
  const out = [];
  for (const e of entries || []) {
    const tag = e['.tag'];
    const pathDisplay = e.path_display || e.path_lower;
    if (!pathDisplay) continue;
    if (!isTourLinkCandidate(pathDisplay, { root, tourLinkFilename })) continue;
    const parsed = parseJobPath(pathDisplay, root);

    if (tag === 'file') {
      out.push({ type: 'upsert', path: pathDisplay, jobFolder: parsed.jobFolder, jobFolderPath: parsed.jobFolderPath });
    } else if (tag === 'deleted') {
      out.push({ type: 'delete', path: pathDisplay, jobFolder: parsed.jobFolder, jobFolderPath: parsed.jobFolderPath });
    }
  }
  return out;
}

// processTourLinkBatch -- one job's Tour Link file change(s). Reads the
// file's text content and writes it into projects.data.tourUrl via the
// shared project_set_delivery_info() RPC (owned by delivery-page's
// schema.sql, same one sync.js's interim address-sync already reuses -- not
// duplicated here either). A delete clears tourUrl back to null. Entirely
// best-effort: logged and skipped, never throws, mirrors every other
// derived-data pass in this Worker.
export async function processTourLinkBatch(env, deps, msg) {
  const { dbx, sb } = deps;
  const { jobId, items } = msg;

  let ok = 0;
  let cleared = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      if (item.type === 'delete') {
        await sb.rpc('project_set_delivery_info', { p_project_id: jobId, p_fields: { tourUrl: null } });
        cleared++;
        log({ evt: 'tour_link_cleared', jobId, path: item.path });
        continue;
      }

      const text = await dbx.downloadText(item.path);
      const tourUrl = String(text || '').trim() || null;
      await sb.rpc('project_set_delivery_info', { p_project_id: jobId, p_fields: { tourUrl } });
      ok++;
      log({ evt: 'tour_link_synced', jobId, path: item.path, hasUrl: !!tourUrl });
    } catch (err) {
      skipped++;
      log({ evt: 'tour_link_sync_failed', jobId, path: item.path, error: String(err && err.message || err) });
    }
  }

  log({ evt: 'tour_link_batch_done', jobId, ok, cleared, skipped });
  return { ok, cleared, skipped };
}
