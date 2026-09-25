// Worker-level Delivery Hub routing + admin switches, Supabase (global fetch) faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = 'c'.repeat(32);
const GTOKEN = 'd'.repeat(32);
const JOB = 'FVS-20260925-001';
const PROJECT = { id: JOB, data: { address: '12 Main St, Toronto', tourUrl: 'https://my.matterport.com/show/?m=x' } };

function setup({ paid = false, unlocked = false, gallery = true } = {}) {
  const state = { row: {
    job_id: JOB, token: TOKEN, paid, unlocked, wave_view_url: 'https://next.waveapps.com/pay/abc', total_cents: 11300,
    lines: [{ key: 'HDR' }, { key: 'MLS', url: 'https://www.dropbox.com/scl/fo/mls' }, { key: 'THREE_D' }, { key: 'HOME_REPORT' }],
  }, patches: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/delivery_hub')) {
      if (init.method === 'PATCH') {
        if (!u.includes(`job_id=eq.${JOB}`)) return json([]);
        const body = JSON.parse(init.body);
        state.patches.push(body);
        Object.assign(state.row, body);
        return json([state.row]);
      }
      if (u.includes('select=job_id,token,paid,unlocked')) return json([state.row]);
      return json(u.includes(`token=eq.${TOKEN}`) ? [state.row] : []);
    }
    if (u.includes('/rest/v1/gallery_tokens')) return json(gallery && u.includes(`job_id=eq.${JOB}`) ? [{ token: GTOKEN }] : []);
    if (u.includes('/rest/v1/projects')) return json(u.includes(`id=eq.${JOB}`) ? [PROJECT] : [{ id: JOB, data: PROJECT.data, updated_at: '2026-09-25T10:00:00Z' }]);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm' }, state };
}
const get = (env, path) => worker.fetch(new Request('https://realgta.ca' + path, { redirect: 'manual' }), env);
const post = (env, path, body, auth = 'Bearer adm') => worker.fetch(new Request('https://realgta.ca' + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);

test('hub page: 200 for a valid token (slug cosmetic), unknown / malformed token -> identical 404', async () => {
  const { env } = setup();
  for (const slug of ['12-main-st-toronto', 'whatever']) {
    const res = await get(env, `/deliver/${slug}/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /Please pay to unlock/);
  }
  const a = await get(env, `/deliver/x/${'e'.repeat(32)}`);
  const b = await get(env, `/deliver/x/${JOB}`);
  assert.equal(a.status, 404); assert.equal(b.status, 404);
  assert.equal(await a.text(), await b.text());
});

test('gate: unpaid /go/<KEY> never redirects -- it re-renders the hub with the dialog open', async () => {
  const { env } = setup();
  const res = await get(env, `/deliver/x/${TOKEN}/go/MLS`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
  const html = await res.text();
  assert.doesNotMatch(html, /dropbox\.com/);
  assert.match(html, /open\(\);/);
});

test('paid: MLS -> its stored link, HDR -> the Gallery page, THREE_D -> tourUrl (all 302, no-store)', async () => {
  const { env } = setup({ paid: true });
  const go = async (k) => get(env, `/deliver/x/${TOKEN}/go/${k}`);
  let r = await go('MLS');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://www.dropbox.com/scl/fo/mls'); assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await go('HDR');
  assert.equal(r.headers.get('location'), `/delivery/12-main-st-toronto/${GTOKEN}`);
  r = await go('THREE_D');
  assert.equal(r.headers.get('location'), 'https://my.matterport.com/show/?m=x');
});

test('"deliver first" switch: unlocked (not paid) opens the same buttons', async () => {
  const { env } = setup({ unlocked: true });
  const r = await get(env, `/deliver/x/${TOKEN}/go/MLS`);
  assert.equal(r.status, 302);
});

test('paid but not ready / not this Job\'s line / bad key -> friendly page or 404, never a redirect', async () => {
  const { env } = setup({ paid: true, gallery: false });
  let r = await get(env, `/deliver/x/${TOKEN}/go/HDR`);          // no Gallery token yet
  assert.equal(r.status, 503); assert.match(await r.text(), /isn't ready yet/);
  r = await get(env, `/deliver/x/${TOKEN}/go/HOME_REPORT`);       // line has no link
  assert.equal(r.status, 503);
  r = await get(env, `/deliver/x/${TOKEN}/go/VIDEO`);             // not one of this Job's lines
  assert.equal(r.status, 503);
  r = await get(env, `/deliver/x/${TOKEN}/go/NOPE`);
  assert.equal(r.status, 404);
});

test('admin: POST /admin/hub/<jobId> needs the admin token, flips paid/unlocked, and the page unlocks', async () => {
  const { env, state } = setup();
  assert.equal((await post(env, `/admin/hub/${JOB}`, { paid: true }, 'Bearer nope')).status, 401);
  assert.equal((await post(env, `/admin/hub/${JOB}`, { junk: 1 })).status, 400);
  assert.equal((await post(env, '/admin/hub/FVS-20260925-999', { paid: true })).status, 404);
  const ok = await post(env, `/admin/hub/${JOB}`, { paid: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { jobId: JOB, paid: true, unlocked: false });
  assert.equal(state.patches.length, 1);
  assert.equal((await get(env, `/deliver/x/${TOKEN}/go/MLS`)).status, 302);
  await post(env, `/admin/hub/${JOB}`, { paid: false, unlocked: true });
  assert.equal(state.row.unlocked, true);
});

test('admin directory: Delivery + Payment columns show for a Job with a hub row', async () => {
  const { env } = setup({ paid: true });
  const html = await (await get(env, '/admin?admin=adm')).text();
  assert.match(html, new RegExp(`/deliver/12-main-st-toronto/${TOKEN}`));
  assert.match(html, /data-flag="paid" checked/);
  assert.match(html, /data-flag="unlocked">/);
});

test('status: a tiny no-store {unlocked} the locked page polls; flips as soon as Franky marks the Job paid; wrong token = 404', async () => {
  const { env } = setup();
  let r = await get(env, `/deliver/x/${TOKEN}/status`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { unlocked: false });
  await post(env, `/admin/hub/${JOB}`, { paid: true });
  assert.deepEqual(await (await get(env, `/deliver/x/${TOKEN}/status`)).json(), { unlocked: true });
  assert.equal((await get(env, `/deliver/x/${'e'.repeat(32)}/status`)).status, 404);
});

test('locked page polls its own status URL after the dialog opens; unlocked page carries no script', async () => {
  const { env } = setup();
  const locked = await (await get(env, `/deliver/x/${TOKEN}`)).text();
  assert.match(locked, new RegExp(`/deliver/x/${TOKEN}/status`));
  assert.doesNotMatch(locked, /Already paid|Refresh/);
  const { env: env2 } = setup({ paid: true });
  const open = await (await get(env2, `/deliver/x/${TOKEN}`)).text();
  assert.doesNotMatch(open, /\/status/);
});
