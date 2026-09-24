// Worker-level tests for the admin directory's Gallery support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const JOB = 'FVS-20260924-001';
const ROWS = [{ id: JOB, data: { address: '12 Main St, Toronto' }, updated_at: '2026-09-24T10:00:00Z' }];

function setup({ tokens = [{ job_id: JOB, token: 'a'.repeat(32) }], tableMissing = false } = {}) {
  const calls = [];
  const store = [...tokens];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, method: init.method || 'GET', body: init.body });
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/gallery_tokens')) {
      if (tableMissing) return json({ message: 'relation does not exist' }, 404);
      if (init.method === 'POST') {
        const row = JSON.parse(init.body);
        if (!store.some((r) => r.job_id === row.job_id)) store.push(row); // ignore-duplicates
        return new Response('', { status: 201 });
      }
      const m = /job_id=eq\.([^&]+)/.exec(u);
      return json(m ? store.filter((r) => r.job_id === decodeURIComponent(m[1])).map((r) => ({ token: r.token })) : store);
    }
    if (u.includes('/rest/v1/projects')) return json(u.includes(`id=eq.${JOB}`) || u.includes('id=like') ? ROWS.filter((r) => u.includes('id=like') || u.includes(r.id)) : []);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm' }, calls, store };
}
const req = (env, path, method = 'GET') => worker.fetch(new Request('https://realgta.ca' + path, { method }), env);

test('GET /admin lists each Job with both links, using the stored gallery token', async () => {
  const { env } = setup();
  const html = await (await req(env, '/admin?admin=adm')).text();
  assert.match(html, /realgta\.ca\/12-main-st-toronto\/FVS-20260924-001/);
  assert.match(html, new RegExp(`realgta\\.ca\\/delivery\\/12-main-st-toronto\\/${'a'.repeat(32)}`));
});

test('GET /admin still loads when the gallery_tokens table does not exist yet (SQL not run)', async () => {
  const { env } = setup({ tableMissing: true });
  const res = await req(env, '/admin?admin=adm');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Create link 生成链接/);
});

test('POST /admin/gallery-link/<job>: returns the existing token unchanged (idempotent)', async () => {
  const { env, store } = setup();
  const res = await req(env, `/admin/gallery-link/${JOB}?admin=adm`, 'POST');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { jobId: JOB, path: `/delivery/12-main-st-toronto/${'a'.repeat(32)}` });
  assert.equal(store.length, 1);
});

test('POST /admin/gallery-link/<job>: mints a random 32-hex token for a Job that has none, and reuses it after', async () => {
  const { env, store } = setup({ tokens: [] });
  const first = await (await req(env, `/admin/gallery-link/${JOB}?admin=adm`, 'POST')).json();
  assert.match(first.path, /^\/delivery\/12-main-st-toronto\/[0-9a-f]{32}$/);
  assert.equal(store.length, 1);
  const second = await (await req(env, `/admin/gallery-link/${JOB}?admin=adm`, 'POST')).json();
  assert.equal(second.path, first.path);
  assert.equal(store.length, 1);
});

test('POST /admin/gallery-link: needs the admin token, a real Job id, and an existing project', async () => {
  const { env } = setup();
  assert.equal((await req(env, `/admin/gallery-link/${JOB}`, 'POST')).status, 401);
  assert.equal((await req(env, `/admin/gallery-link/${JOB}?admin=wrong`, 'POST')).status, 401);
  assert.equal((await req(env, '/admin/gallery-link/not-a-job?admin=adm', 'POST')).status, 400);
  assert.equal((await req(env, '/admin/gallery-link/FVS-20260101-999?admin=adm', 'POST')).status, 404);
  assert.equal((await req(env, `/admin/gallery-link/${JOB}?admin=adm`, 'GET')).status, 404); // POST only
});
