'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('./public/js/job-gallery.js');

const ph = (o) => Object.assign({ photoId: 'p', filename: 'a.jpg', dropboxPath: '/j/HDR Photos/a.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true }, o);

test('isJobId: only FVS- ids are job-linked', () => {
  assert.equal(G.isJobId('FVS-20260915-001'), true);
  assert.equal(G.isJobId('a1b2c3d4e5f6'), false);
  assert.equal(G.isJobId(null), false);
});

test('galleryPhotos: keeps HDR Photos / MLS synced photos, drops everything else', () => {
  const photos = [
    ph({ photoId: '1', filename: 'IMG_10.jpg' }),
    ph({ photoId: '2', filename: 'IMG_2.jpg', folder: 'MLS' }),
    ph({ photoId: '3', folder: 'Floorplan' }),
    ph({ photoId: '4', folder: 'Cover&Closing' }),
    ph({ photoId: '5', status: 'pending_review' }),
    ph({ photoId: '6', hasThumb: false }),
    ph({ photoId: '7', role: 'headshot' }),
    { photoId: '8', filename: 'upload.jpg', folder: 'HDR Photos' },   // no dropboxPath => not synced
  ];
  assert.deepEqual(G.galleryPhotos(photos).map((p) => p.photoId), ['2', '1']);   // natural order: IMG_2 < IMG_10
});

test('assetPhotos: only role-tagged entries', () => {
  const photos = [ph({ photoId: 'a' }), ph({ photoId: 'h', role: 'headshot' }), ph({ photoId: 'l', role: 'logo' })];
  assert.deepEqual(G.assetPhotos(photos).map((p) => p.photoId), ['h', 'l']);
});

test('syncedFiles: full is the 2048 render when present, else falls back to the thumb', () => {
  assert.deepEqual(G.syncedFiles({ photoId: 'x', hasLarge: true }), { thumb: 'x_thumb.jpg', full: 'x_large.jpg' });
  assert.deepEqual(G.syncedFiles({ photoId: 'x' }), { thumb: 'x_thumb.jpg', full: 'x_thumb.jpg' });
});

test('patchOf: FSB keys only (never photos/videos/address); missing keys become null', () => {
  const project = { projectId: 'FVS-1', colorTheme: 'navy', agentInfo: { name: 'A' }, photos: [{}], videos: [{}], address: 'x', tourUrl: 'y', confirmed: false };
  const patch = G.patchOf(project);
  assert.equal(patch.colorTheme, 'navy');
  assert.deepEqual(patch.agentInfo, { name: 'A' });
  assert.equal(patch.deletedAt, null);
  for (const k of ['photos', 'videos', 'address', 'tourUrl', 'projectId']) assert.ok(!(k in patch), k + ' must not be sent');
});
