// FranVision Job Generator -- shared job backend client (Supabase RPC).
//
// The SERVER is the single authority for Job ID assignment and for job/draft
// metadata, so several machines (Mac + Franky's Windows) never disagree --
// see supabase/schema.sql for why (2026-09-15 ID collisions) and for the
// access model: RLS on, no table policies, every RPC needs JG_TOKEN.
//
// Optional: with JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY / JG_TOKEN unset the
// tool behaves exactly as before (local-only IDs and drafts) -- so an
// install without them, and every unit test, is unaffected.
//
// Errors: every call throws a BackendError. `err.unreachable` is true when
// the request never got an answer (offline / DNS / timeout) -- server.js
// turns that into "creating or updating a job needs an internet
// connection" instead of guessing an ID locally (explicit decision
// 2026-09-19: no offline job creation, no temporary IDs).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const TIMEOUT_MS = 12000;

class BackendError extends Error {
  constructor(message, { unreachable = false, status = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.unreachable = unreachable;
    this.status = status;
  }
}

function config(env) {
  env = env || process.env;
  return {
    url: String(env.JG_SUPABASE_URL || '').replace(/\/+$/, ''),
    anonKey: env.JG_SUPABASE_ANON_KEY || '',
    token: env.JG_TOKEN || '',
  };
}

function isConfigured(env) {
  const c = config(env);
  return !!(c.url && c.anonKey && c.token);
}

// `deps.fetchImpl` / `deps.env` are test seams; production callers pass none.
async function rpc(name, args, deps) {
  deps = deps || {};
  const c = config(deps.env);
  if (!(c.url && c.anonKey && c.token)) throw new BackendError('Job server is not configured (JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY / JG_TOKEN).');
  const fetchImpl = deps.fetchImpl || fetch;

  let res;
  try {
    res = await fetchImpl(c.url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { apikey: c.anonKey, Authorization: 'Bearer ' + c.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ p_token: c.token }, args || {})),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new BackendError('Could not reach the job server: ' + (err && err.message || err), { unreachable: true });
  }

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && (body.message || body.error)) || String(text || res.status);
    throw new BackendError('Job server error (' + res.status + '): ' + msg, { status: res.status });
  }
  return body;
}

const IMAGE_BUCKET = 'jg-shoot-notes';

function publicImageUrl(objectPath, deps) {
  return config(deps && deps.env).url + '/storage/v1/object/public/' + IMAGE_BUCKET + '/' + objectPath;
}

// Uploads one shoot-notes image (see supabase/storage.sql) and returns the
// PUBLIC link. `objectPath` must already be unguessable (server.js builds it
// from crypto.randomBytes). The machine token rides in `x-jg-token`, which the
// bucket's INSERT policy checks. Same error contract as rpc().
async function uploadImage({ objectPath, contentType, buffer }, deps) {
  deps = deps || {};
  const c = config(deps.env);
  if (!(c.url && c.anonKey && c.token)) throw new BackendError('Job server is not configured (JG_SUPABASE_URL / JG_SUPABASE_ANON_KEY / JG_TOKEN).');
  const fetchImpl = deps.fetchImpl || fetch;
  let res;
  try {
    res = await fetchImpl(c.url + '/storage/v1/object/' + IMAGE_BUCKET + '/' + objectPath, {
      method: 'POST',
      headers: {
        apikey: c.anonKey, Authorization: 'Bearer ' + c.anonKey,
        'x-jg-token': c.token, 'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: buffer,
      signal: AbortSignal.timeout(deps.timeoutMs || 60000),
    });
  } catch (err) {
    throw new BackendError('Could not reach the job server: ' + (err && err.message || err), { unreachable: true });
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { const b = JSON.parse(text); msg = b.message || b.error || text; } catch (e) { /* keep text */ }
    throw new BackendError('Image upload failed (' + res.status + '): ' + msg, { status: res.status });
  }
  return publicImageUrl(objectPath, deps);
}

const dayStamp = (date) => {
  const d = date || new Date();
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
};

async function allocateJobId({ date, floor } = {}, deps) {
  return rpc('jg_allocate_job_id', { p_day: dayStamp(date), p_floor: floor || 0 }, deps);
}
async function peekJobId({ date, floor } = {}, deps) {
  return rpc('jg_peek_job_id', { p_day: dayStamp(date), p_floor: floor || 0 }, deps);
}
async function upsertJob(row, deps) { return rpc('jg_upsert_job', { p_row: row }, deps); }
// Random per-Job token for the standalone Gallery page URL (see
// supabase/gallery.sql). Idempotent: the same Job always gets the same token.
async function getGalleryToken(jobId, deps) {
  const t = await rpc('jg_gallery_token', { p_job_id: jobId }, deps);
  return typeof t === 'string' && t ? t : null;
}
// Delivery Hub (see supabase/delivery-hub.sql): saves which download buttons this Job has (+ the Dropbox
// link behind each), the Wave payment link and the invoice total, and returns the Job's hub URL token
// (stable per Job; paid/unlocked are owned by the admin side and never touched here).
// Wave's GraphQL invoice id is base64("Business:<uuid>;Invoice:<n>"); its webhooks report just <n> (19 digits,
// beyond a JS safe integer -- always a string). Returns the digits, or null when the id isn't in either form.
function waveInvoiceNumber(id) {
  const s = String(id || '').trim();
  if (/^[0-9]{1,30}$/.test(s)) return s;
  try {
    const m = /Invoice:([0-9]{1,30})$/.exec(Buffer.from(s, 'base64').toString('utf8'));
    return m ? m[1] : null;
  } catch (e) { return null; }
}
async function saveDeliveryHub({ jobId, lines, waveViewUrl, totalCents, waveInvoiceId, preTaxCents, clientName }, deps) {
  const t = await rpc('jg_delivery_hub', {
    p_job_id: jobId,
    p_lines: lines || [],
    p_wave_view_url: waveViewUrl || null,
    p_total_cents: Number.isInteger(totalCents) ? totalCents : null,
    p_wave_invoice_id: waveInvoiceNumber(waveInvoiceId),
    p_pretax_cents: Number.isInteger(preTaxCents) ? preTaxCents : null,
    p_client_name: clientName ? String(clientName) : null,
  }, deps);
  return typeof t === 'string' && t ? t : null;
}
async function getJob(folderName, deps) { return rpc('jg_get_job', { p_folder_name: folderName }, deps); }
async function listDrafts(deps) { return rpc('jg_list_jobs', { p_kind: 'drafts' }, deps); }
// 'recent' used to mean "created in the last 3 days"; since 2026-09-22 it means "not yet marked
// Complete" (see completeJob below) -- kept permanently until completed, no time window at all.
async function listRecentJobs(deps) { return rpc('jg_list_jobs', { p_kind: 'recent' }, deps); }
async function deleteDraft(folderName, deps) { return rpc('jg_delete_draft', { p_folder_name: folderName }, deps); }
// Marks a real job Complete server-side (atomic jsonb_set on data.job.completedAt -- see
// supabase/schema.sql) so it drops out of every machine's Recent Jobs list. Throws BackendError
// with `notFound: true` when the folder has no row on the server yet (a legacy local-only job) --
// server.js treats that as "nothing to do here", not a failure.
async function completeJob(folderName, deps) {
  try {
    return await rpc('jg_complete_job', { p_folder_name: folderName }, deps);
  } catch (err) {
    if (err instanceof BackendError && /not found/i.test(err.message)) err.notFound = true;
    throw err;
  }
}

// Wave customer pairing history (2026-09-23, see supabase/schema.sql jg_wave_pairings): which Wave
// customer a Client Name ended up billed to. record = +1 use of that pairing; suggest = ranked matches
// ([{waveCustomerId, waveCustomerName, clientName, useCount, lastUsedAt, match:'exact'|'partial'}]).
async function recordWavePairing({ clientName, waveCustomerId, waveCustomerName }, deps) {
  return rpc('jg_record_wave_pairing', { p_client_name: clientName, p_wave_customer_id: waveCustomerId, p_wave_customer_name: waveCustomerName || '' }, deps);
}
async function suggestWavePairings(clientName, deps) {
  return rpc('jg_suggest_wave_pairings', { p_client_name: clientName }, deps);
}

// Wave product-id map (2026-09-24, see supabase/schema.sql jg_wave_map): one shared { pricingId: waveProductId }
// object instead of a per-machine file. set = upsert of the given keys (others untouched); both return the full map.
async function getWaveMap(deps) { return rpc('jg_get_wave_map', {}, deps); }
async function setWaveMap(map, deps) { return rpc('jg_set_wave_map', { p_map: map }, deps); }

module.exports = {
  uploadImage, publicImageUrl, IMAGE_BUCKET,
  BackendError, isConfigured, rpc, dayStamp, getGalleryToken, saveDeliveryHub, waveInvoiceNumber,
  allocateJobId, peekJobId, upsertJob, getJob, listDrafts, listRecentJobs, deleteDraft, completeJob,
  recordWavePairing, suggestWavePairings, getWaveMap, setWaveMap,
};
