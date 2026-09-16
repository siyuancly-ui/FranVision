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
