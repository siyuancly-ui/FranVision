'use strict';
// store.js (Supabase mode): permanent delete must remove EVERY file of a sheet (storage.list
// returns at most 100 per call), must not report success when the row survived, and
// "Empty bin" must try every sheet and say how many failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load({ files = {}, rowsGone = true, deleteReturns, trash = [], removeFails = {} } = {}) {
  const calls = { list: [], remove: [], deleted: [] };
  const state = { files: JSON.parse(JSON.stringify(files)) };
  const client = {
    from: () => {
      const c = {
        delete() { c.op = 'delete'; return c; },
        select() { return c; },
        eq(_k, id) { c.id = id; return c; },
        maybeSingle() { return Promise.resolve({ data: rowsGone ? null : { id: c.id }, error: null }); },
        then(res, rej) {
          if (c.op === 'delete') calls.deleted.push(c.id);
          const data = deleteReturns !== undefined ? deleteReturns : (rowsGone ? [{ id: c.id }] : []);
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return c;
    },
    storage: { from: () => ({
      list: (prefix, opts) => {
        calls.list.push({ prefix, opts });
        const all = state.files[prefix] || [];
        return Promise.resolve({ data: all.slice(opts.offset, opts.offset + opts.limit).map((n) => ({ name: n })), error: null });
      },
      remove: (paths) => {
        calls.remove.push(paths.length);
        const prefix = paths[0].split('/')[0];
        if (removeFails[prefix]) return Promise.resolve({ error: { message: 'storage denied' } });
        state.files[prefix] = (state.files[prefix] || []).filter((n) => !paths.includes(prefix + '/' + n));
        return Promise.resolve({ data: [], error: null });
      },
      getPublicUrl: (p) => ({ data: { publicUrl: 'x/' + p } }),
    }) },
    functions: { invoke: () => Promise.resolve({ data: { projects: trash }, error: null }) },
  };
  const win = { FSB: {}, FSB_V2: {}, FSB_CONFIG: { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'k' }, location: { search: '' }, crypto: { getRandomValues: (a) => a }, supabase: { createClient: () => client } };
  const ctx = { window: win, URL, Image: function () {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js/job-gallery.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js/store.js'), 'utf8'), ctx);
  return { store: win.FSB.store, calls, state };
}
const names = (n) => Array.from({ length: n }, (_, i) => 'f' + i + '.jpg');

test('purge removes ALL files of a big sheet (250), paging through storage.list, then the row', async () => {
  const { store, calls, state } = load({ files: { abc123abc123: names(250) } });
  assert.equal(await store.purgeProject('abc123abc123'), true);
  assert.equal(JSON.stringify(calls.list.map((c) => c.opts.offset)), '[0,100,200]');
  assert.equal(JSON.stringify(calls.remove), '[100,100,50]');
  assert.equal(state.files.abc123abc123.length, 0);
  assert.equal(JSON.stringify(calls.deleted), '["abc123abc123"]');
});

test('purge of an exact multiple of 100 files still terminates and removes everything', async () => {
  const { store, calls, state } = load({ files: { abc123abc123: names(200) } });
  await store.purgeProject('abc123abc123');
  assert.equal(state.files.abc123abc123.length, 0);
  assert.equal(calls.list.length, 3);   // 100, 100, then an empty page
});

test('purge never reports success when the row survived (e.g. blocked by the database)', async () => {
  const { store } = load({ rowsGone: false });
  await assert.rejects(() => store.purgeProject('abc123abc123'), /not removed/);
});

test('purge of an already-deleted sheet is fine (0 rows deleted, row not there)', async () => {
  const { store } = load({ deleteReturns: [], rowsGone: true });
  assert.equal(await store.purgeProject('abc123abc123'), true);
});

test('a storage failure is reported, not swallowed (and the row is kept)', async () => {
  const { store, calls } = load({ files: { abc123abc123: names(3) }, removeFails: { abc123abc123: true } });
  await assert.rejects(() => store.purgeProject('abc123abc123'), /storage denied/);
  assert.equal(calls.deleted.length, 0);
});

test('a job row can never be purged', async () => {
  const { store } = load();
  await assert.rejects(() => store.purgeProject('FVS-20260915-001'), /Job row/);
});

test('Empty bin tries every sheet, reports progress, and says how many failed', async () => {
  const { store, calls, state } = load({
    files: { aaaaaa11: names(2), bbbbbb22: names(2), cccccc33: names(2) },
    trash: [{ id: 'aaaaaa11' }, { id: 'bbbbbb22' }, { id: 'cccccc33' }],
    removeFails: { bbbbbb22: true },
  });
  const progress = [];
  await assert.rejects(() => store.emptyTrash('tok', (i, n) => progress.push(i + '/' + n)), /1 of 3 could not be deleted \(bbbbbb22: storage denied\)/);
  assert.equal(JSON.stringify(progress), '["1/3","2/3","3/3"]');
  assert.equal(state.files.aaaaaa11.length + state.files.cccccc33.length, 0);   // the others were still purged
  assert.equal(JSON.stringify(calls.deleted), '["aaaaaa11","cccccc33"]');
});

test('Empty bin returns the number purged when all succeed', async () => {
  const { store } = load({ files: { aaaaaa11: names(1), bbbbbb22: names(1) }, trash: [{ id: 'aaaaaa11' }, { id: 'bbbbbb22' }] });
  assert.equal(await store.emptyTrash('tok'), 2);
});

test('Job rows (FVS-…) never appear in the bin, so Empty bin does not choke on them', async () => {
  const { store } = load({
    files: { aaaaaa11: names(1) },
    trash: [{ id: 'FVS-20260918-001' }, { id: 'aaaaaa11' }, { id: 'FVS-20260918-002' }],
  });
  assert.equal(JSON.stringify((await store.listTrash('tok')).map((r) => r.id)), '["aaaaaa11"]');
  assert.equal(await store.emptyTrash('tok'), 1);
});
