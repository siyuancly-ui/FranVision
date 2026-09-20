import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRenderPath, handleRender } from '../src/render.js';

const ENV = { RENDER_TOKEN: 'secret-token', DOWNLOAD_THUMB_SIZE: 'w2048h1536' };
const req = (token) => new Request('https://w.test/render/FVS-1/abc', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const REC = { photoId: 'abc', filename: 'a.jpg', dropboxPath: '/j/HDR Photos/a.jpg', downloadDropboxPath: '/j/MLS for download/a.jpg', folder: 'HDR Photos' };

function deps({ photos = [REC], download, thumb } = {}) {
  const calls = { download: [], thumb: [] };
  return {
    calls,
    sb: { async getProjectPhotos() { return photos; } },
    dbx: {
      async downloadFile(p) { calls.download.push(p); if (download instanceof Error) throw download; return download || new Uint8Array([1, 2, 3]); },
      async getThumbnailV2(p, size) { calls.thumb.push({ p, size }); if (thumb instanceof Error) throw thumb; return thumb || new Uint8Array([9, 9]); },
    },
  };
}

test('parseRenderPath: only /render/<jobId>/<photoId> with safe ids', () => {
  assert.deepEqual(parseRenderPath('/render/FVS-20260915-001/xY_-9'), { jobId: 'FVS-20260915-001', photoId: 'xY_-9' });
  assert.equal(parseRenderPath('/render/FVS-1'), null);
  assert.equal(parseRenderPath('/render/../x/y'), null);
  assert.equal(parseRenderPath('/render/a b/c'), null);
  assert.equal(parseRenderPath('/other/FVS-1/abc'), null);
});

test('no / wrong token -> 401, and nothing is looked up or downloaded', async () => {
  for (const t of [null, 'nope']) {
    const d = deps();
    const res = await handleRender(req(t), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
    assert.equal(res.status, 401);
    assert.equal(d.calls.download.length + d.calls.thumb.length, 0);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  }
  const res = await handleRender(req('x'), { ...ENV, RENDER_TOKEN: '' }, deps(), { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 401);   // unset secret never authorises
});

test('serves the existing MLS-for-download copy when present', async () => {
  const d = deps();
  const res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('X-Render-Source'), 'download-copy');
  assert.deepEqual(d.calls.download, ['/j/MLS for download/a.jpg']);
  assert.equal(d.calls.thumb.length, 0);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
});

test('falls back to a fresh 2048 thumbnail render when the copy is missing or has no path', async () => {
  let d = deps({ download: new Error('path/not_found') });
  let res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Render-Source'), 'thumbnail-api');
  assert.deepEqual(d.calls.thumb, [{ p: '/j/HDR Photos/a.jpg', size: 'w2048h1536' }]);

  d = deps({ photos: [{ ...REC, downloadDropboxPath: undefined }] });
  res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.headers.get('X-Render-Source'), 'thumbnail-api');
  assert.equal(d.calls.download.length, 0);
});

test('404 for unknown / non-synced / role-tagged photos; 502 when nothing can be rendered', async () => {
  for (const photos of [[], [{ ...REC, photoId: 'other' }], [{ ...REC, dropboxPath: undefined }], [{ ...REC, role: 'headshot' }]]) {
    const res = await handleRender(req('secret-token'), ENV, deps({ photos }), { jobId: 'FVS-1', photoId: 'abc' });
    assert.equal(res.status, 404);
  }
  const res = await handleRender(req('secret-token'), ENV, deps({ download: new Error('x'), thumb: new Error('y') }), { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 502);
});
