'use strict';
// photo-source.js for a sheet CONNECTED to a Job (stubbed store, fetch and Image).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JOB = 'FVS-20260918-001';
const jobPhotos = [
  { photoId: 'w2', filename: 'IMG_10.jpg', width: 6000, height: 4000, dropboxPath: '/j/HDR Photos/IMG_10.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true },
  { photoId: 'w1', filename: 'IMG_2.jpg', width: 0, height: 0, dropboxPath: '/j/HDR Photos/IMG_2.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true },
  { photoId: 'fp', filename: 'plan.png', dropboxPath: '/j/Floorplan/plan.png', folder: 'Floorplan', status: 'ok', hasThumb: true },
];

function load({ jobs = { [JOB]: { photos: jobPhotos, address: '9 Shape St' } }, fetchImpl } = {}) {
  const fetches = [];
  const store = {
    getJobGallery: async (jid) => { if (!jobs[jid]) throw new Error('Job not found'); return jobs[jid]; },
    // mirrors the real store: a synced photo has only the 1024 thumb; an uploaded one has an original
    photoUrls: (id, meta) => (meta.dropboxPath
      ? { full: `/thumbs/${id}/${meta.photoId}`, thumb: `/thumbs/${id}/${meta.photoId}` }
      : { full: `/photos/${id}/${meta.photoId}`, thumb: `/thumbs/${id}/${meta.photoId}` }),
  };
  class FakeImage { set src(v) { setTimeout(() => { this.naturalWidth = 3000; this.naturalHeight = 2000; this.onload && this.onload(); }, 0); } }
  const win = {
    FSB: { store }, FSB_CONFIG: { photoSyncUrl: 'https://worker.test/' }, location: { search: '' },
  };
  const ctx = {
    window: win, Image: FakeImage, console, setTimeout, clearTimeout,
    URL: { createObjectURL: (b) => 'blob:' + b.tag, revokeObjectURL: () => {} },
    fetch: async (url, opts) => { fetches.push({ url, auth: opts && opts.headers && opts.headers.Authorization }); return fetchImpl ? fetchImpl(url) : { ok: true, blob: async () => ({ tag: url.split('/').pop() }) }; },
    encodeURIComponent,
  };
  vm.createContext(ctx);
  for (const f of ['job-gallery.js', 'photo-source.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js', f), 'utf8'), ctx);
  return { ps: win.FSB.photoSource, fetches };
}

const sheet = (o) => Object.assign({ projectId: 'abc123abc123', photos: [{ photoId: 'h1', role: 'headshot', filename: 'me.png', ext: 'png' }], pages: { page1: { slots: {} }, page2: { slots: {} } } }, o);

test('connect: validates the id, reads the gallery, reports count + address', async () => {
  const { ps } = load();
  const r = await ps.connect(sheet(), ' fvs-20260918-001 ');
  assert.equal(r.jobId, JOB);
  assert.equal(r.count, 2);                 // the two HDR photos; the Floorplan is not pickable
  assert.equal(r.address, '9 Shape St');
  await assert.rejects(() => ps.connect(sheet(), 'nonsense'), /Not a valid Job ID/);
  await assert.rejects(() => ps.connect(sheet(), 'FVS-20260101-999'), /Job not found/);
});

test('connect: a job with no HDR photos yet is rejected with a clear message', async () => {
  const { ps } = load({ jobs: { [JOB]: { photos: [jobPhotos[2]], address: '' } } });
  await assert.rejects(() => ps.connect(sheet(), JOB), /no HDR Photos synced/);
});

test('connected sheet: list = the job gallery in natural filename order; dims probed when the worker had none', async () => {
  const { ps } = load();
  const p = sheet({ jobId: JOB });
  await ps.ready(p);
  const list = ps.list(p);
  assert.equal(JSON.stringify(list.map((x) => x.filename)), '["IMG_2.jpg","IMG_10.jpg"]');
  assert.equal(list[0].width, 3000);        // probed from the thumbnail (worker reported 0)
  assert.equal(list[1].width, 6000);        // taken from the worker's record
});

test('URLs: a job photo lives under the JOB folder, the sheet\'s own headshot under the sheet folder', async () => {
  const { ps } = load();
  const p = sheet({ jobId: JOB });
  await ps.ready(p);
  assert.equal(ps.thumbUrl(p, 'w2'), `/thumbs/${JOB}/w2`);
  assert.equal(ps.fullUrl(p, 'w2'), `/thumbs/${JOB}/w2`);          // editor/preview never get more than the 1024
  assert.equal(ps.fullUrl(p, 'h1'), '/photos/abc123abc123/h1');
  assert.equal(ps.getMeta(p, 'w2').width, 6000);
  assert.equal(ps.getMeta(p, 'nope'), null);
});

test('library is read-only once connected (headshot/logo uploads stay allowed); a plain sheet is unchanged', async () => {
  const { ps } = load();
  assert.equal(ps.supportsUpload(sheet({ jobId: JOB })), false);
  assert.equal(ps.supportsUpload(sheet()), true);
  assert.equal(ps.supportsAssetUpload(), true);
  const plain = sheet({ photos: [{ photoId: 'u1', filename: 'x.jpg', ext: 'jpg', width: 10, height: 10 }] });
  assert.equal(ps.list(plain).length, 1);
  assert.equal(ps.jobStatus(plain), null);
});

test('jobStatus: connected / job unreadable', async () => {
  const { ps } = load();
  const p = sheet({ jobId: JOB });
  await ps.ready(p);
  assert.equal(ps.jobStatus(p).count, 2);
  const bad = sheet({ jobId: 'FVS-20260101-999' });
  await ps.ready(bad);
  assert.match(ps.jobStatus(bad).error, /not found/i);
  assert.equal(ps.list(bad).length, 0);
});

test('preparePrint: fetches the ORIGINAL of only the placed job photos, for the connected JOB id, with the token', async () => {
  const { ps, fetches } = load();
  const p = sheet({ jobId: JOB });
  p.pages.page1.slots['p1R-hero'] = { photoId: 'w2' };
  p.pages.page2.slots['p2L-hero'] = { photoId: 'h1' };            // own asset -> not fetched from the worker
  await ps.ready(p);
  await ps.preparePrint(p, 'tok');
  assert.equal(JSON.stringify(fetches), JSON.stringify([{ url: `https://worker.test/render/${JOB}/w2`, auth: 'Bearer tok' }]));
  assert.equal(ps.printUrl(p, 'w2'), 'blob:w2');
  ps.releasePrint();
  assert.equal(ps.printUrl(p, 'w2'), `/thumbs/${JOB}/w2`);         // back to the on-screen 1024
});

test('preparePrint: needs the admin token; a failed fetch aborts (never a soft PDF); unconnected sheets do nothing', async () => {
  let { ps } = load();
  const p = sheet({ jobId: JOB }); p.pages.page1.slots['p1R-hero'] = { photoId: 'w2' };
  await ps.ready(p);
  await assert.rejects(() => ps.preparePrint(p, ''), /admin link/);
  ({ ps } = load({ fetchImpl: async () => ({ ok: false, status: 502 }) }));
  await ps.ready(p);
  await assert.rejects(() => ps.preparePrint(p, 'tok'), /Could not get the high-res photo\(s\): IMG_10\.jpg/);
  const { ps: ps2, fetches } = load();
  await ps2.preparePrint(sheet(), 'tok');
  assert.equal(fetches.length, 0);
});
