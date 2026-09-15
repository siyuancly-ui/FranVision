// Thin Cloudflare Stream REST client (raw fetch, no SDK) -- same shape as
// dropbox.js / supabase.js. "Copy from URL" lets Stream fetch the source
// itself, so the Worker never proxies video bytes.

export function createStream(env) {
  const BASE = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream`;
  const authHeaders = { Authorization: `Bearer ${env.CF_STREAM_API_TOKEN}` };

  async function readJson(res) {
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok || (body && body.success === false)) {
      const err = new Error(`cloudflare stream ${res.status}: ${text}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body && body.result;
  }

  return {
    // Kicks off an async fetch-and-encode; returns immediately with a uid.
    // `meta` is opaque key/value shown in the Stream dashboard -- handy for
    // tracing a stuck upload back to a job/video without another lookup.
    async copyFromUrl(url, meta) {
      const res = await fetch(`${BASE}/copy`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, meta }),
      });
      return readJson(res);
    },

    async getStatus(uid) {
      const res = await fetch(`${BASE}/${uid}`, { headers: authHeaders });
      return readJson(res);
    },

    // Ignore "not found" -- the video may already be gone.
    async deleteVideo(uid) {
      const res = await fetch(`${BASE}/${uid}`, { method: 'DELETE', headers: authHeaders });
      if (res.status === 404) return { skipped: 'not_found' };
      return readJson(res);
    },
  };
}
