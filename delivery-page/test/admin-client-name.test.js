// Worker-level: the /admin directory pulls each Job's Client Name from Job Generator's shared table (jg_jobs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ROWS = [
  { id: 'FVS-20260925-001', data: { address: '12 Main St, Toronto' }, updated_at: '2026-09-25T10:00:00Z' },
  { id: 'FVS-20260925-002', data: { address: '48 Red Ash Dr, Oakville' }, updated_at: '2026-09-25T09:00:00Z' },
];

function setup({ jgJobsMissing = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/jg_jobs')) {
      if (jgJobsMissing) return json({ message: 'nope' }, 401);
      return json([{ job_id: 'FVS-20260925-001', client_name: 'Jessie Tang' }, { job_id: 'FVS-20260925-002', client_name: 'Amy Wong' }]);
    }
    if (u.includes('/rest/v1/gallery_tokens')) return json([]);
    if (u.includes('/rest/v1/delivery_hub')) return json([]);
    if (u.includes('/rest/v1/projects')) return json(ROWS);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm' }, calls };
}
const get = (env) => worker.fetch(new Request('https://realgta.ca/admin?admin=adm'), env);

test('/admin: the Agent column shows the Client Name typed in Job Generator, sorted by it; only real Jobs (job_id set) are asked for', async () => {
  const { env, calls } = setup();
  const html = await (await get(env)).text();
  assert.match(html, /<td class="agent">Jessie Tang<\/td>/);
  assert.match(html, /<td class="agent">Amy Wong<\/td>/);
  assert.ok(html.indexOf('Amy Wong') < html.indexOf('Jessie Tang'), 'Amy before Jessie (A-Z by first name)');
  assert.ok(calls.some((u) => u.includes('/rest/v1/jg_jobs?job_id=not.is.null')), 'drafts (job_id null) are excluded');
});

test('/admin: if the job table cannot be read the directory still loads (Agent shows a dash)', async () => {
  const { env } = setup({ jgJobsMissing: true });
  const res = await get(env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<td class="agent">—<\/td>/);
});
