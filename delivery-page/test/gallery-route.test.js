// Worker-level routing for the Gallery page, with Supabase (global fetch) and
// photo-sync-worker (service binding) faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = '8779efe254f329f0766d73328550ae62';
const JOB = 'FVS-20260924-001';
const PROJECT = { id: JOB, data: { address: '12 Main St, Toronto', photos: [{
  photoId: 'p1', filename: '01.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true, width: 1024, height: 683,
  dropboxPath: '/j/01.jpg', downloadDropboxPath: '/m/01.jpg',
}] } };

function setup() {
  const calls = { supabase: [], photoSync: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.supabase.push(u);
    const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/gallery_tokens')) return json(u.includes(`token=eq.${TOKEN}`) ? [{ job_id: JOB }] : []);
    if (u.includes('/rest/v1/photo_render_pending')) return json(calls.pending || []);
    if (u.includes('/rest/v1/projects')) return json(u.includes(`id=eq.${JOB}`) ? [PROJECT] : []);
    return new Response('nf', { status: 404 });
  };
  const env = {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', PHOTO_SYNC_TOKEN: 'pst', GALLERY_FOLDERS: 'HDR Photos,MLS',
    PHOTO_SYNC: { fetch: async (url, init) => { calls.photoSync.push({ url: String(url), auth: init.headers.authorization, method: init.method, body: init.body }); return calls.upstream ? calls.upstream() : new Response('ZIPBYTES', { status: 200 }); } },
  };
  return { env, calls };
}
const get = (env, path) => worker.fetch(new Request('https://realgta.ca' + path), env);

test('gallery page: 200 for a valid token, slug is cosmetic, both zip links rendered', async () => {
  const { env } = setup();
  for (const slug of ['12-main-st-toronto', 'anything-at-all']) {
    const res = await get(env, `/delivery/${slug}/${TOKEN}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Download All Original Photos/);
    assert.match(html, new RegExp(`/delivery/${slug}/${TOKEN}/zip/mls`));
  }
});

test('gallery page: unknown token, raw jobId, malformed token -> identical 404, no Supabase lookup for malformed', async () => {
  const { env, calls } = setup();
  const unknown = await get(env, `/delivery/x/${'0'.repeat(32)}`);
  const raw = await get(env, `/delivery/x/${JOB}`);
  const junk = await get(env, `/delivery/x/${TOKEN}%27or%271`);
  assert.deepEqual([unknown.status, raw.status, junk.status], [404, 404, 404]);
  assert.equal(await unknown.text(), await raw.text());
  assert.equal(calls.supabase.filter((u) => u.includes('gallery_tokens')).length, 1); // only the well-formed one hit the DB
});

test('zip: POSTs exactly the grid photo ids to photo-sync with the bearer token, named after the address', async () => {
  const { env, calls } = setup();
  const res = await get(env, `/delivery/x/${TOKEN}/zip/original`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="12-main-st-toronto-original-photos.zip"');
  assert.equal(await res.text(), 'ZIPBYTES');
  assert.equal(calls.photoSync.length, 1);
  assert.deepEqual({ ...calls.photoSync[0], body: JSON.parse(calls.photoSync[0].body) },
    { url: `https://photo-sync.internal/zip/${JOB}?kind=original`, auth: 'Bearer pst', method: 'POST', body: { photoIds: ['p1'] } });
});

test('zip: photo-sync says not ready (409) or is down -> friendly page, not a raw error', async () => {
  const { env, calls } = setup();
  calls.upstream = () => new Response('{"error":"not ready"}', { status: 409 });
  const res = await get(env, `/delivery/x/${TOKEN}/zip/original`);
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /still being prepared/);
  assert.match(html, new RegExp(`href="/delivery/x/${TOKEN}"`));
  calls.upstream = () => new Response('boom', { status: 500 });
  assert.equal((await get(env, `/delivery/x/${TOKEN}/zip/mls`)).status, 502);
});

test('zip: MLS copies not all written yet -> friendly page WITHOUT calling photo-sync', async () => {
  const { env, calls } = setup();
  PROJECT.data.photos[0].downloadDropboxPath = undefined;
  try {
    const res = await get(env, `/delivery/x/${TOKEN}/zip/mls`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /still being prepared/);
    assert.equal(calls.photoSync.length, 0);
    assert.equal((await get(env, `/delivery/x/${TOKEN}/zip/original`)).status, 200); // originals unaffected
  } finally {
    PROJECT.data.photos[0].downloadDropboxPath = '/m/01.jpg';
  }
});

test('zip/photo: bad token never reaches photo-sync; unknown kind is a 404', async () => {
  const { env, calls } = setup();
  assert.equal((await get(env, `/delivery/x/${'1'.repeat(32)}/zip/mls`)).status, 404);
  assert.equal((await get(env, `/delivery/x/${TOKEN}/zip/raw`)).status, 404);
  assert.equal((await get(env, `/delivery/x/${'1'.repeat(32)}/photo/p1`)).status, 404);
  assert.equal(calls.photoSync.length, 0);
  const ok = await get(env, `/delivery/x/${TOKEN}/photo/p1`);
  assert.equal(ok.status, 200);
  assert.equal(calls.photoSync[0].url, `https://photo-sync.internal/render/${JOB}/p1?size=web`);
});

test('existing delivery routes are not shadowed by the gallery route', async () => {
  const { env } = setup();
  assert.equal((await get(env, `/delivery/${JOB}`)).status, 200);          // old path
  assert.equal((await get(env, `/12-main-st-toronto/${JOB}`)).status, 200); // pretty path
  assert.equal((await get(env, `/delivery/${JOB}`)).headers.get('content-type').startsWith('text/html'), true);
});

test('zip mls: a copy still queued for generation -> friendly "preparing" page, photo-sync not called; queue drained -> ZIP flows with the MLS ids', async () => {
  const { env, calls } = setup();
  calls.pending = [{ source_path: '/j/01.jpg' }];
  const res = await get(env, `/delivery/x/${TOKEN}/zip/mls`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /still being prepared/);
  assert.equal(calls.photoSync.length, 0);
  calls.pending = [];
  const ok = await get(env, `/delivery/x/${TOKEN}/zip/mls`);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(calls.photoSync[0].body), { photoIds: ['p1'] });
});

test('gallery page shows the disabled "Preparing MLS Photos" button while a copy is queued, and the real one after', async () => {
  const { env, calls } = setup();
  calls.pending = [{ source_path: '/j/01.jpg' }];
  assert.match(await (await get(env, `/delivery/x/${TOKEN}`)).text(), /is-disabled[^>]*>[\s\S]*?Preparing MLS Photos/);
  calls.pending = [];
  assert.match(await (await get(env, `/delivery/x/${TOKEN}`)).text(), /href="[^"]*\/zip\/mls"/);
});

test('single-photo download: streams the original from photo-sync as an attachment named after the file; only for photos in the grid', async () => {
  const { env, calls } = setup();
  const res = await get(env, `/delivery/x/${TOKEN}/download/p1`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ZIPBYTES');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="01\.jpg"; filename\*=UTF-8''01\.jpg$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.photoSync.map((c) => [c.url, c.auth, c.method]), [[`https://photo-sync.internal/render/${JOB}/p1`, 'Bearer pst', undefined]]);
  // not in the grid / bad token -> the same 404, photo-sync never called
  const before = calls.photoSync.length;
  assert.equal((await get(env, `/delivery/x/${TOKEN}/download/nope`)).status, 404);
  assert.equal((await get(env, `/delivery/x/${'1'.repeat(32)}/download/p1`)).status, 404);
  assert.equal(calls.photoSync.length, before);
  calls.upstream = () => new Response('gone', { status: 404 });
  assert.equal((await get(env, `/delivery/x/${TOKEN}/download/p1`)).status, 404);
});
