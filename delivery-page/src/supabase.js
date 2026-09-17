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

    // Every projects row (id, data, updated_at), newest-updated first -- the
    // admin directory's one query (see src/admin.js). Same shared table
    // Feature Sheet Builder's own admin view lists from; a Job's presence
    // here doesn't imply it has photos/a tour link/anything specific, same
    // as FSB's admin doesn't filter to "real feature sheets" either.
    async listProjects() {
      const res = await fetch(`${BASE}/rest/v1/projects?select=id,data,updated_at&order=updated_at.desc`, {
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
