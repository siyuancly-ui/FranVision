// GET /render/<jobId>/<photoId> -- the 2048 render of ONE synced photo, for the
// Feature Sheet Builder's PDF export.
//
// The 2048 set is the PAID deliverable, so it is never published to Supabase
// Storage; this endpoint hands it out only with the bearer token (RENDER_TOKEN)
// and only for the handful of photos an export actually places on the sheet.
// Source, in order: the existing `<job>/MLS for download/<name>.jpg` copy
// (already a w2048h1536 render -- a plain file download), else a fresh
// Dropbox thumbnail render of the original (same size).

import { timingSafeEqual } from './webhook.js';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const ID_RE = /^[A-Za-z0-9_-]{3,60}$/;

export function parseRenderPath(pathname) {
  const m = /^\/render\/([^/]+)\/([^/]+)$/.exec(pathname || '');
  if (!m) return null;
  let jobId; let photoId;
  try { jobId = decodeURIComponent(m[1]); photoId = decodeURIComponent(m[2]); } catch { return null; }
  return ID_RE.test(jobId) && ID_RE.test(photoId) ? { jobId, photoId } : null;
}

function authed(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && !!env.RENDER_TOKEN && timingSafeEqual(m[1], env.RENDER_TOKEN);
}

const fail = (status, error) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function handleRender(request, env, deps, ids, log = () => {}) {
  if (!authed(request, env)) return fail(401, 'unauthorized');
  const { jobId, photoId } = ids;

  let rec;
  try {
    const photos = await deps.sb.getProjectPhotos(jobId);
    rec = photos.find((p) => p.photoId === photoId && !p.role && p.dropboxPath);
  } catch (err) {
    log({ evt: 'render_lookup_failed', jobId, photoId, error: String((err && err.message) || err) });
    return fail(502, 'lookup failed');
  }
  if (!rec) return fail(404, 'photo not found');

  let bytes = null;
  let source = null;
  if (rec.downloadDropboxPath) {
    try { bytes = await deps.dbx.downloadFile(rec.downloadDropboxPath); source = 'download-copy'; } catch { /* fall back below */ }
  }
  if (!bytes) {
    try {
      bytes = await deps.dbx.getThumbnailV2(rec.dropboxPath, env.DOWNLOAD_THUMB_SIZE || 'w2048h1536');
      source = 'thumbnail-api';
    } catch (err) {
      log({ evt: 'render_failed', jobId, photoId, error: String((err && err.message) || err) });
      return fail(502, 'could not render');
    }
  }
  return new Response(bytes, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Render-Source': source },
  });
}
