// Thin Supabase client (raw fetch): Storage upload for thumbnails, PostgREST
// RPC for the atomic photo functions, and the single-row sync-state table
// with a lease lock. Uses the service-role key -- bypasses RLS.

export function createSupabase(env) {
  const BASE = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` };

  async function readJson(res) {
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`supabase ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    // photos/<jobId>/<photoId>_thumb.jpg  (x-upsert => create or overwrite)
    async uploadThumb(jobId, photoId, bytes) {
      const path = `photos/${encodeURIComponent(jobId)}/${photoId}_thumb.jpg`;
      const res = await fetch(`${BASE}/storage/v1/object/${path}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '3600' },
        body: bytes,
      });
      return readJson(res);
    },

    // photos/<jobId>/<photoId>_large.jpg -- the w2048h1536 render for
    // delivery-page's full-bleed slots (Cover Photo/Closing Photo/Drone
    // Callout/Local Report). Same upsert semantics as uploadThumb.
    async uploadLarge(jobId, photoId, bytes) {
      const path = `photos/${encodeURIComponent(jobId)}/${photoId}_large.jpg`;
      const res = await fetch(`${BASE}/storage/v1/object/${path}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '3600' },
        body: bytes,
      });
      return readJson(res);
    },

    async rpc(fn, args) {
      const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
      return readJson(res);
    },

    async getSyncState() {
      const res = await fetch(`${BASE}/rest/v1/photo_sync_state?id=eq.default&select=*`, { headers: authHeaders });
      const rows = await readJson(res);
      return Array.isArray(rows) ? rows[0] || null : rows;
    },

    async patchSyncState(fields) {
      const res = await fetch(`${BASE}/rest/v1/photo_sync_state?id=eq.default`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
      });
      return readJson(res);
    },

    // Atomic lease: a single UPDATE that only matches when the lock is free
    // or expired. Returns true iff this caller took the lock.
    async acquireLease(ttlMs) {
      const until = new Date(Date.now() + ttlMs).toISOString();
      const nowIso = encodeURIComponent(new Date().toISOString());
      const q = `${BASE}/rest/v1/photo_sync_state?id=eq.default&or=(locked_until.is.null,locked_until.lt.${nowIso})`;
      const res = await fetch(q, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ locked_until: until }),
      });
      const rows = await readJson(res);
      return Array.isArray(rows) && rows.length > 0;
    },

    async releaseLease() {
      const res = await fetch(`${BASE}/rest/v1/photo_sync_state?id=eq.default`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ locked_until: null }),
      });
      return readJson(res);
    },

    // One row per video awaiting Cloudflare Stream encoding.
    async insertPendingVideo({ projectId, videoId, streamUid }) {
      const res = await fetch(`${BASE}/rest/v1/video_sync_pending`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal,resolution=merge-duplicates',
        },
        body: JSON.stringify({ project_id: projectId, video_id: videoId, stream_uid: streamUid }),
      });
      return readJson(res);
    },

    async listPendingVideos() {
      const res = await fetch(`${BASE}/rest/v1/video_sync_pending?select=*`, { headers: authHeaders });
      return (await readJson(res)) || [];
    },

    async deletePendingVideo(id) {
      const res = await fetch(`${BASE}/rest/v1/video_sync_pending?id=eq.${id}`, {
        method: 'DELETE',
        headers: { ...authHeaders, Prefer: 'return=minimal' },
      });
      return readJson(res);
    },

    // The full projects.data.photos[] array for one Job, or [] if the row
    // doesn't exist yet. Used by the gallery hero/closing large-render pass
    // (see sync.js#pickGalleryFallbackTargets) -- it needs the CURRENT full
    // gallery, not just the items in the batch being processed, since which
    // photo is "3rd/5th by filename" can shift as photos are added/removed
    // in earlier batches too.
    async getProjectPhotos(jobId) {
      const res = await fetch(`${BASE}/rest/v1/projects?id=eq.${encodeURIComponent(jobId)}&select=data`, {
        headers: authHeaders,
      });
      const rows = await readJson(res);
      const row = Array.isArray(rows) ? rows[0] : rows;
      return (row && row.data && row.data.photos) || [];
    },

    // One video's current record from projects.data.videos[], or null. Used
    // before a Dropbox-side delete to find the streamUid to free in Stream.
    async getProjectVideo(projectId, videoId) {
      const res = await fetch(`${BASE}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=data`, {
        headers: authHeaders,
      });
      const rows = await readJson(res);
      const row = Array.isArray(rows) ? rows[0] : rows;
      const videos = (row && row.data && row.data.videos) || [];
      return videos.find((v) => v.videoId === videoId) || null;
    },

    // One row per delivery-copy/large-render that failed and needs periodic
    // retry (see photo_render_pending in schema.sql). merge-duplicates on the
    // (project_id, kind, source_path) unique key -- a photo that fails twice
    // before the next poll just keeps one row rather than piling up.
    async insertPendingRender({ projectId, kind, sourcePath, destPath, photoId: pid, filename, error }) {
      const res = await fetch(`${BASE}/rest/v1/photo_render_pending`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal,resolution=merge-duplicates',
        },
        body: JSON.stringify({
          project_id: projectId,
          kind,
          source_path: sourcePath,
          dest_path: destPath || null,
          photo_id: pid || null,
          filename: filename || null,
          last_error: error || null,
        }),
      });
      return readJson(res);
    },

    async listPendingRenders() {
      const res = await fetch(`${BASE}/rest/v1/photo_render_pending?select=*`, { headers: authHeaders });
      return (await readJson(res)) || [];
    },

    async updatePendingRender(id, fields) {
      const res = await fetch(`${BASE}/rest/v1/photo_render_pending?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
      });
      return readJson(res);
    },

    async deletePendingRender(id) {
      const res = await fetch(`${BASE}/rest/v1/photo_render_pending?id=eq.${id}`, {
        method: 'DELETE',
        headers: { ...authHeaders, Prefer: 'return=minimal' },
      });
      return readJson(res);
    },
  };
}
