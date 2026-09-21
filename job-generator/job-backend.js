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
async function getJob(folderName, deps) { return rpc('jg_get_job', { p_folder_name: folderName }, deps); }
async function listDrafts(deps) { return rpc('jg_list_jobs', { p_kind: 'drafts' }, deps); }
async function listRecentJobs(sinceIso, deps) { return rpc('jg_list_jobs', { p_kind: 'recent', p_since: sinceIso || null }, deps); }
async function deleteDraft(folderName, deps) { return rpc('jg_delete_draft', { p_folder_name: folderName }, deps); }

module.exports = {
  BackendError, isConfigured, rpc, dayStamp,
  allocateJobId, peekJobId, upsertJob, getJob, listDrafts, listRecentJobs, deleteDraft,
};
