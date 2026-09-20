'use strict';
// store.js (Supabase mode) with a stubbed supabase-js client: a job-linked
// project (id FVS-...) must save through the fsb_project_patch RPC and never
// through a whole-blob update; destructive ops are refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(rowForFetch) {
  const calls = { rpc: [], from: [], remove: [] };
  const chain = (table) => {
    const c = {
      _op: null,
      select() { c._op = c._op || 'select'; return c; },
      update(v) { c._op = 'update'; calls.from.push({ table, op: 'update', v }); return c; },
      insert(v) { c._op = 'insert'; calls.from.push({ table, op: 'insert', v }); return c; },
      delete() { c._op = 'delete'; calls.from.push({ table, op: 'delete' }); return c; },
      eq() { return c; },
      single() { return Promise.resolve({ data: rowForFetch, error: null }); },
      then(res, rej) { return Promise.resolve({ data: rowForFetch, error: null }).then(res, rej); },
    };
    return c;
  };
  const client = {
    from: (t) => chain(t),
    rpc: (name, args) => { calls.rpc.push({ name, args }); return Promise.resolve({ data: { id: args.p_id, data: { agentInfo: {} }, created_at: 'c', updated_at: 'u' }, error: null }); },
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
const project = () => ({
  projectId: JOB, colorTheme: 'navy', agentInfo: { name: 'A' }, pages: { page1: { slots: {} }, page2: { slots: {} } },
  photos: [
    { photoId: 'w1', filename: 'a.jpg', dropboxPath: '/j/a.jpg', folder: 'HDR Photos', hasThumb: true, hasLarge: true },
    { photoId: 'h1', role: 'headshot', filename: 'me.png', ext: 'png', hasThumb: true },
  ],
  videos: [{ videoId: 'v' }], address: 'x',
});

test('job project: updateProject goes through the RPC, without photos/videos/address', async () => {
  const { store, calls } = load(null);
  await store.updateProject(JOB, project());
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, 'fsb_project_patch');
  const { p_id, p_patch, p_assets } = calls.rpc[0].args;
  assert.equal(p_id, JOB);
  for (const k of ['photos', 'videos', 'address', 'projectId']) assert.ok(!(k in p_patch), k);
  assert.equal(JSON.stringify(p_assets.map((a) => a.photoId)), '["h1"]');       // only the FSB-owned headshot
  assert.equal(calls.from.filter((c) => c.op === 'update').length, 0);
});

test('non-job project keeps the legacy whole-blob update', async () => {
  const { store, calls } = load({ id: 'abc123abc123', data: {}, created_at: 'c', updated_at: 'u' });
  const p = project(); p.projectId = 'abc123abc123';
  await store.updateProject('abc123abc123', p);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.from.filter((c) => c.op === 'update').length, 1);
});

test('job project: delete / restore / purge / duplicate / clear library are refused', async () => {
  const { store, calls } = load(null);
  for (const op of ['deleteProject', 'restoreProject', 'purgeProject', 'duplicateProject', 'clearPhotos']) {
    await assert.rejects(() => store[op](JOB), /not available for a job/, op);
  }
  assert.equal(calls.rpc.length + calls.from.length + calls.remove.length, 0);
});

test('job project: a synced gallery photo cannot be deleted; an own headshot can (RPC, storage cleanup)', async () => {
  const p = project();
  const row = { id: JOB, data: p, created_at: 'c', updated_at: 'u' };
  let t = load(row);
  await assert.rejects(() => t.store.deletePhoto(JOB, 'w1'), /managed in Dropbox/);
  assert.equal(t.calls.rpc.length, 0);

  t = load(row);
  await t.store.deletePhoto(JOB, 'h1');
  assert.equal(t.calls.rpc.length, 1);
  assert.equal(JSON.stringify(t.calls.rpc[0].args.p_assets), '[]');              // headshot removed, gallery photo untouched
  assert.equal(JSON.stringify(t.calls.remove[0].slice().sort()), JSON.stringify(['FVS-20260915-001/h1.png', 'FVS-20260915-001/h1_thumb.jpg']));
});

test('confirmProject on a job only patches confirmed/confirmedAt', async () => {
  const p = project();
  const { store, calls } = load({ id: JOB, data: p, created_at: 'c', updated_at: 'u' });
  await store.confirmProject(JOB, true);
  assert.equal(JSON.stringify(Object.keys(calls.rpc[0].args.p_patch).sort()), '["confirmed","confirmedAt"]');
  assert.equal(calls.rpc[0].args.p_assets, null);                  // photos[] untouched
});

test('photoUrls: synced photo -> 1024 thumb for both (never _large); uploaded photo -> original', () => {
  const { store } = load(null);
  const synced = store.photoUrls(JOB, { photoId: 'w1', dropboxPath: '/x', hasThumb: true, hasLarge: true });
  assert.ok(synced.full.endsWith('/FVS-20260915-001/w1_thumb.jpg'));
  assert.ok(synced.thumb.endsWith('/FVS-20260915-001/w1_thumb.jpg'));
  const own = store.photoUrls('abc123abc123', { photoId: 'u1', ext: 'jpg', hasThumb: true });
  assert.ok(own.full.endsWith('/abc123abc123/u1.jpg'));
});

test('legacy sheets: createdVia is stored on create and survives later saves (whole-blob update keeps it)', async () => {
  const { store, calls } = load({ id: 'abc123abc123', data: {}, created_at: 'c', updated_at: 'u' });
  await store.createProject({ createdVia: 'root', createdRef: 'mail.example.com' });
  const ins = calls.from.find((c) => c.op === 'insert');
  assert.equal(ins.v.data.createdVia, 'root');
  assert.equal(ins.v.data.createdRef, 'mail.example.com');
  const p = project(); p.projectId = 'abc123abc123'; p.createdVia = 'root';
  await store.updateProject('abc123abc123', p);
  const upd = calls.from.filter((c) => c.op === 'update').pop();
  assert.equal(upd.v.data.createdVia, 'root');
});
