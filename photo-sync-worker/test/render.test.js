import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRenderPath, handleRender } from '../src/render.js';

const ENV = { RENDER_TOKEN: 'secret-token', DOWNLOAD_THUMB_SIZE: 'w2048h1536' };
const req = (token) => new Request('https://w.test/render/FVS-1/abc', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const REC = { photoId: 'abc', filename: 'a.jpg', dropboxPath: '/j/HDR Photos/a.jpg', downloadDropboxPath: '/j/MLS for download/a.jpg', folder: 'HDR Photos' };

function deps({ photos = [REC], stream } = {}) {
  const calls = { stream: [], other: [] };
  return {
    calls,
    sb: { async getProjectPhotos() { return photos; } },
    dbx: {
      async downloadFileStream(p) {
        calls.stream.push(p);
        if (stream instanceof Error) throw stream;
        return stream || new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '3' } });
      },
      // must never be used: no fallback to the small 2048 renders
      async downloadFile(p) { calls.other.push(p); throw new Error('unexpected'); },
      async getThumbnailV2(p) { calls.other.push(p); throw new Error('unexpected'); },
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
    assert.equal(d.calls.stream.length, 0);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  }
  const res = await handleRender(req('x'), { ...ENV, RENDER_TOKEN: '' }, deps(), { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 401);   // unset secret never authorises
});

test('streams the TRUE original from the HDR Photos path, not the MLS-for-download copy', async () => {
  const d = deps();
  const res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('X-Render-Source'), 'original');
  assert.equal(res.headers.get('Content-Length'), '3');
  assert.deepEqual(d.calls.stream, ['/j/HDR Photos/a.jpg']);
  assert.equal(d.calls.other.length, 0);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
});

test('content type follows the real extension (png original)', async () => {
  const d = deps({ photos: [{ ...REC, filename: 'a.png', dropboxPath: '/j/HDR Photos/a.png' }] });
  const res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.headers.get('Content-Type'), 'image/png');
});

test('404 for unknown / non-synced / role-tagged photos', async () => {
  for (const photos of [[], [{ ...REC, photoId: 'other' }], [{ ...REC, dropboxPath: undefined }], [{ ...REC, role: 'headshot' }]]) {
    const res = await handleRender(req('secret-token'), ENV, deps({ photos }), { jobId: 'FVS-1', photoId: 'abc' });
    assert.equal(res.status, 404);
  }
});

test('original unreadable -> 502, and it does NOT fall back to a small render', async () => {
  const d = deps({ stream: new Error('path/not_found') });
  const res = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc' });
  assert.equal(res.status, 502);
  assert.equal(d.calls.other.length, 0);
});

test('size=web serves the 2048 delivery copy, 404s when it does not exist', async () => {
  const d = deps();
  const ok = await handleRender(req('secret-token'), ENV, d, { jobId: 'FVS-1', photoId: 'abc', size: 'web' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-render-source'), 'web');
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(d.calls.stream, ['/j/MLS for download/a.jpg']);
  const none = deps({ photos: [{ ...REC, downloadDropboxPath: undefined }] });
  const miss = await handleRender(req('secret-token'), ENV, none, { jobId: 'FVS-1', photoId: 'abc', size: 'web' });
  assert.equal(miss.status, 404);
});

test('GALLERY_TOKEN and RENDER_TOKEN may both fetch the original and the web copy; anything else (or an unconfigured token) is refused', async () => {
  const env = { RENDER_TOKEN: 'secret-token', GALLERY_TOKEN: 'gallery-token' };
  const ids = { jobId: 'FVS-1', photoId: 'abc' };
  for (const tok of ['secret-token', 'gallery-token']) {
    assert.equal((await handleRender(req(tok), env, deps(), ids)).status, 200, tok + ' original');
    assert.equal((await handleRender(req(tok), env, deps(), { ...ids, size: 'web' })).status, 200, tok + ' web');
  }
  assert.equal((await handleRender(req('nope'), env, deps(), ids)).status, 401);
  assert.equal((await handleRender(req('nope'), env, deps(), { ...ids, size: 'web' })).status, 401);
  assert.equal((await handleRender(req('gallery-token'), { RENDER_TOKEN: 'secret-token' }, deps(), ids)).status, 401); // not configured
});
