// POST /zip/<jobId>?kind=original|mls  body: { photoIds: [...] }
//
// One streaming ZIP for the standalone Gallery page (delivery-page/src/gallery.js).
//
//   kind=original : the TRUE Dropbox originals (`dropboxPath`)
//   kind=mls      : the 2048px "MLS for download" copies (`downloadDropboxPath`)
//
// WHICH photos is decided by the CALLER, not by any config here: delivery-page
// sends the ids of exactly the photos its grid shows, so the ZIP can never
// disagree with the page (there used to be a second, separately-configured
// folder list here; removing it removed that whole class of "forgot to update
// the other Worker" mistakes). If ANY requested photo isn't ready (unknown,
// not synced ok, or -- for mls -- its 2048 copy hasn't been written yet) the
// answer is 409 with the ids, never a silently smaller zip; the caller shows a
// friendly "still preparing" message and the copy self-heals via the 2-min
// render-retry cron.
//
// Same bearer gate as /render (RENDER_TOKEN): only the delivery-page Worker,
// which resolves the Gallery URL token first, ever calls this. Files stream
// Dropbox -> zip -> client one at a time, never buffered (see zip.js). A file
// that still can't be read after retries ABORTS the stream, so the browser
// reports a failed download (retry works) instead of handing over a zip that is
// quietly missing photos.

import { timingSafeEqual } from './webhook.js';
import { writeZip, dedupeNames, safeEntryName } from './zip.js';

const ID_RE = /^[A-Za-z0-9_-]{3,60}$/;
const KINDS = new Set(['original', 'mls']);
const MAX_IDS = 2000;
const OPEN_ATTEMPTS = 3;

export function parseZipRequest(url) {
  const m = /^\/zip\/([^/]+)$/.exec(url.pathname || '');
  if (!m) return null;
  let jobId;
  try { jobId = decodeURIComponent(m[1]); } catch { return null; }
  const kind = url.searchParams.get('kind') || '';
  return ID_RE.test(jobId) && KINDS.has(kind) ? { jobId, kind } : null;
}

const baseName = (p) => String(p || '').split('/').pop();

// Pure. Resolves the requested ids against the Job's photo records.
// -> { entries: [{ name, path }] (in the caller's order), notReady: [photoId] }
export function pickZipEntries(photos, kind, photoIds) {
  const byId = new Map((photos || []).filter((p) => p && !p.role).map((p) => [p.photoId, p]));
  const pathOf = (p) => (kind === 'mls' ? p.downloadDropboxPath : p.dropboxPath);
  const ready = [];
  const notReady = [];
  for (const id of photoIds) {
    const p = byId.get(id);
    if (p && p.status === 'ok' && pathOf(p)) ready.push(p); else notReady.push(id);
  }
  ready.sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
  const names = dedupeNames(ready.map((p) => safeEntryName(baseName(pathOf(p)) || p.filename)));
  return { entries: ready.map((p, i) => ({ name: names[i], path: pathOf(p) })), notReady };
}

const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handleZip(request, env, deps, ctx, { jobId, kind }, log = () => {}) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!(m && env.RENDER_TOKEN && timingSafeEqual(m[1], env.RENDER_TOKEN))) return jsonRes(401, { error: 'unauthorized' });
  if (request.method !== 'POST') return jsonRes(405, { error: 'POST only' });

  let photoIds;
  try {
    const body = await request.json();
    photoIds = Array.isArray(body && body.photoIds) ? [...new Set(body.photoIds)] : null;
  } catch { photoIds = null; }
  if (!photoIds || photoIds.length === 0 || photoIds.length > MAX_IDS || !photoIds.every((id) => typeof id === 'string' && ID_RE.test(id))) {
    return jsonRes(400, { error: 'photoIds required' });
  }

  let photos;
  try {
    photos = await deps.sb.getProjectPhotos(jobId);
  } catch (err) {
    log({ evt: 'zip_lookup_failed', jobId, kind, error: String((err && err.message) || err) });
    return jsonRes(502, { error: 'lookup failed' });
  }
  const { entries: picked, notReady } = pickZipEntries(photos, kind, photoIds);
  if (notReady.length > 0) {
    log({ evt: 'zip_not_ready', jobId, kind, notReady });
    return jsonRes(409, { error: 'not ready', notReady });
  }

  const entries = picked.map((e) => ({
    name: e.name,
    open: async () => {
      let lastErr;
      for (let i = 0; i < OPEN_ATTEMPTS; i++) {
        try {
          const res = await deps.dbx.downloadFileStream(e.path);
          if (res && res.body) return res.body;
        } catch (err) { lastErr = err; }
        if (i < OPEN_ATTEMPTS - 1) await sleep(300 * (i + 1));
      }
      throw lastErr || new Error('empty response');
    },
  }));

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const pump = writeZip(writer, entries)
    .then((r) => log({ evt: 'zip_done', jobId, kind, written: r.written }))
    .catch((err) => {
      log({ evt: 'zip_failed', jobId, kind, error: String((err && err.message) || err) });
      return writer.abort(err).catch(() => {}); // browser sees a failed download, not a short zip
    });
  if (ctx && ctx.waitUntil) ctx.waitUntil(pump);

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${jobId}-${kind}.zip"`,
      'X-Zip-Entries': String(entries.length),
      'Cache-Control': 'no-store',
    },
  });
}
