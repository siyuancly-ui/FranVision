// GET /render/<jobId>/<photoId> -- the TRUE original of ONE synced photo (from
// its `HDR Photos` / `MLS` Dropbox path), for the Feature Sheet Builder's PDF
// export.
//
// Originals and the 2048 set are the PAID deliverable, so nothing here is ever
// published to Supabase Storage; the endpoint hands the file out only with the
// bearer token (RENDER_TOKEN) and only for the few photos an export actually
// places on the sheet. The file is streamed through (never buffered -- an
// original can be tens of MB). There is deliberately NO fallback to the small
// `MLS for download` 2048: if the original can't be read, fail loudly rather
// than let a soft PDF go to print.

import { timingSafeEqual } from './webhook.js';
import { imageContentType } from './paths.js';

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

  let upstream;
  try {
    upstream = await deps.dbx.downloadFileStream(rec.dropboxPath);
  } catch (err) {
    log({ evt: 'render_failed', jobId, photoId, error: String((err && err.message) || err) });
    return fail(502, 'could not read the original');
  }
  const headers = {
    ...CORS,
    'Content-Type': imageContentType(rec.filename || rec.dropboxPath),
    'Cache-Control': 'private, max-age=3600',
    'X-Render-Source': 'original',
  };
  const len = upstream.headers && upstream.headers.get && upstream.headers.get('Content-Length');
  if (len) headers['Content-Length'] = len;
  return new Response(upstream.body, { status: 200, headers });
}
