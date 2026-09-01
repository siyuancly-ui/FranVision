'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalDiskStorage } = require('./storage.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsb-store-'));
  return { store: new LocalDiskStorage(dir), dir };
}

test('createProject: blank scaffold + ids + default template', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  assert.match(p.projectId, /^[A-Za-z0-9_-]{6,40}$/);
  assert.strictEqual(p.templateId, 'jason-fs-v1');
  assert.ok(p.createdAt && p.updatedAt);
  assert.strictEqual(p.confirmed, false);
  assert.strictEqual(Object.keys(p.pages.page1.slots).length + Object.keys(p.pages.page2.slots).length, 16);

  const again = await store.getProject(p.projectId);
  assert.strictEqual(again.projectId, p.projectId);
});

test('createProject: seed data is merged', async () => {
  const { store } = freshStore();
  const p = await store.createProject({
    propertyInfo: { address: '99 Sample Dr', city: 'Markham' },
    agentInfo: { name: 'Jane Roe' },
  });
  assert.strictEqual(p.propertyInfo.address, '99 Sample Dr');
  assert.strictEqual(p.propertyInfo.city, 'Markham');
  assert.strictEqual(p.agentInfo.name, 'Jane Roe');
});

test('updateProject: patches persist and merge slots by id', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  await store.updateProject(p.projectId, { propertyInfo: { address: 'A', city: 'B', description: 'C' } });
  await store.updateProject(p.projectId, {
    pages: { page1: { slots: { 'p1R-hero': { photoId: 'zzz', positionX: 0.5, scale: 2 } } } },
  });
  const out = await store.getProject(p.projectId);
  assert.strictEqual(out.propertyInfo.address, 'A');
  assert.strictEqual(out.pages.page1.slots['p1R-hero'].photoId, 'zzz');
  assert.strictEqual(out.pages.page1.slots['p1R-hero'].positionX, 0.5);
  assert.strictEqual(out.pages.page1.slots['p1R-hero'].scale, 2);
  // untouched slot still present
  assert.ok(out.pages.page2.slots['p2L-1']);
});

test('updateProject: a photos array in the patch replaces the stored list', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  const photos = [
    { photoId: 'aaaaaa', filename: 'a.jpg', ext: 'jpg', width: 100, height: 80, hasThumb: true, uploadedAt: 'x' },
    { photoId: 'bbbbbb', filename: 'b.png', ext: 'png', width: 50, height: 50, hasThumb: false, uploadedAt: 'y' },
  ];
  await store.updateProject(p.projectId, { photos });
  const out = await store.getProject(p.projectId);
  assert.deepStrictEqual(out.photos.map((x) => x.photoId), ['aaaaaa', 'bbbbbb']);
  // a later patch without `photos` leaves it untouched
  await store.updateProject(p.projectId, { propertyInfo: { address: 'Z' } });
  const out2 = await store.getProject(p.projectId);
  assert.strictEqual(out2.photos.length, 2);
});

test('savePhoto + deletePhoto: files created, slot refs cleared', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  const meta = await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'shot.png', contentType: 'image/png' });
  assert.match(meta.photoId, /^[A-Za-z0-9_-]{6,40}$/);
  assert.strictEqual(meta.ext, 'png');

  const orig = store.getPhotoPath(p.projectId, meta.photoId, 'original');
  assert.ok(orig && fs.existsSync(orig));

  await store.updateProject(p.projectId, {
    pages: { page1: { slots: { 'p1R-hero': { photoId: meta.photoId, positionX: 0.2, scale: 1.5 } } } },
  });
  const afterDel = await store.deletePhoto(p.projectId, meta.photoId);
  assert.strictEqual(afterDel.photos.length, 0);
  assert.strictEqual(afterDel.pages.page1.slots['p1R-hero'].photoId, null);
  assert.strictEqual(afterDel.pages.page1.slots['p1R-hero'].scale, 1);
  assert.strictEqual(store.getPhotoPath(p.projectId, meta.photoId, 'original'), null);
});

test('setConfirmed toggles confirmed + confirmedAt', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  const c = await store.setConfirmed(p.projectId, true);
  assert.strictEqual(c.confirmed, true);
  assert.ok(c.confirmedAt);
  const u = await store.setConfirmed(p.projectId, false);
  assert.strictEqual(u.confirmed, false);
  assert.strictEqual(u.confirmedAt, null);
});

test('bad ids are rejected, not treated as paths', async () => {
  const { store } = freshStore();
  assert.strictEqual(await store.getProject('../secret'), null);
  assert.strictEqual(await store.getProject('a'), null);
  assert.strictEqual(await store.updateProject('../x', {}), null);
  assert.strictEqual(store.getPhotoPath('../x', '../y', 'original'), null);
});

test('concurrent uploads + updates do not lose data (per-project lock)', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  const N = 12;
  const jobs = [];
  for (let i = 0; i < N; i++) {
    jobs.push(store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'p' + i + '.png', contentType: 'image/png' }));
    jobs.push(store.updateProject(p.projectId, { propertyInfo: { address: 'addr ' + i } }));
  }
  await Promise.all(jobs);
  const out = await store.getProject(p.projectId);
  assert.strictEqual(out.photos.length, N, 'all ' + N + ' uploads persisted');
  assert.strictEqual(new Set(out.photos.map((x) => x.photoId)).size, N, 'ids unique');
  // every meta has a matching file on disk
  out.photos.forEach((m) => {
    assert.ok(store.getPhotoPath(p.projectId, m.photoId, 'original'), 'file exists for ' + m.photoId);
  });
});

test('headshot / logo references are cleared when their photo is deleted', async () => {
  const { store } = freshStore();
  const p = await store.createProject();
  const meta = await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'h.png', contentType: 'image/png' });
  await store.updateProject(p.projectId, { agentInfo: { headshotPhotoId: meta.photoId, brokerageLogoPhotoId: meta.photoId } });
  const after = await store.deletePhoto(p.projectId, meta.photoId);
  assert.strictEqual(after.agentInfo.headshotPhotoId, null);
  assert.strictEqual(after.agentInfo.brokerageLogoPhotoId, null);
});

test('updateProject: boxOffsets/boxSizes REPLACE (a dropped key does not resurrect)', async () => {
  const { store } = freshStore();
  const p = await store.createProject({ templateSystem: 'fsb-v2' });
  await store.updateProject(p.projectId, { boxOffsets: { nameBox: { dx: 0.1, dy: -0.2 }, tourBox: { dx: 0, dy: 0.3 } } });
  // client double-clicked nameBox to reset it -> sends the map without that key
  const out = await store.updateProject(p.projectId, { boxOffsets: { tourBox: { dx: 0, dy: 0.3 } } });
  assert.deepStrictEqual(Object.keys(out.boxOffsets), ['tourBox']);
  assert.strictEqual(out.boxOffsets.nameBox, undefined);
  // an empty map clears everything
  const cleared = await store.updateProject(p.projectId, { boxOffsets: {} });
  assert.deepStrictEqual(cleared.boxOffsets, {});
});

test('clearPhotos: wipes the library but keeps headshot / logo (role) assets', async () => {
  const { store } = freshStore();
  const p = await store.createProject({ templateSystem: 'fsb-v2' });
  const lib1 = await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'room1.png', contentType: 'image/png' });
  await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'room2.png', contentType: 'image/png' });
  const head = await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'head.png', contentType: 'image/png', role: 'headshot' });
  const logo = await store.savePhoto(p.projectId, { buffer: PNG_1PX, filename: 'logo.png', contentType: 'image/png', role: 'logo' });
  await store.updateProject(p.projectId, {
    agentInfo: { headshotPhotoId: head.photoId, brokerageLogoPhotoId: logo.photoId },
    pages: { page1: { slots: { 'p1R-hero': { photoId: lib1.photoId } } } },
  });

  const after = await store.clearPhotos(p.projectId);
  assert.deepStrictEqual(after.photos.map((x) => x.photoId).sort(), [head.photoId, logo.photoId].sort());
  assert.strictEqual(after.pages.page1.slots['p1R-hero'].photoId, null, 'library slot ref cleared');
  assert.strictEqual(after.agentInfo.headshotPhotoId, head.photoId, 'headshot ref kept');
  assert.strictEqual(after.agentInfo.brokerageLogoPhotoId, logo.photoId, 'logo ref kept');
  assert.strictEqual(store.getPhotoPath(p.projectId, lib1.photoId, 'original'), null, 'library file gone');
  assert.ok(store.getPhotoPath(p.projectId, head.photoId, 'original'), 'headshot file kept');
});

test('recycle bin: soft delete -> restore -> purge; listProjects splits active vs trash', async () => {
  const { store } = freshStore();
  const a = await store.createProject({ templateSystem: 'fsb-v2' });
  const b = await store.createProject({ templateSystem: 'fsb-v2' });

  assert.strictEqual(await store.deleteProject(a.projectId), true);
  let active = await store.listProjects();
  let trash = await store.listProjects({ trashed: true });
  assert.deepStrictEqual(active.map((r) => r.id), [b.projectId]);
  assert.deepStrictEqual(trash.map((r) => r.id), [a.projectId]);
  assert.ok(trash[0].deletedAt, 'deletedAt is reported');
  // still on disk -> restorable
  assert.ok(await store.getProject(a.projectId));

  const restored = await store.restoreProject(a.projectId);
  assert.strictEqual(restored.deletedAt, undefined);
  active = await store.listProjects();
  assert.strictEqual(active.length, 2);

  await store.deleteProject(a.projectId);
  assert.strictEqual(await store.purgeProject(a.projectId), true);
  assert.strictEqual(await store.getProject(a.projectId), null, 'purge removes it for good');
  assert.strictEqual(await store.purgeProject(a.projectId), false, 'purge of a missing id is a no-op');
});

test('emptyTrash: purges every soft-deleted sheet, leaves active ones', async () => {
  const { store } = freshStore();
  const a = await store.createProject({ templateSystem: 'fsb-v2' });
  const b = await store.createProject({ templateSystem: 'fsb-v2' });
  const c = await store.createProject({ templateSystem: 'fsb-v2' });
  await store.deleteProject(a.projectId);
  await store.deleteProject(c.projectId);

  assert.strictEqual(await store.emptyTrash(), 2);
  assert.strictEqual(await store.getProject(a.projectId), null);
  assert.strictEqual(await store.getProject(c.projectId), null);
  assert.ok(await store.getProject(b.projectId), 'active sheet untouched');
  assert.strictEqual(await store.emptyTrash(), 0, 'nothing left to purge');
});

test('duplicateProject: keeps agent block + identity photos, drops property data', async () => {
  const { store } = freshStore();
  const src = await store.createProject({ templateSystem: 'fsb-v2' });
  const lib = await store.savePhoto(src.projectId, { buffer: PNG_1PX, filename: 'room.png', contentType: 'image/png' });
  const head = await store.savePhoto(src.projectId, { buffer: PNG_1PX, filename: 'head.png', contentType: 'image/png', role: 'headshot' });
  await store.updateProject(src.projectId, {
    colorTheme: 'burgundy',
    propertyInfo: { address: '10 Old St', city: 'Markham', description: 'nice' },
    agentInfo: { name: 'Jane Roe', email: 'jane@x.com', headshotPhotoId: head.photoId },
    boxOffsets: { nameBox: { dx: 0.1, dy: 0 } },
    pages: { page1: { slots: { 'p1R-hero': { photoId: lib.photoId } } } },
    confirmed: true,
  });

  const dup = await store.duplicateProject(src.projectId);
  assert.notStrictEqual(dup.projectId, src.projectId);
  assert.strictEqual(dup.colorTheme, 'burgundy');
  assert.strictEqual(dup.agentInfo.name, 'Jane Roe');
  assert.strictEqual(dup.agentInfo.headshotPhotoId, head.photoId);
  assert.deepStrictEqual(dup.boxOffsets, { nameBox: { dx: 0.1, dy: 0 } });
  assert.strictEqual(dup.confirmed, false, 'copy starts unconfirmed');
  assert.strictEqual(dup.propertyInfo.address, '', 'property info blanked');
  assert.strictEqual(dup.propertyInfo.description, '');
  assert.deepStrictEqual(dup.pages.page1.slots, {}, 'slot assignments dropped');
  assert.deepStrictEqual(dup.photos.map((x) => x.photoId), [head.photoId], 'only identity photos carried');
  assert.ok(store.getPhotoPath(dup.projectId, head.photoId, 'original'), 'headshot file copied into the new project');
  assert.strictEqual(store.getPhotoPath(dup.projectId, lib.photoId, 'original'), null, 'library photo not copied');
});
