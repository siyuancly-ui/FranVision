// Thin Supabase client (raw fetch), same shape as photo-sync-worker's
// src/supabase.js. This Worker only reads `projects` (photo-sync-worker owns
// writing photos/videos) and writes the small set of delivery-specific
// fields (address, tourUrl, tourType) via one RPC.

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
    // Full projects row (id, data, updated_at) for one Job, or null.
    async getProject(jobId) {
      const res = await fetch(`${BASE}/rest/v1/projects?id=eq.${encodeURIComponent(jobId)}&select=*`, {
        headers: authHeaders,
      });
      const rows = await readJson(res);
      return Array.isArray(rows) ? rows[0] || null : rows;
    },

    // Gallery page: the Job a random URL token was minted for (see
    // job-generator/supabase/gallery.sql), or null. `token` must already have
    // passed gallery.js#isGalleryToken.
    async getGalleryJobId(token) {
      const res = await fetch(`${BASE}/rest/v1/gallery_tokens?token=eq.${encodeURIComponent(token)}&select=job_id`, {
        headers: authHeaders,
      });
      const rows = await readJson(res);
      return Array.isArray(rows) && rows[0] ? rows[0].job_id : null;
    },

    // Source paths (the photos' dropboxPath) of this Job's 2048px MLS copies that
    // photo-sync-worker has queued for (re)generation -- i.e. recorded but not yet
    // written. Empty (never throws) if the table can't be read.
    async listPendingCopySources(jobId) {
      try {
        const res = await fetch(`${BASE}/rest/v1/photo_render_pending?project_id=eq.${encodeURIComponent(jobId)}&kind=eq.download_copy&select=source_path`, { headers: authHeaders });
        return new Set(((await readJson(res)) || []).map((r) => r.source_path));
      } catch {
        return new Set();
      }
    },

    // Every Job's gallery token, { jobId: token } -- one query for the admin
    // directory. Empty (never throws) if the table isn't there yet
    // (job-generator/supabase/gallery.sql not run), so the directory still loads.
    async listGalleryTokens() {
      try {
        const res = await fetch(`${BASE}/rest/v1/gallery_tokens?select=job_id,token`, { headers: authHeaders });
        const rows = await readJson(res);
        return Object.fromEntries((rows || []).map((r) => [r.job_id, r.token]));
      } catch {
        return {};
      }
    },

    // Guarantees every given Job has a gallery token, minting random 128-bit
    // hex ones (the same kind the job server's jg_gallery_token() mints) for
    // those that don't -- one insert-ignore-duplicates for the whole batch, so
    // it is idempotent and safe against a race with Job Generator (whoever gets
    // there first wins; a link already emailed can never change). Returns the
    // full { jobId: token } map afterwards. Never throws: if the table isn't
    // there yet, returns whatever could be read (usually {}).
    async ensureGalleryTokens(jobIds) {
      const existing = await this.listGalleryTokens();
      const missing = (jobIds || []).filter((id) => !existing[id]);
      if (missing.length === 0) return existing;
      const rows = missing.map((job_id) => ({
        job_id,
        token: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
      }));
      try {
        await readJson(await fetch(`${BASE}/rest/v1/gallery_tokens`, {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(rows),
        }));
      } catch {
        return existing; // table missing / transient -- the directory still loads, links just not there yet
      }
      return this.listGalleryTokens();
    },

    // Delivery Hub (job-generator/supabase/delivery-hub.sql): the delivery_hub row a URL
    // token was minted for, or null. `token` must already have passed hub.js#isHubToken.
    async getHubByToken(token) {
      const res = await fetch(`${BASE}/rest/v1/delivery_hub?token=eq.${encodeURIComponent(token)}&select=*`, { headers: authHeaders });
      const rows = await readJson(res);
      return Array.isArray(rows) ? rows[0] || null : rows;
    },

    // This Job's Gallery token (the HDR button's target), or null.
    async getGalleryTokenForJob(jobId) {
      const res = await fetch(`${BASE}/rest/v1/gallery_tokens?job_id=eq.${encodeURIComponent(jobId)}&select=token`, { headers: authHeaders });
      const rows = await readJson(res);
      return Array.isArray(rows) && rows[0] ? rows[0].token : null;
    },

    // Every Job's hub state, { jobId: {token, paid, unlocked} } -- the admin directory's one
    // query. Empty (never throws) if the table isn't there yet (delivery-hub.sql not run).
    async listHubs() {
      try {
        const res = await fetch(`${BASE}/rest/v1/delivery_hub?select=job_id,token,paid,unlocked`, { headers: authHeaders });
        const rows = await readJson(res);
        return Object.fromEntries((rows || []).map((r) => [r.job_id, { token: r.token, paid: !!r.paid, unlocked: !!r.unlocked }]));
      } catch {
        return {};
      }
    },

    // Admin: flips paid / unlocked for one Job. Returns the updated row, or null when the
    // Job has no hub row (no Create/Update Job since the hub existed).
    async setHubFlags(jobId, flags) {
      const res = await fetch(`${BASE}/rest/v1/delivery_hub?job_id=eq.${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ ...flags, updated_at: new Date().toISOString() }),
      });
      const rows = await readJson(res);
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },

    // Every Job's projects row (id, data, updated_at), newest-updated first
    // -- the admin directory's one query (see src/admin.js). `projects` is
    // shared with Feature Sheet Builder, whose own projects today use a
    // random hex id (its `templateSystem`/`agentInfo`/`confirmed` shape, not
    // a Job at all) -- filtered out by `id=like.FVS-*` so they don't clutter
    // a directory of delivery pages. Job Generator's jobIds are always
    // "FVS-YYYYMMDD-NNN" (id-generator.js), so this is a safe, permanent
    // filter, not a today-only workaround: once FSB's own projects move onto
    // the same shared jobId scheme (planned, not yet done), they'll already
    // satisfy this filter and start appearing here with no code change.
    async listProjects() {
      const res = await fetch(`${BASE}/rest/v1/projects?id=like.FVS-*&select=id,data,updated_at&order=updated_at.desc`, {
        headers: authHeaders,
      });
      return (await readJson(res)) || [];
    },

    // Merges { address, tourUrl, tourType } into projects.data for one Job.
    // Creates the projects row if it doesn't exist yet (e.g. a Job with a
    // Floor Tour/3D Tour link but no synced photos yet).
    async setDeliveryInfo(jobId, fields) {
      return this.rpc('project_set_delivery_info', {
        p_project_id: jobId,
        p_fields: fields,
      });
    },

    async rpc(fn, args) {
      const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
      return readJson(res);
    },
  };
}
