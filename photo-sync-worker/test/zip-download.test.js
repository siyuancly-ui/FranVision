import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZipRequest, pickZipEntries, handleZip } from '../src/zip-download.js';

const P = (o) => ({ status: 'ok', folder: 'HDR Photos', ...o });
const PHOTOS = [
  P({ photoId: 'p_b', filename: 'b.jpg', dropboxPath: '/j/HDR Photos/b.jpg', downloadDropboxPath: '/j/MLS for download/b.jpg' }),
  P({ photoId: 'p_a', filename: 'a.jpg', dropboxPath: '/j/HDR Photos/a.jpg', downloadDropboxPath: '/j/MLS for download/a.jpg' }),
  P({ photoId: 'p_c', filename: 'c.jpg', dropboxPath: '/j/HDR Photos/c.jpg' }), // no delivery copy yet
  P({ photoId: 'p_e', filename: 'e.jpg', status: 'pending_review', dropboxPath: '/j/HDR Photos/e.jpg', downloadDropboxPath: '/j/MLS for download/e.jpg' }),
];

test('parseZipRequest validates job id and kind', () => {
  const u = (s) => new URL('https://w.test' + s);
  assert.deepEqual(parseZipRequest(u('/zip/FVS-20260924-001?kind=mls')), { jobId: 'FVS-20260924-001', kind: 'mls' });
  assert.equal(parseZipRequest(u('/zip/FVS-20260924-001')), null);
  assert.equal(parseZipRequest(u('/zip/FVS-20260924-001?kind=raw')), null);
  assert.equal(parseZipRequest(u('/zip/a%2Fb?kind=mls')), null);
});

test('pickZipEntries: exactly the requested photos, sorted by filename; anything not ready is reported', () => {
  const orig = pickZipEntries(PHOTOS, 'original', ['p_b', 'p_a', 'p_c']);
  assert.deepEqual(orig.entries.map((e) => e.name), ['a.jpg', 'b.jpg', 'c.jpg']);
  assert.deepEqual(orig.notReady, []);
  const mls = pickZipEntries(PHOTOS, 'mls', ['p_b', 'p_a', 'p_c']);
  assert.deepEqual(mls.entries.map((e) => e.path), ['/j/MLS for download/a.jpg', '/j/MLS for download/b.jpg']);
  assert.deepEqual(mls.notReady, ['p_c']);                 // its 2048 copy isn't there yet
  assert.deepEqual(pickZipEntries(PHOTOS, 'original', ['p_e', 'nope']).notReady, ['p_e', 'nope']); // not ok / unknown
  assert.deepEqual(pickZipEntries(PHOTOS, 'original', ['p_a']).entries.map((e) => e.name), ['a.jpg']); // photos NOT requested are never included
});

const ENV = { RENDER_TOKEN: 't' };
const mk = (token, body, method = 'POST') => new Request('https://w.test/zip/FVS-1?kind=original', {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body === undefined ? undefined : JSON.stringify(body),
});
const IDS = { jobId: 'FVS-1', kind: 'original' };
const deps = (over = {}) => ({
  sb: { async getProjectPhotos() { return PHOTOS; } },
  dbx: { async downloadFileStream(p) { return new Response('bytes:' + p); } },
  ...over,
});

test('handleZip: 401 without token, 405 for GET, 400 for a missing/invalid id list', async () => {
  assert.equal((await handleZip(mk(null, { photoIds: ['p_a'] }), ENV, deps(), null, IDS)).status, 401);
  assert.equal((await handleZip(mk('t', undefined, 'GET'), ENV, deps(), null, IDS)).status, 405);
  for (const bad of [{}, { photoIds: [] }, { photoIds: 'p_a' }, { photoIds: ['../x'] }, { photoIds: [1] }]) {
    assert.equal((await handleZip(mk('t', bad), ENV, deps(), null, IDS)).status, 400, JSON.stringify(bad));
  }
});

test('handleZip: 409 (with the ids) when any requested photo is not ready -- never a smaller zip', async () => {
  const res = await handleZip(new Request('https://w.test/zip/FVS-1?kind=mls', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify({ photoIds: ['p_a', 'p_c'] }) }), ENV, deps(), null, { jobId: 'FVS-1', kind: 'mls' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'not ready', notReady: ['p_c'] });
});

test('handleZip streams a zip containing exactly the requested photos', async () => {
  const res = await handleZip(mk('t', { photoIds: ['p_a', 'p_b'] }), ENV, deps(), null, IDS);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('x-zip-entries'), '2');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.ok(buf.includes('bytes:/j/HDR Photos/a.jpg') && buf.includes('bytes:/j/HDR Photos/b.jpg'));
  assert.ok(!buf.includes('c.jpg'));
});

test('handleZip: a transient Dropbox failure is retried and the zip still comes out complete', async () => {
  let calls = 0;
  const flaky = deps({ dbx: { async downloadFileStream(p) { if (++calls === 1) throw new Error('blip'); return new Response('bytes:' + p); } } });
  const res = await handleZip(mk('t', { photoIds: ['p_a'] }), ENV, flaky, null, IDS);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.includes('bytes:/j/HDR Photos/a.jpg'));
  assert.equal(calls, 2);
});

test('handleZip: a file that stays unreadable aborts the stream (failed download, not a short zip)', async () => {
  const broken = deps({ dbx: { async downloadFileStream() { throw new Error('gone'); } } });
  const res = await handleZip(mk('t', { photoIds: ['p_a'] }), ENV, broken, { waitUntil() {} }, IDS);
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer());
});
