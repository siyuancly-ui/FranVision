'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('./public/js/job-gallery.js');

const ph = (o) => Object.assign({ photoId: 'p', filename: 'a.jpg', dropboxPath: '/j/HDR Photos/a.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true }, o);

test('normalizeJobId: trims / upper-cases valid ids, rejects everything else', () => {
  assert.equal(G.normalizeJobId(' fvs-20260918-001 '), 'FVS-20260918-001');
  assert.equal(G.normalizeJobId('FVS-20260918-1234'), 'FVS-20260918-1234');
  for (const bad of ['', null, undefined, 'FVS-2026-001', 'FVS-20260918-01', 'abc123abc123', 'FVS-20260918-001/../x', 'XYZ-20260918-001']) {
    assert.equal(G.normalizeJobId(bad), '', String(bad));
  }
});

test('jobIdOf: the connected job of a sheet, or empty', () => {
  assert.equal(G.jobIdOf({ jobId: 'fvs-20260918-001' }), 'FVS-20260918-001');
  assert.equal(G.jobIdOf({}), '');
  assert.equal(G.jobIdOf(null), '');
  assert.equal(G.jobIdOf({ jobId: 'garbage' }), '');
});

test('isJobId: any FVS- id is a job row (never openable as a sheet)', () => {
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

test('galleryPhotos: a Callout is pickable only when it sits under HDR Photos / MLS', () => {
  const photos = [
    ph({ photoId: 'c1', filename: 'callout.jpg', folder: 'Callout', dropboxPath: '/j/HDR Photos/Callout/callout.jpg' }),
    ph({ photoId: 'c2', filename: 'callout2.jpg', folder: 'callout', dropboxPath: '/j/mls/Callout/callout2.jpg' }),
    ph({ photoId: 'c3', filename: 'aerial.jpg', folder: 'Callout', dropboxPath: '/j/Callout/aerial.jpg' }),   // job-level: delivery page only
    ph({ photoId: 'c4', filename: 'HDR Photos', folder: 'Callout', dropboxPath: '/j/Callout/HDR Photos' }),    // filename must not count
    ph({ photoId: 'c5', folder: 'Callout', dropboxPath: '/j/HDR Photos/Callout/x.jpg', status: 'pending_review' }),
  ];
  assert.deepEqual(G.galleryPhotos(photos).map((p) => p.photoId), ['c1', 'c2']);
});

test('syncedFiles: on-screen full is the 1024 thumb, even when a large render exists', () => {
  assert.deepEqual(G.syncedFiles({ photoId: 'x', hasLarge: true }), { thumb: 'x_thumb.jpg', full: 'x_thumb.jpg' });
  assert.deepEqual(G.syncedFiles({ photoId: 'x' }), { thumb: 'x_thumb.jpg', full: 'x_thumb.jpg' });
});
