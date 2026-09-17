// Thin Dropbox REST client (raw fetch, no SDK). One factory returns an
// object bound to `env`; a module-scope cache holds the short-lived access
// token, minted from the refresh token and reused across invocations while
// the isolate lives.

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const TOKEN_URL = 'https://api.dropbox.com/oauth2/token';

let _token = null; // { value, expiresAt }

function b64(s) {
  return btoa(typeof s === 'string' ? s : String(s));
}

async function mintToken(env) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.DROPBOX_REFRESH_TOKEN });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + b64(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`dropbox token refresh ${res.status}: ${text}`);
  const json = JSON.parse(text);
  _token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
  return _token.value;
}

async function getToken(env, force = false) {
  if (!force && _token && Date.now() < _token.expiresAt) return _token.value;
  return mintToken(env);
}

// RPC-style endpoint (JSON in, JSON out). `base` is API or CONTENT.
async function rpc(env, base, endpoint, arg, { retryOn401 = true } = {}) {
  const doCall = async (token) =>
    fetch(`${base}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arg ?? null),
    });

  let res = await doCall(await getToken(env));
  if (res.status === 401 && retryOn401) res = await doCall(await getToken(env, true));

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`dropbox ${endpoint} ${res.status}: ${text}`);
    err.status = res.status;
    try { err.body = JSON.parse(text); } catch { /* keep string */ }
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function summarize(err) {
  const b = err && err.body;
  if (b && b.error_summary) return String(b.error_summary);
  return String((err && err.message) || err);
}

export function createDropbox(env) {
  const TEMPLATE_ID = env.DROPBOX_TEMPLATE_ID;

  return {
    // recursive cursor for "everything from now on" -- no enumeration
    async listFolderGetLatestCursor(rootPath) {
      const out = await rpc(env, API, 'files/list_folder/get_latest_cursor', {
        path: rootPath || '',
        recursive: true,
        include_media_info: true,
        include_deleted: false,
      });
      return out.cursor;
    },

    async listFolder(rootPath) {
      return rpc(env, API, 'files/list_folder', {
        path: rootPath || '',
        recursive: true,
        include_media_info: true,
        include_deleted: false,
      });
    },

    async listFolderContinue(cursor) {
      return rpc(env, API, 'files/list_folder/continue', { cursor });
    },

    // A ~4h-lived direct-download URL for a file -- handed to Cloudflare
    // Stream's "copy from URL" so the Worker never proxies video bytes.
    async getTemporaryLink(path) {
      return rpc(env, API, 'files/get_temporary_link', { path });
    },

    // Raw text content of a small file (the Tour Link .txt file -- see
    // tour-link-sync.js). Dropbox's content-download endpoint: the response
    // BODY is the file bytes, metadata is in a header (ignored here).
    async downloadText(path) {
      const doCall = async (token) =>
        fetch(`${CONTENT}/files/download`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
        });
      let res = await doCall(await getToken(env));
      if (res.status === 401) res = await doCall(await getToken(env, true));
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`dropbox files/download ${res.status}: ${text}`);
      }
      return res.text();
    },

    async getMetadata(path, { withPropertyGroups = false, includeMediaInfo = false } = {}) {
      const arg = { path };
      if (withPropertyGroups && TEMPLATE_ID) {
        arg.include_property_groups = { '.tag': 'filter_some', filter_some: [TEMPLATE_ID] };
      }
      if (includeMediaInfo) arg.include_media_info = true;
      return rpc(env, API, 'files/get_metadata', arg);
    },

    // JSON out, base64 `thumbnail` per entry. Max 25 entries/call.
    // mode 'bestfit' = scale to fit inside the box, keep aspect ratio, NO
    // crop -- right for a delivery/gallery thumbnail (a 3:2 photo in the
    // 1024x768 box comes out 1024x683).
    async getThumbnailBatch(paths, size) {
      const arg = {
        entries: paths.map((p) => ({
          path: p,
          format: 'jpeg',
          size,
          mode: 'bestfit',
        })),
      };
      return rpc(env, CONTENT, 'files/get_thumbnail_batch', arg);
    },

    // Single-file thumbnail -- fallback when a batch entry fails or the
    // batch endpoint rejects a size. Returns raw bytes (Uint8Array); the
    // image is the response BODY, metadata is in the Dropbox-API-Result
    // header (ignored here).
    async getThumbnailV2(path, size) {
      const arg = { resource: { '.tag': 'path', path }, format: 'jpeg', size, mode: 'bestfit' };
      const doCall = async (token) =>
        fetch(`${CONTENT}/files/get_thumbnail_v2`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(arg) },
        });
      let res = await doCall(await getToken(env));
      if (res.status === 401) res = await doCall(await getToken(env, true));
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`dropbox get_thumbnail_v2 ${res.status}: ${text}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async filesUpload(path, bytes) {
      const doCall = async (token) =>
        fetch(`${CONTENT}/files/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true, strict_conflict: false }),
          },
          body: bytes,
        });
      let res = await doCall(await getToken(env));
      if (res.status === 401) res = await doCall(await getToken(env, true));
      const text = await res.text();
      if (!res.ok) throw new Error(`dropbox files/upload ${res.status}: ${text}`);
      return JSON.parse(text);
    },

    // Ignore "not found" -- the derivative may already be gone.
    async filesDelete(path) {
      try {
        return await rpc(env, API, 'files/delete_v2', { path });
      } catch (err) {
        if (summarize(err).includes('not_found')) return { skipped: 'not_found' };
        throw err;
      }
    },

    // Locate a job folder by its hidden jobId value. Returns { id, path } | null.
    async propertiesSearch(jobId, templateId = TEMPLATE_ID) {
      const out = await rpc(env, API, 'file_properties/properties/search', {
        queries: [{
          query: jobId,
          mode: { '.tag': 'field_name', field_name: 'jobId' },
          logical_operator: 'or_operator',
        }],
        template_filter: templateId ? { '.tag': 'filter_some', filter_some: [templateId] } : { '.tag': 'filter_none' },
      });
      const m = (out.matches || []).find((x) => !x.is_deleted) || (out.matches || [])[0];
      return m ? { id: m.id, path: m.path } : null;
    },
  };
}

export { summarize as dropboxErrorSummary };
