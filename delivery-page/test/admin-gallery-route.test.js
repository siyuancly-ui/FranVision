// Worker-level tests for the admin directory's Gallery support: every Job gets its
// Gallery link automatically when the directory loads (no button).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ROWS = [
  { id: 'FVS-20260924-001', data: { address: '12 Main St, Toronto' }, updated_at: '2026-09-24T10:00:00Z' },
  { id: 'FVS-20260925-002', data: { address: '48 Red Ash Dr, Oakville' }, updated_at: '2026-09-25T09:00:00Z' },
];

function setup({ tokens = [], tableMissing = false } = {}) {
  const calls = [];
  const store = [...tokens];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, method: init.method || 'GET' });
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/gallery_tokens')) {
      if (tableMissing) return json({ message: 'relation does not exist' }, 404);
      if (init.method === 'POST') {
        for (const row of JSON.parse(init.body)) if (!store.some((r) => r.job_id === row.job_id)) store.push(row); // ignore-duplicates
        return new Response('', { status: 201 });
      }
      return json(store);
    }
    if (u.includes('/rest/v1/projects')) return json(ROWS);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm' }, calls, store };
}
const get = (env, path = '/admin?admin=adm') => worker.fetch(new Request('https://realgta.ca' + path), env);
const tokenOf = (html, slug) => new RegExp(`/delivery/${slug}/([0-9a-f]{32})`).exec(html)?.[1];

test('loading /admin creates a Gallery link for every Job that has none -- no button involved', async () => {
  const { env, store } = setup();
  const html = await (await get(env)).text();
  assert.equal(store.length, 2);
  assert.match(tokenOf(html, '12-main-st-toronto'), /^[0-9a-f]{32}$/);
  assert.match(tokenOf(html, '48-red-ash-dr-oakville'), /^[0-9a-f]{32}$/);
  assert.doesNotMatch(html, /Create link|create-btn/);
  assert.doesNotMatch(html, /class="open-link is-off"/);  // both columns active for both Jobs
});

test('links are stable: reloading never changes a token, and existing tokens (from Job Generator) are kept', async () => {
  const mine = 'a'.repeat(32);
  const { env, store } = setup({ tokens: [{ job_id: 'FVS-20260924-001', token: mine }] });
  const first = await (await get(env)).text();
  assert.equal(tokenOf(first, '12-main-st-toronto'), mine);      // untouched
  const second = await (await get(env)).text();
  assert.equal(tokenOf(second, '12-main-st-toronto'), mine);
  assert.equal(tokenOf(second, '48-red-ash-dr-oakville'), tokenOf(first, '48-red-ash-dr-oakville'));
  assert.equal(store.length, 2);
});

test('only the Jobs missing a token are inserted (one batched request, and none when all have one)', async () => {
  const all = ROWS.map((r, i) => ({ job_id: r.id, token: String(i).repeat(32) }));
  const { env, calls } = setup({ tokens: all });
  await get(env);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  const s2 = setup({ tokens: [all[0]] });
  await get(s2.env);
  assert.equal(s2.calls.filter((c) => c.method === 'POST').length, 1);
});

test('if the gallery_tokens table does not exist yet, the directory still loads (Gallery column greyed out)', async () => {
  const { env } = setup({ tableMissing: true });
  const res = await get(env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /12-main-st-toronto\/FVS-20260924-001/);     // All in One links unaffected
  assert.match(html, /class="open-link is-off"/);
});

test('the old "create link" endpoint is gone; /admin still needs the admin token', async () => {
  const { env } = setup();
  const res = await worker.fetch(new Request('https://realgta.ca/admin/gallery-link/FVS-20260924-001?admin=adm', { method: 'POST' }), env);
  assert.equal(res.status, 404);
  assert.equal((await get(env, '/admin')).status, 401);
  assert.equal((await get(env, '/admin?admin=wrong')).status, 401);
});
