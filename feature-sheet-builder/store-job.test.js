'use strict';
// store.js (Supabase mode) with a stubbed supabase-js client. A Job's row belongs to the
// photo-sync-worker: the FSB may only READ it, and every write path must refuse it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(rowForFetch) {
  const calls = { from: [], selects: [], remove: [] };
  const chain = (table) => {
    const c = {
      select(cols) { calls.selects.push(cols); return c; },
      update(v) { calls.from.push({ table, op: 'update', v }); return c; },
      insert(v) { calls.from.push({ table, op: 'insert', v }); return c; },
      delete() { calls.from.push({ table, op: 'delete' }); return c; },
      eq() { return c; },
      single() { return Promise.resolve({ data: rowForFetch, error: null }); },
      maybeSingle() { return Promise.resolve({ data: rowForFetch, error: null }); },
      then(res, rej) { return Promise.resolve({ data: rowForFetch, error: null }).then(res, rej); },
    };
    return c;
  };
  const client = {
    from: (t) => chain(t),
    rpc: () => { throw new Error('no RPC is used any more'); },
    storage: { from: () => ({
      getPublicUrl: (p) => ({ data: { publicUrl: 'https://sb.test/storage/v1/object/public/photos/' + p } }),
      remove: (paths) => { calls.remove.push(paths); return Promise.resolve({}); },
      upload: () => Promise.resolve({}),
      list: () => Promise.resolve({ data: [] }),
    }) },
    functions: { invoke: () => Promise.resolve({ data: {} }) },
  };
  const win = {
    FSB: {}, FSB_V2: { blankProject: () => ({}) },
    FSB_CONFIG: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'k' },
    location: { search: '' },
    crypto: { getRandomValues: (a) => a },
    supabase: { createClient: () => client },
  };
  const ctx = { window: win, URL, Image: function () {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js/job-gallery.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js/store.js'), 'utf8'), ctx);
  return { store: win.FSB.store, calls };
}

const JOB = 'FVS-20260915-001';
const sheet = () => ({ projectId: 'abc123abc123', colorTheme: 'navy', jobId: JOB, agentInfo: { name: 'A' }, pages: { page1: { slots: {} }, page2: { slots: {} } }, photos: [] });

test('a job row can never be written by the FSB (save / confirm / delete / restore / purge / duplicate / clear)', async () => {
  const { store, calls } = load(null);
  await assert.rejects(() => store.updateProject(JOB, sheet()), /Job row/);
  await assert.rejects(() => store.confirmProject(JOB, true), /Job row/);
  for (const op of ['deleteProject', 'restoreProject', 'purgeProject', 'duplicateProject', 'clearPhotos']) {
    await assert.rejects(() => store[op](JOB), /Job row/, op);
  }
  assert.equal(calls.from.length + calls.remove.length, 0);
});

test('a normal sheet (random id) keeps the whole-blob update, and jobId + createdVia survive it', async () => {
  const { store, calls } = load({ id: 'abc123abc123', data: {}, created_at: 'c', updated_at: 'u' });
  const p = sheet(); p.createdVia = 'root';
  await store.updateProject('abc123abc123', p);
  const upd = calls.from.filter((c) => c.op === 'update').pop();
  assert.equal(upd.v.data.jobId, JOB);
  assert.equal(upd.v.data.createdVia, 'root');
});

test('getJobGallery: reads only photos + address of the job row (never writes)', async () => {
  const { store, calls } = load({ photos: [{ photoId: 'w1' }], address: '1 Test St' });
  const g = await store.getJobGallery(JOB);
  assert.equal(g.photos.length, 1);
  assert.equal(g.address, '1 Test St');
  assert.ok(String(calls.selects[0]).includes('data->photos'));
  assert.equal(calls.from.length, 0);
});

test('getJobGallery: a missing job rejects with "Job not found"', async () => {
  const { store } = load(null);
  await assert.rejects(() => store.getJobGallery(JOB), /Job not found/);
});

test('photoUrls: synced photo -> 1024 thumb for both (never _large), under the id it is given; uploaded photo -> original', () => {
  const { store } = load(null);
  const synced = store.photoUrls(JOB, { photoId: 'w1', dropboxPath: '/x', hasThumb: true, hasLarge: true });
  assert.ok(synced.full.endsWith('/FVS-20260915-001/w1_thumb.jpg'));
  assert.ok(synced.thumb.endsWith('/FVS-20260915-001/w1_thumb.jpg'));
  const own = store.photoUrls('abc123abc123', { photoId: 'u1', ext: 'jpg', hasThumb: true });
  assert.ok(own.full.endsWith('/abc123abc123/u1.jpg'));
});

test('createdVia is stored on create', async () => {
  const { store, calls } = load({ id: 'abc123abc123', data: {}, created_at: 'c', updated_at: 'u' });
  await store.createProject({ createdVia: 'root', createdRef: 'mail.example.com' });
  const ins = calls.from.find((c) => c.op === 'insert');
  assert.equal(ins.v.data.createdVia, 'root');
  assert.equal(ins.v.data.createdRef, 'mail.example.com');
});

test('admin list: Job rows (FVS-…) the worker mirrors into projects are not listed as sheets', async () => {
  const rows = [{ id: JOB, address: '' }, { id: 'abc123abc123', address: '1 Main St' }, { id: 'def456def456', address: '' }];
  const win = { FSB: {}, FSB_V2: { blankProject: () => ({}) }, FSB_CONFIG: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'k' }, location: { search: '' }, crypto: { getRandomValues: (a) => a } };
  const client = { from: () => ({}), storage: { from: () => ({}) }, functions: { invoke: () => Promise.resolve({ data: { projects: rows } }) } };
  win.supabase = { createClient: () => client };
  const ctx = { window: win, URL, Image: function () {}, console };
  vm.createContext(ctx);
  for (const f of ['job-gallery.js', 'store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js', f), 'utf8'), ctx);
  const list = await win.FSB.store.listAllProjects('tok');
  assert.deepEqual(list.map((r) => r.id), ['abc123abc123', 'def456def456']);
});
