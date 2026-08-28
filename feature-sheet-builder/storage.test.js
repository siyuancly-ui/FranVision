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
