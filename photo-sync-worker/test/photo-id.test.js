import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoId, base64url } from '../src/photo-id.js';

test('photoId is deterministic and 22 url-safe chars', async () => {
  const a = await photoId('FV-ABC123', 'MLS/DSC_0001.jpg');
  const b = await photoId('FV-ABC123', 'MLS/DSC_0001.jpg');
  assert.equal(a, b);
  assert.equal(a.length, 22);
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
});

test('photoId depends on jobId and path', async () => {
  const base = await photoId('FV-ABC123', 'MLS/DSC_0001.jpg');
  assert.notEqual(base, await photoId('FV-OTHER', 'MLS/DSC_0001.jpg'));
  assert.notEqual(base, await photoId('FV-ABC123', 'MLS/DSC_0002.jpg'));
  assert.notEqual(base, await photoId('FV-ABC123', 'Floorplan/DSC_0001.jpg'));
});

test('photoId is stable across a delete + re-upload of the same path', async () => {
  // same jobId + same relative path => same id, regardless of Dropbox file id
  const before = await photoId('FV-ABC123', 'MLS/DSC_0001.jpg');
  const afterReupload = await photoId('FV-ABC123', 'MLS/DSC_0001.jpg');
  assert.equal(before, afterReupload);
});

test('base64url has no +/= chars', () => {
  const s = base64url(new Uint8Array([251, 255, 254, 0, 1, 2, 3, 4]));
  assert.ok(!/[+/=]/.test(s));
});
