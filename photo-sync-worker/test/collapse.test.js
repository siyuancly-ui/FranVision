import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseEntries, classifyForSync, groupByJob, dimsFromMediaInfo, chunk } from '../src/sync.js';

const CFG = { root: '', syncFolders: ['MLS', 'Virtual Staging', 'Floorplan', 'Local Report'] };

test('collapseEntries keeps the last state per path', () => {
  const entries = [
    { '.tag': 'file', path_lower: '/joba/mls/a.jpg', path_display: '/JobA/MLS/a.jpg', rev: '1' },
    { '.tag': 'deleted', path_lower: '/joba/mls/a.jpg', path_display: '/JobA/MLS/a.jpg' },
    { '.tag': 'file', path_lower: '/joba/mls/a.jpg', path_display: '/JobA/MLS/a.jpg', rev: '2' },
    { '.tag': 'file', path_lower: '/joba/mls/b.jpg', path_display: '/JobA/MLS/b.jpg', rev: '1' },
  ];
  const c = collapseEntries(entries);
  assert.equal(c.length, 2);
  const a = c.find((e) => e.path_lower.endsWith('a.jpg'));
  assert.equal(a['.tag'], 'file');
  assert.equal(a.rev, '2'); // last write wins -> not a delete
});

test('collapse: delete after add => delete wins', () => {
  const c = collapseEntries([
    { '.tag': 'file', path_lower: '/joba/mls/a.jpg', path_display: '/JobA/MLS/a.jpg' },
    { '.tag': 'deleted', path_lower: '/joba/mls/a.jpg', path_display: '/JobA/MLS/a.jpg' },
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0]['.tag'], 'deleted');
});

test('classifyForSync filters folders, non-images, excluded dirs', () => {
  const entries = [
    { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1', rev: 'r1', media_info: { '.tag': 'metadata', metadata: { dimensions: { width: 6000, height: 4000 } } } },
    { '.tag': 'file', path_display: '/JobA/0 RAW/1 Raws/a.cr2', path_lower: '/joba/0 raw/1 raws/a.cr2' },
    { '.tag': 'file', path_display: '/JobA/Home Report/report.pdf', path_lower: '/joba/home report/report.pdf' },
    { '.tag': 'file', path_display: '/JobA/MLS for download/a.jpg', path_lower: '/joba/mls for download/a.jpg' },
    { '.tag': 'folder', path_display: '/JobA/MLS', path_lower: '/joba/mls' },
    { '.tag': 'deleted', path_display: '/JobA/Floorplan/fp.png', path_lower: '/joba/floorplan/fp.png' },
  ];
  const out = classifyForSync(entries, CFG);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => [o.type, o.subFolder, o.filename]), [
    ['upsert', 'MLS', 'a.jpg'],
    ['delete', 'Floorplan', 'fp.png'],
  ]);
  assert.equal(out[0].id, 'id:1');
  assert.equal(out[0].rev, 'r1');
  assert.deepEqual(out[0].dims, { width: 6000, height: 4000 });
});

test('classifyForSync: a recognized folder nested inside another one is classified by its own (innermost) name', () => {
  // "Drone Callout" confirmed 2026-09-16 to sometimes live nested under
  // "HDR Photos" rather than directly under the job folder -- must still
  // be classified as "Drone Callout", not swallowed into "HDR Photos".
  const cfg = { root: '', syncFolders: ['HDR Photos', 'Drone Callout'] };
  const entries = [
    { '.tag': 'file', path_display: '/JobA/HDR Photos/a.jpg', path_lower: '/joba/hdr photos/a.jpg' },
    { '.tag': 'file', path_display: '/JobA/HDR Photos/Drone Callout/b.jpg', path_lower: '/joba/hdr photos/drone callout/b.jpg' },
  ];
  const out = classifyForSync(entries, cfg);
  assert.deepEqual(out.map((o) => [o.subFolder, o.filename]), [
    ['HDR Photos', 'a.jpg'],
    ['Drone Callout', 'b.jpg'],
  ]);
});

test('groupByJob buckets by top-level folder', () => {
  const classified = classifyForSync(
    [
      { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg' },
      { '.tag': 'file', path_display: '/JobA/Floorplan/b.jpg', path_lower: '/joba/floorplan/b.jpg' },
      { '.tag': 'file', path_display: '/JobB/MLS/c.jpg', path_lower: '/jobb/mls/c.jpg' },
    ],
    CFG,
  );
  const groups = groupByJob(classified);
  assert.deepEqual([...groups.keys()], ['JobA', 'JobB']);
  assert.equal(groups.get('JobA').items.length, 2);
  assert.equal(groups.get('JobA').jobFolderPath, '/JobA');
  assert.equal(groups.get('JobB').items.length, 1);
});

test('dimsFromMediaInfo', () => {
  assert.deepEqual(
    dimsFromMediaInfo({ '.tag': 'metadata', metadata: { dimensions: { width: 6000, height: 4000 } } }),
    { width: 6000, height: 4000 },
  );
  assert.deepEqual(dimsFromMediaInfo({ '.tag': 'pending' }), { width: null, height: null });
  assert.deepEqual(dimsFromMediaInfo(null), { width: null, height: null });
});

test('chunk', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

// ---- 2026-09-24: derived delivery copies are never synced back as photos -------------------
// Bug: `MLS for download/Callout/x.jpg` (the Callout delivery copy, added 2026-09-23) matched the
// `Callout` sync folder (matched at ANY depth) and was synced a SECOND time as a Callout photo, so
// every Callout photo appeared twice on the delivery page and the Gallery.
test('classifyForSync: nothing under the derived-copy folder is synced, at any depth -- including MLS for download/Callout/', () => {
  const cfg = { root: '', syncFolders: ['MLS', 'HDR Photos', 'Callout'], excludeFolders: ['MLS for download'] };
  const f = (p) => ({ '.tag': 'file', path_display: p, id: 'id:' + p, rev: 'r1' });
  const out = classifyForSync([
    f('/FVS-1 job/HDR Photos/a.jpg'),                        // real photo
    f('/FVS-1 job/HDR Photos/Callout/aerial.jpg'),           // real Callout photo
    f('/FVS-1 job/MLS for download/a.jpg'),                  // derived copy (never matched a sync folder anyway)
    f('/FVS-1 job/MLS for download/Callout/aerial.jpg'),     // derived Callout copy  <-- used to be synced as a duplicate
    f('/FVS-1 job/mls for download/CALLOUT/aerial2.jpg'),    // case-insensitive
  ], cfg);
  assert.deepEqual(out.map((o) => o.path).sort(), ['/FVS-1 job/HDR Photos/Callout/aerial.jpg', '/FVS-1 job/HDR Photos/a.jpg']);
  // deletes of a derived copy are ignored too (they must not mark the real photo pending)
  const del = classifyForSync([{ '.tag': 'deleted', path_display: '/FVS-1 job/MLS for download/Callout/aerial.jpg' }], cfg);
  assert.deepEqual(del, []);
});

test('classifyForSync: with the real worker config (readConfig) the derived-copy folder is excluded by default', async () => {
  const { readConfig } = await import('../src/sync.js');
  const cfg = readConfig({ SYNC_FOLDERS: 'HDR Photos,Callout' });
  assert.deepEqual(cfg.excludeFolders, ['MLS for download']);
  const out = classifyForSync([{ '.tag': 'file', path_display: '/J/MLS for download/Callout/x.jpg' }], cfg);
  assert.deepEqual(out, []);
  assert.deepEqual(readConfig({ DOWNLOAD_SUBFOLDER: 'Delivery Copies' }).excludeFolders, ['Delivery Copies']);
});
