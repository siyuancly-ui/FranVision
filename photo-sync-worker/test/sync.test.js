import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDelta, processPhotoBatch, runBackfill, processRenderRetryPoll, MAX_RENDER_RETRY_ATTEMPTS, pickGalleryFallbackTargets } from '../src/sync.js';

const ENV = {
  DROPBOX_JOBS_ROOT: '',
  SYNC_FOLDERS: 'MLS,HDR Photos,Callout,Virtual Staging,Floorplan,Local Report',
  DOWNLOAD_SET_FOLDERS: 'MLS,HDR Photos',
  DOWNLOAD_NESTED_FOLDERS: 'Callout',
  DOWNLOAD_SUBFOLDER: 'MLS for download',
  THUMB_SIZE: 'w1024h768',
  DOWNLOAD_THUMB_SIZE: 'w2048h1536',
  LARGE_THUMB_FOLDERS: 'Cover Photo,Closing Photo,Drone Callout,Local Report',
  ORIGINAL_RENDER_FOLDERS: '',
  DROPBOX_TEMPLATE_ID: 'ptid:TEST',
  MAX_DELTA_ENTRIES_PER_RUN: '2000',
};

function fakeThumb(path, size) {
  return btoa(`thumb:${size}:${path}`);
}
function base64ToBytesLocal(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToText(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function makeDbx(over = {}) {
  const calls = { uploads: [], deletes: [], thumbBatch: [], thumbV2: [], metadata: [], downloads: [] };
  return {
    calls,
    async getThumbnailBatch(paths, size) {
      calls.thumbBatch.push({ paths, size });
      return { entries: paths.map((p) => ({ '.tag': 'success', thumbnail: fakeThumb(p, size) })) };
    },
    async getThumbnailV2(path, size) {
      calls.thumbV2.push({ path, size });
      return base64ToBytesLocal(fakeThumb(path, size));
    },
    async downloadFile(path) {
      calls.downloads.push(path);
      return base64ToBytesLocal(btoa(`original:${path}`));
    },
    async filesUpload(path, bytes) {
      calls.uploads.push({ path, len: bytes.length, text: bytesToText(bytes) });
      return { path_display: path };
    },
    async filesDelete(path) {
      calls.deletes.push(path);
      return {};
    },
    async getMetadata(path, opts = {}) {
      calls.metadata.push({ path, opts });
      if (opts.includeMediaInfo) {
        return { media_info: { '.tag': 'metadata', metadata: { dimensions: { width: 4000, height: 3000 } } } };
      }
      return { property_groups: [{ template_id: ENV.DROPBOX_TEMPLATE_ID, fields: [{ name: 'jobId', value: 'FV-1' }] }] };
    },
    ...over,
  };
}

function makeSb(over = {}) {
  const calls = { thumbs: [], larges: [], rpc: [], patch: [], lease: 0, release: 0, pendingInserts: [] };
  return {
    calls,
    async uploadThumb(jobId, photoId, bytes) {
      calls.thumbs.push({ jobId, photoId, len: bytes.length });
    },
    async uploadLarge(jobId, photoId, bytes, contentType) {
      calls.larges.push({ jobId, photoId, len: bytes.length, contentType });
    },
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      return { created: true, healed: false };
    },
    async getSyncState() {
      return { cursor: 'C0' };
    },
    async patchSyncState(fields) {
      calls.patch.push(fields);
    },
    async acquireLease() {
      calls.lease++;
      return true;
    },
    async releaseLease() {
      calls.release++;
    },
    async insertPendingRender(args) {
      calls.pendingInserts.push(args);
    },
    async listPendingRenders() {
      return [];
    },
    async updatePendingRender() {},
    async deletePendingRender() {},
    async getProjectPhotos() {
      return [];
    },
    ...over,
  };
}

const upsertItem = (over = {}) => ({
  type: 'upsert',
  path: '/JobA/MLS/a.jpg',
  subFolder: 'MLS',
  relPathFromJob: 'MLS/a.jpg',
  filename: 'a.jpg',
  id: 'id:1',
  rev: 'r1',
  dims: { width: 100, height: 50 },
  ...over,
});

// ---------------------------------------------------------------------------
// pickGalleryFallbackTargets
// ---------------------------------------------------------------------------

function galleryPhoto(n, over = {}) {
  return { photoId: 'p' + n, filename: String(n).padStart(2, '0') + '.jpg', folder: 'MLS', status: 'ok', hasThumb: true, ...over };
}

test('pickGalleryFallbackTargets: empty gallery -> no targets', () => {
  assert.deepEqual(pickGalleryFallbackTargets([], ['MLS']), []);
  assert.deepEqual(pickGalleryFallbackTargets(null, ['MLS']), []);
});

test('pickGalleryFallbackTargets: picks the 3rd and 5th photo by filename', () => {
  const photos = [galleryPhoto(5), galleryPhoto(1), galleryPhoto(3), galleryPhoto(2), galleryPhoto(4), galleryPhoto(6)];
  const targets = pickGalleryFallbackTargets(photos, ['MLS']);
  assert.deepEqual(targets.map((p) => p.photoId), ['p3', 'p5']);
});

test('pickGalleryFallbackTargets: clamps to the last photo when the gallery is smaller than index 4, keeps hero/closing distinct', () => {
  const photos = [galleryPhoto(1), galleryPhoto(2)];
  const targets = pickGalleryFallbackTargets(photos, ['MLS']);
  // index 2 clamps to the last (p2); index 4 also clamps to p2, colliding
  // with hero -> closing swaps to the first (p1) instead, same as render.js.
  assert.deepEqual(targets.map((p) => p.photoId), ['p2', 'p1']);
});

test('pickGalleryFallbackTargets: a single-photo gallery is both hero and closing -> one target', () => {
  const targets = pickGalleryFallbackTargets([galleryPhoto(1)], ['MLS']);
  assert.deepEqual(targets.map((p) => p.photoId), ['p1']);
});

test('pickGalleryFallbackTargets: dedup swap keeps hero and closing distinct when possible', () => {
  // 3 photos: index 2 (3rd) is p3 exactly; index 4 clamps to the last, p3 too
  // -- same collision render.js's dedup swap exists for. Should swap closing
  // to a different photo (the last, or index 0 if the last IS hero).
  const photos = [galleryPhoto(1), galleryPhoto(2), galleryPhoto(3)];
  const targets = pickGalleryFallbackTargets(photos, ['MLS']);
  assert.deepEqual(targets.map((p) => p.photoId), ['p3', 'p1']);
});

test('pickGalleryFallbackTargets: ignores non-ok, thumbless, or non-gallery-folder photos', () => {
  const photos = [
    galleryPhoto(1), galleryPhoto(2),
    galleryPhoto(3, { status: 'pending_review' }),
    galleryPhoto(4, { hasThumb: false }),
    galleryPhoto(5, { folder: 'Local Report' }),
    galleryPhoto(6), galleryPhoto(7),
  ];
  const targets = pickGalleryFallbackTargets(photos, ['MLS']);
  // real gallery (sorted): 01, 02, 06, 07 -- index 2 is p6, index 4 clamps to the last (p7)
  assert.deepEqual(targets.map((p) => p.photoId), ['p6', 'p7']);
});

test('processPhotoBatch: MLS photo -> thumb + download copy + rpc', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [
      upsertItem(),
      upsertItem({ path: '/JobA/Floorplan/b.png', subFolder: 'Floorplan', relPathFromJob: 'Floorplan/b.png', filename: 'b.png', id: 'id:2', rev: 'r2', dims: { width: 800, height: 600 } }),
    ],
  });

  assert.equal(res.ok, 2);
  assert.equal(res.skipped, 0);
  assert.equal(sb.calls.thumbs.length, 2);

  // download copy only for the MLS one, and it uses the BIGGER render
  assert.deepEqual(dbx.calls.uploads.map((u) => u.path), ['/JobA/MLS for download/a.jpg']);
  assert.equal(dbx.calls.uploads[0].text, 'thumb:w2048h1536:/JobA/MLS/a.jpg');
  assert.ok(dbx.calls.thumbBatch.some((b) => b.size === 'w1024h768'), 'Supabase thumb at w1024h768');
  assert.ok(dbx.calls.thumbBatch.some((b) => b.size === 'w2048h1536'), 'delivery copy at w2048h1536');

  const recA = sb.calls.rpc.find((c) => c.args.p_photo.filename === 'a.jpg').args.p_photo;
  assert.equal(recA.folder, 'MLS');
  assert.equal(recA.width, 100);
  assert.equal(recA.height, 50);
  assert.equal(recA.hasThumb, true);
  assert.equal(recA.dropboxFileId, 'id:1');
  assert.equal(recA.status, 'ok');
  assert.equal(recA.downloadDropboxPath, '/JobA/MLS for download/a.jpg');

  const recB = sb.calls.rpc.find((c) => c.args.p_photo.filename === 'b.png').args.p_photo;
  assert.equal(recB.width, 800);
  assert.equal(recB.downloadDropboxPath, undefined);
});

test('processPhotoBatch: date-prefixed jobFolderPath syncs address via project_set_delivery_info', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, {
    jobId: 'FV-1',
    jobFolderPath: '/2026.9.15 123 Delete Me Ave_Swan Si',
    items: [upsertItem()],
  });

  const addrCall = sb.calls.rpc.find((c) => c.fn === 'project_set_delivery_info');
  assert.ok(addrCall, 'expected a project_set_delivery_info call');
  assert.equal(addrCall.args.p_project_id, 'FV-1');
  assert.equal(addrCall.args.p_fields.address, '123 Delete Me Ave');
});

test('processPhotoBatch: non-date-prefixed jobFolderPath skips address sync entirely', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/Some Legacy Folder Name',
    items: [upsertItem()],
  });

  assert.equal(sb.calls.rpc.find((c) => c.fn === 'project_set_delivery_info'), undefined);
});

test('processPhotoBatch: a failing address sync does not block the actual photo sync', async () => {
  const dbx = makeDbx();
  const sb = makeSb({
    async rpc(fn, args) {
      if (fn === 'project_set_delivery_info') throw new Error('rpc down');
      return { created: true, healed: false };
    },
  });
  const res = await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, {
    jobId: 'FV-1',
    jobFolderPath: '/2026.9.15 123 Delete Me Ave_Swan Si',
    items: [upsertItem()],
  });

  assert.equal(res.ok, 1); // the photo itself still synced fine
});

test('processPhotoBatch: a LARGE_THUMB_FOLDERS photo also gets a large render uploaded, with hasLarge:true', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const item = upsertItem({ path: '/JobA/Local Report/report.jpg', subFolder: 'Local Report', relPathFromJob: 'Local Report/report.jpg', filename: 'report.jpg' });
  await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });

  assert.equal(sb.calls.larges.length, 1);
  assert.equal(sb.calls.larges[0].jobId, 'FV-1');
  assert.ok(dbx.calls.thumbBatch.some((b) => b.size === 'w2048h1536'));

  const largeUpsert = sb.calls.rpc.find((c) => c.fn === 'photos_upsert' && c.args.p_photo.hasLarge === true);
  assert.ok(largeUpsert, 'expected a follow-up photos_upsert marking hasLarge:true');
});

test('processPhotoBatch: an ORIGINAL_RENDER_FOLDERS photo uses the TRUE original file, not a Dropbox thumbnail render', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const item = upsertItem({ path: '/JobA/Floorplan/main.png', subFolder: 'Floorplan', relPathFromJob: 'Floorplan/main.png', filename: 'main.png' });
  const cfg = { ...ENV, LARGE_THUMB_FOLDERS: 'Floorplan', ORIGINAL_RENDER_FOLDERS: 'Floorplan' };
  await processPhotoBatch(cfg, { dbx, sb, now: () => 'T' }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });

  assert.deepEqual(dbx.calls.downloads, ['/JobA/Floorplan/main.png']);
  // the small Gallery thumb (THUMB_SIZE) still goes through the normal
  // thumbnail-API path regardless -- only the LARGE render skips it here.
  assert.ok(dbx.calls.thumbBatch.every((b) => b.size === 'w1024h768'));
  assert.equal(dbx.calls.thumbV2.length, 0);
  assert.equal(sb.calls.larges.length, 1);
  assert.equal(sb.calls.larges[0].contentType, 'image/png'); // real content-type, not the jpeg default
  assert.ok(sb.calls.rpc.some((c) => c.fn === 'photos_upsert' && c.args.p_photo.hasLarge === true));
});

test('processPhotoBatch: a LARGE_THUMB_FOLDERS photo NOT also in ORIGINAL_RENDER_FOLDERS still uses the Dropbox thumbnail render', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const item = upsertItem({ path: '/JobA/Local Report/report.jpg', subFolder: 'Local Report', relPathFromJob: 'Local Report/report.jpg', filename: 'report.jpg' });
  const cfg = { ...ENV, ORIGINAL_RENDER_FOLDERS: 'Floorplan' }; // Local Report is large-thumb but not original-render
  await processPhotoBatch(cfg, { dbx, sb, now: () => 'T' }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });

  assert.equal(dbx.calls.downloads.length, 0);
  assert.ok(dbx.calls.thumbBatch.some((b) => b.size === 'w2048h1536'));
  assert.equal(sb.calls.larges[0].contentType, undefined); // default jpeg content-type applied server-side
});

test('processPhotoBatch: a failing original-file download for a Floorplan photo is queued for retry', async () => {
  const dbx = makeDbx({ async downloadFile() { throw new Error('dropbox 500'); } });
  const sb = makeSb();
  const item = upsertItem({ path: '/JobA/Floorplan/main.png', subFolder: 'Floorplan', relPathFromJob: 'Floorplan/main.png', filename: 'main.png' });
  const cfg = { ...ENV, LARGE_THUMB_FOLDERS: 'Floorplan', ORIGINAL_RENDER_FOLDERS: 'Floorplan' };
  await processPhotoBatch(cfg, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });

  assert.equal(sb.calls.larges.length, 0);
  assert.equal(sb.calls.pendingInserts.length, 1);
  assert.equal(sb.calls.pendingInserts[0].kind, 'large');
  assert.equal(sb.calls.pendingInserts[0].sourcePath, '/JobA/Floorplan/main.png');
});

test('processPhotoBatch: a photo NOT in LARGE_THUMB_FOLDERS never gets a large render', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  // default upsertItem() folder is "MLS", not in LARGE_THUMB_FOLDERS
  await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()] });
  assert.equal(sb.calls.larges.length, 0);
});

test('processPhotoBatch: a failing large render does not block the small thumb or the rest of the batch', async () => {
  const dbx = makeDbx();
  const sb = makeSb({
    async uploadLarge() { throw new Error('storage down'); },
  });
  const item = upsertItem({ path: '/JobA/Local Report/report.jpg', subFolder: 'Local Report', relPathFromJob: 'Local Report/report.jpg', filename: 'report.jpg' });
  const res = await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });
  assert.equal(res.ok, 1);
  assert.equal(sb.calls.thumbs.length, 1); // the small thumb still uploaded fine
  assert.equal(sb.calls.pendingInserts.length, 1); // queued for retry, not silently dropped
  assert.equal(sb.calls.pendingInserts[0].kind, 'large');
  assert.equal(sb.calls.pendingInserts[0].sourcePath, '/JobA/Local Report/report.jpg');
});

// ---------------------------------------------------------------------------
// processPhotoBatch: gallery hero/closing fallback large render
// ---------------------------------------------------------------------------

test('processPhotoBatch: a gallery-folder upsert triggers a large render for the current 3rd/5th fallback photos', async () => {
  const dbx = makeDbx();
  const currentGallery = [
    { photoId: 'p1', filename: '01.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p2', filename: '02.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p3', filename: '03.jpg', folder: 'MLS', status: 'ok', hasThumb: true, dropboxPath: '/JobA/MLS/03.jpg' },
    { photoId: 'p4', filename: '04.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p5', filename: '05.jpg', folder: 'MLS', status: 'ok', hasThumb: true, dropboxPath: '/JobA/MLS/05.jpg' },
  ];
  const sb = makeSb({ async getProjectPhotos() { return currentGallery; } });
  const res = await processPhotoBatch(ENV, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem({ path: '/JobA/MLS/06.jpg', filename: '06.jpg', relPathFromJob: 'MLS/06.jpg' })] });

  assert.equal(res.ok, 1);
  assert.deepEqual(dbx.calls.thumbV2.map((c) => c.path).sort(), ['/JobA/MLS/03.jpg', '/JobA/MLS/05.jpg']);
  assert.deepEqual(sb.calls.larges.map((c) => c.photoId).sort(), ['p3', 'p5']);
  assert.ok(sb.calls.rpc.some((c) => c.fn === 'photos_upsert' && c.args.p_photo.photoId === 'p3' && c.args.p_photo.hasLarge === true));
  assert.ok(sb.calls.rpc.some((c) => c.fn === 'photos_upsert' && c.args.p_photo.photoId === 'p5' && c.args.p_photo.hasLarge === true));
});

test('processPhotoBatch: fallback photos that already have hasLarge:true are not re-rendered', async () => {
  const dbx = makeDbx();
  const currentGallery = [
    { photoId: 'p1', filename: '01.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p2', filename: '02.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p3', filename: '03.jpg', folder: 'MLS', status: 'ok', hasThumb: true, hasLarge: true },
    { photoId: 'p4', filename: '04.jpg', folder: 'MLS', status: 'ok', hasThumb: true },
    { photoId: 'p5', filename: '05.jpg', folder: 'MLS', status: 'ok', hasThumb: true, hasLarge: true },
  ];
  const sb = makeSb({ async getProjectPhotos() { return currentGallery; } });
  await processPhotoBatch(ENV, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()] });

  assert.equal(dbx.calls.thumbV2.length, 0);
  assert.equal(sb.calls.larges.length, 0);
});

test('processPhotoBatch: a batch that never touches a gallery folder never checks the fallback at all', async () => {
  const dbx = makeDbx();
  const sb = makeSb({ async getProjectPhotos() { throw new Error('should not be called'); } });
  const item = upsertItem({ path: '/JobA/Local Report/report.jpg', subFolder: 'Local Report', relPathFromJob: 'Local Report/report.jpg', filename: 'report.jpg' });
  const res = await processPhotoBatch(ENV, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [item] });
  assert.equal(res.ok, 1); // did not throw -- getProjectPhotos was never called
});

test('processPhotoBatch: a failing fallback large render is queued for retry, not silently dropped', async () => {
  const dbx = makeDbx({ async getThumbnailV2() { throw new Error('dropbox 500'); } });
  const currentGallery = [
    { photoId: 'p1', filename: '01.jpg', folder: 'MLS', status: 'ok', hasThumb: true, dropboxPath: '/JobA/MLS/01.jpg' },
  ];
  const sb = makeSb({ async getProjectPhotos() { return currentGallery; } });
  await processPhotoBatch(ENV, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()] });

  assert.equal(sb.calls.pendingInserts.length, 1);
  assert.equal(sb.calls.pendingInserts[0].kind, 'large');
  assert.equal(sb.calls.pendingInserts[0].photoId, 'p1');
});

test('processPhotoBatch: a gallery-folder delete also re-checks the fallback', async () => {
  const dbx = makeDbx();
  const currentGallery = [
    { photoId: 'p1', filename: '01.jpg', folder: 'MLS', status: 'ok', hasThumb: true, dropboxPath: '/JobA/MLS/01.jpg' },
  ];
  const sb = makeSb({ async getProjectPhotos() { return currentGallery; } });
  await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1', jobFolderPath: '/JobA',
    items: [{ type: 'delete', path: '/JobA/MLS/gone.jpg', subFolder: 'MLS', relPathFromJob: 'MLS/gone.jpg', filename: 'gone.jpg' }],
  });
  assert.deepEqual(sb.calls.larges.map((c) => c.photoId), ['p1']);
});

test('processPhotoBatch: delivery copy falls back to get_thumbnail_v2 when the batch entry fails', async () => {
  const dbx = makeDbx({
    async getThumbnailBatch(paths, size) {
      this.calls.thumbBatch.push({ paths, size });
      // the big delivery size is rejected per-entry; the small one is fine
      if (size === 'w2048h1536') {
        return { entries: paths.map(() => ({ '.tag': 'failure', failure: { '.tag': 'unsupported_size' } })) };
      }
      return { entries: paths.map((p) => ({ '.tag': 'success', thumbnail: fakeThumb(p, size) })) };
    },
  });
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()],
  });
  assert.equal(res.ok, 1);
  assert.deepEqual(dbx.calls.thumbV2, [{ path: '/JobA/MLS/a.jpg', size: 'w2048h1536' }]);
  assert.equal(dbx.calls.uploads[0].path, '/JobA/MLS for download/a.jpg');
  assert.equal(dbx.calls.uploads[0].text, 'thumb:w2048h1536:/JobA/MLS/a.jpg');
});

test('processPhotoBatch: delivery-copy failure does not fail the photo', async () => {
  const dbx = makeDbx({
    async getThumbnailBatch(paths, size) {
      this.calls.thumbBatch.push({ paths, size });
      if (size === 'w2048h1536') throw new Error('dropbox 500');
      return { entries: paths.map((p) => ({ '.tag': 'success', thumbnail: fakeThumb(p, size) })) };
    },
    async getThumbnailV2() { throw new Error('dropbox 500 again'); },
  });
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()],
  });
  assert.equal(res.ok, 1); // Gallery record still saved
  assert.equal(dbx.calls.uploads.length, 0); // no delivery copy written
  assert.equal(sb.calls.pendingInserts.length, 1); // queued for retry, not silently dropped
  assert.equal(sb.calls.pendingInserts[0].kind, 'download_copy');
  assert.equal(sb.calls.pendingInserts[0].destPath, '/JobA/MLS for download/a.jpg');
});

test('processPhotoBatch: only successful photos get a delivery copy', async () => {
  const dbx = makeDbx();
  let n = 0;
  const sb = makeSb({ async uploadThumb() { n++; if (n === 1) throw new Error('storage boom'); } });
  await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [
      upsertItem(),
      upsertItem({ path: '/JobA/MLS/c.jpg', relPathFromJob: 'MLS/c.jpg', filename: 'c.jpg', id: 'id:3' }),
    ],
  });
  // a.jpg failed its Supabase upload -> no delivery copy; only c.jpg gets one
  assert.deepEqual(dbx.calls.uploads.map((u) => u.path), ['/JobA/MLS for download/c.jpg']);
});

test('processPhotoBatch: null dims trigger a get_metadata refetch', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [upsertItem({ dims: { width: null, height: null } })],
  });
  const rec = sb.calls.rpc.find((c) => c.fn === 'photos_upsert').args.p_photo;
  assert.equal(rec.width, 4000);
  assert.equal(rec.height, 3000);
  assert.ok(dbx.calls.metadata.some((m) => m.opts && m.opts.includeMediaInfo));
});

test('processPhotoBatch: present dims are used as-is, no refetch', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()],
  });
  const rec = sb.calls.rpc.find((c) => c.fn === 'photos_upsert').args.p_photo;
  assert.equal(rec.width, 100);
  assert.ok(!dbx.calls.metadata.some((m) => m.opts && m.opts.includeMediaInfo));
});

test('processPhotoBatch: delete -> mark pending + drop download copy', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [{ type: 'delete', path: '/JobA/MLS/a.jpg', subFolder: 'MLS', relPathFromJob: 'MLS/a.jpg', filename: 'a.jpg' }],
  });
  assert.equal(res.deletes, 1);
  assert.equal(sb.calls.rpc[0].fn, 'photos_mark_pending');
  assert.equal(sb.calls.rpc[0].args.p_project_id, 'FV-1');
  assert.deepEqual(dbx.calls.deletes, ['/JobA/MLS for download/a.jpg']);
});

test('processPhotoBatch: a same-batch replacement (delete old extension + upload new extension) does not delete the new download copy', async () => {
  // Found in real use 2026-09-16 (48 Red Ash Dr): a photo was replaced by
  // deleting the old file and dragging in a new one under a DIFFERENT
  // extension (a.jpg -> a.jpeg). downloadCopyPath() normalizes both to the
  // same "MLS for download/a.jpg" destination, and upserts are processed
  // before deletes -- so without the deliveredDestPaths guard, this delete
  // would wipe out the replacement's brand new copy right after it was written.
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [
      upsertItem({ path: '/JobA/MLS/a.jpeg', filename: 'a.jpeg', relPathFromJob: 'MLS/a.jpeg' }),
      { type: 'delete', path: '/JobA/MLS/a.jpg', subFolder: 'MLS', relPathFromJob: 'MLS/a.jpg', filename: 'a.jpg' },
    ],
  });
  assert.equal(res.ok, 1);
  assert.equal(res.deletes, 1);
  // the replacement's copy was written...
  assert.deepEqual(dbx.calls.uploads.map((u) => u.path), ['/JobA/MLS for download/a.jpg']);
  // ...and NOT then deleted by the old file's cleanup
  assert.deepEqual(dbx.calls.deletes, []);
});

test('processPhotoBatch: a genuine standalone delete (no same-batch replacement) still drops its download copy', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [{ type: 'delete', path: '/JobA/MLS/z.jpg', subFolder: 'MLS', relPathFromJob: 'MLS/z.jpg', filename: 'z.jpg' }],
  });
  assert.equal(res.deletes, 1);
  assert.deepEqual(dbx.calls.deletes, ['/JobA/MLS for download/z.jpg']);
});

test('processPhotoBatch: non-MLS delete does not touch Dropbox', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [{ type: 'delete', path: '/JobA/Floorplan/b.png', subFolder: 'Floorplan', relPathFromJob: 'Floorplan/b.png', filename: 'b.png' }],
  });
  assert.equal(dbx.calls.deletes.length, 0);
  assert.equal(sb.calls.rpc[0].fn, 'photos_mark_pending');
});

test('processPhotoBatch: self-heal is counted from rpc result', async () => {
  const dbx = makeDbx();
  const sb = makeSb({ async rpc() { return { created: false, healed: true }; } });
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()],
  });
  assert.equal(res.healed, 1);
});

test('processPhotoBatch: one bad photo does not sink the batch', async () => {
  const dbx = makeDbx();
  let n = 0;
  const sb = makeSb({
    async uploadThumb() { n++; if (n === 1) throw new Error('storage boom'); },
  });
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [
      upsertItem(),
      upsertItem({ path: '/JobA/MLS/c.jpg', relPathFromJob: 'MLS/c.jpg', filename: 'c.jpg', id: 'id:3' }),
    ],
  });
  assert.equal(res.ok, 1);
  assert.equal(res.skipped, 1);
});

test('processPhotoBatch: a failed thumbnail entry is skipped, not fatal', async () => {
  const dbx = makeDbx({
    async getThumbnailBatch(paths) {
      return { entries: paths.map((p, i) => (i === 0 ? { '.tag': 'failure', failure: { '.tag': 'unsupported_image' } } : { '.tag': 'success', thumbnail: fakeThumb(p) })) };
    },
  });
  const sb = makeSb();
  const res = await processPhotoBatch(ENV, { dbx, sb }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [
      upsertItem(),
      upsertItem({ path: '/JobA/MLS/c.jpg', relPathFromJob: 'MLS/c.jpg', filename: 'c.jpg', id: 'id:3' }),
    ],
  });
  assert.equal(res.ok, 1);
  assert.equal(res.skipped, 1);
});

test('processPhotoBatch: whole-chunk thumbnail failure throws (queue will retry)', async () => {
  const dbx = makeDbx({ async getThumbnailBatch() { throw new Error('dropbox 503'); } });
  const sb = makeSb();
  await assert.rejects(
    () => processPhotoBatch(ENV, { dbx, sb }, { jobId: 'FV-1', jobFolderPath: '/JobA', items: [upsertItem()] }),
    /get_thumbnail_batch failed/,
  );
});

test('runDelta: fans out one photo-batch per tagged job, advances cursor', async () => {
  const dbx = makeDbx({
    async listFolderContinue() {
      return {
        entries: [
          { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1', rev: 'r1' },
          { '.tag': 'file', path_display: '/JobA/Home Report/r.pdf', path_lower: '/joba/home report/r.pdf' },
        ],
        cursor: 'C1',
        has_more: false,
      };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runDelta(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m), now: () => 'T' });

  assert.equal(res.dispatched, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].type, 'photo-batch');
  assert.equal(enqueued[0].jobId, 'FV-1');
  assert.equal(enqueued[0].items.length, 1);
  assert.equal(sb.calls.patch[0].cursor, 'C1');
  assert.equal(sb.calls.release, 1);
});

test('runDelta: also fans out one video-batch per tagged job, alongside photo-batch', async () => {
  const dbx = makeDbx({
    async listFolderContinue() {
      return {
        entries: [
          { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1', rev: 'r1' },
          { '.tag': 'file', path_display: '/JobA/Video/walkthrough.mp4', path_lower: '/joba/video/walkthrough.mp4', id: 'id:2', rev: 'r2' },
        ],
        cursor: 'C1',
        has_more: false,
      };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runDelta({ ...ENV, VIDEO_SYNC_FOLDERS: 'Video,VLOG' }, { dbx, sb, enqueue: (m) => enqueued.push(m), now: () => 'T' });

  assert.equal(res.dispatched, 1);
  assert.equal(res.videoDispatched, 1);
  const videoMsg = enqueued.find((m) => m.type === 'video-batch');
  assert.ok(videoMsg);
  assert.equal(videoMsg.jobId, 'FV-1');
  assert.equal(videoMsg.items[0].filename, 'walkthrough.mp4');
});

test('runDelta: also fans out one tour-link-batch per tagged job, alongside photo-batch', async () => {
  const dbx = makeDbx({
    async listFolderContinue() {
      return {
        entries: [
          { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1', rev: 'r1' },
          { '.tag': 'file', path_display: '/JobA/Tour Link.txt', path_lower: '/joba/tour link.txt' },
        ],
        cursor: 'C1',
        has_more: false,
      };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runDelta({ ...ENV, TOUR_LINK_FILENAME: 'Tour Link.txt' }, { dbx, sb, enqueue: (m) => enqueued.push(m), now: () => 'T' });

  assert.equal(res.dispatched, 1);
  assert.equal(res.tourLinkDispatched, 1);
  const tourMsg = enqueued.find((m) => m.type === 'tour-link-batch');
  assert.ok(tourMsg);
  assert.equal(tourMsg.jobId, 'FV-1');
  assert.equal(tourMsg.items[0].path, '/JobA/Tour Link.txt');
});

test('runDelta: skips when the lease is held', async () => {
  const dbx = makeDbx();
  const sb = makeSb({ async acquireLease() { return false; } });
  const enqueued = [];
  const res = await runDelta(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m) });
  assert.deepEqual(res, { skipped: 'locked' });
  assert.equal(enqueued.length, 0);
});

test('runDelta: first run with no cursor just stores get_latest_cursor', async () => {
  const dbx = makeDbx({ async listFolderGetLatestCursor() { return 'CURSOR0'; } });
  const sb = makeSb({ async getSyncState() { return { cursor: null }; } });
  const enqueued = [];
  const res = await runDelta(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m) });
  assert.deepEqual(res, { initialized: true });
  assert.equal(sb.calls.patch[0].cursor, 'CURSOR0');
  assert.equal(enqueued.length, 0);
});

test('runDelta: re-enqueues itself when has_more', async () => {
  const dbx = makeDbx({
    async listFolderContinue() {
      return { entries: [], cursor: 'C1', has_more: true };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  await runDelta({ ...ENV, MAX_DELTA_ENTRIES_PER_RUN: '0' }, { dbx, sb, enqueue: (m) => enqueued.push(m) });
  assert.ok(enqueued.some((m) => m.type === 'delta'));
});

test('runBackfill(all): walks root and enqueues per job, no cursor writes', async () => {
  const dbx = makeDbx({
    async listFolder() {
      return {
        entries: [
          { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1' },
          { '.tag': 'file', path_display: '/JobB/Floorplan/b.jpg', path_lower: '/jobb/floorplan/b.jpg', id: 'id:2' },
        ],
        has_more: false,
      };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runBackfill(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m) }, {});
  assert.equal(res.jobs, 2);
  assert.equal(enqueued.length, 2);
  assert.ok(enqueued.every((m) => m.type === 'photo-batch'));
  assert.equal(sb.calls.patch.length, 0); // backfill never touches the cursor
});

test('runBackfill(all): also walks VIDEO_SYNC_FOLDERS and enqueues video-batch per job', async () => {
  const dbx = makeDbx({
    async listFolder() {
      return {
        entries: [
          { '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1' },
          { '.tag': 'file', path_display: '/JobA/Video/walkthrough.mp4', path_lower: '/joba/video/walkthrough.mp4', id: 'id:2' },
        ],
        has_more: false,
      };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runBackfill({ ...ENV, VIDEO_SYNC_FOLDERS: 'Video,VLOG' }, { dbx, sb, enqueue: (m) => enqueued.push(m) }, {});

  assert.equal(res.dispatched, 1);
  assert.equal(res.videoDispatched, 1);
  const videoMsg = enqueued.find((m) => m.type === 'video-batch');
  assert.ok(videoMsg);
  assert.equal(videoMsg.jobId, 'FV-1');
  assert.equal(videoMsg.items[0].filename, 'walkthrough.mp4');
});

test('runBackfill(jobId): locates the folder via propertiesSearch', async () => {
  const dbx = makeDbx({
    async propertiesSearch() { return { id: 'id:folder', path: '/JobA' }; },
    async listFolder(path) {
      assert.equal(path, '/JobA');
      return { entries: [{ '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1' }], has_more: false };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runBackfill(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m) }, { jobId: 'FV-1' });
  assert.equal(res.scope, 'FV-1');
  assert.equal(enqueued[0].jobId, 'FV-1');
});

test('runBackfill(jobId): re-resolves a stale propertiesSearch path via get_metadata(id) before listing', async () => {
  // Real incident (2026-09-16): properties/search kept returning a path
  // that no longer existed even though the folder never moved -- listFolder
  // on the stale path 404s. get_metadata by the search result's stable id
  // returns the real current path_display, which is what must get listed.
  const dbx = makeDbx({
    async propertiesSearch() { return { id: 'id:folder', path: '/Stale Parent/JobA' }; },
    async getMetadata(path) {
      if (path === 'id:folder') return { '.tag': 'folder', path_display: '/JobA' };
      throw new Error('unexpected getMetadata path: ' + path);
    },
    async listFolder(path) {
      assert.equal(path, '/JobA'); // NOT the stale '/Stale Parent/JobA'
      return { entries: [{ '.tag': 'file', path_display: '/JobA/MLS/a.jpg', path_lower: '/joba/mls/a.jpg', id: 'id:1' }], has_more: false };
    },
  });
  const sb = makeSb();
  const enqueued = [];
  const res = await runBackfill(ENV, { dbx, sb, enqueue: (m) => enqueued.push(m) }, { jobId: 'FV-1' });
  assert.equal(res.scope, 'FV-1');
  assert.equal(enqueued[0].jobId, 'FV-1');
});

test('runBackfill(jobId): a failed id-resolution falls back to the (possibly stale) search path rather than blocking', async () => {
  const dbx = makeDbx({
    async propertiesSearch() { return { id: 'id:folder', path: '/JobA' }; },
    async getMetadata() { throw new Error('network blip'); },
    async listFolder(path) {
      assert.equal(path, '/JobA');
      return { entries: [], has_more: false };
    },
  });
  const sb = makeSb();
  const res = await runBackfill(ENV, { dbx, sb, enqueue: () => {} }, { jobId: 'FV-1' });
  assert.equal(res.scope, 'FV-1');
});

// ---------------------------------------------------------------------------
// processRenderRetryPoll
// ---------------------------------------------------------------------------

function pendingRow(over = {}) {
  return {
    id: 1, project_id: 'FV-1', kind: 'download_copy',
    source_path: '/JobA/MLS/a.jpg', dest_path: '/JobA/MLS for download/a.jpg',
    photo_id: null, filename: 'a.jpg', attempts: 0, last_error: null,
    ...over,
  };
}

test('processRenderRetryPoll: a successful download_copy retry uploads + deletes the pending row', async () => {
  const dbx = makeDbx();
  const deleted = [];
  const sb = makeSb({
    async listPendingRenders() { return [pendingRow()]; },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const res = await processRenderRetryPoll(ENV, { dbx, sb });
  assert.equal(res.succeeded, 1);
  assert.equal(dbx.calls.uploads[0].path, '/JobA/MLS for download/a.jpg');
  assert.deepEqual(deleted, [1]);
});

test('processRenderRetryPoll: a successful large retry uploads + upserts hasLarge + deletes the pending row', async () => {
  const dbx = makeDbx();
  const deleted = [];
  const sb = makeSb({
    async listPendingRenders() {
      return [pendingRow({ kind: 'large', dest_path: null, photo_id: 'pid-1' })];
    },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const res = await processRenderRetryPoll(ENV, { dbx, sb });
  assert.equal(res.succeeded, 1);
  assert.equal(sb.calls.larges[0].photoId, 'pid-1');
  assert.ok(sb.calls.rpc.some((c) => c.fn === 'photos_upsert' && c.args.p_photo.hasLarge === true));
  assert.deepEqual(deleted, [1]);
});

test('processRenderRetryPoll: a large retry for an ORIGINAL_RENDER_FOLDERS photo re-derives that from source_path and uses the true original', async () => {
  const dbx = makeDbx();
  const deleted = [];
  const sb = makeSb({
    async listPendingRenders() {
      return [pendingRow({
        kind: 'large', dest_path: null, photo_id: 'fp-1',
        source_path: '/JobA/Floorplan/main.png', filename: 'main.png',
      })];
    },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const cfg = { ...ENV, ORIGINAL_RENDER_FOLDERS: 'Floorplan' };
  const res = await processRenderRetryPoll(cfg, { dbx, sb });
  assert.equal(res.succeeded, 1);
  assert.deepEqual(dbx.calls.downloads, ['/JobA/Floorplan/main.png']);
  assert.equal(dbx.calls.thumbV2.length, 0);
  assert.equal(sb.calls.larges[0].contentType, 'image/png');
  assert.deepEqual(deleted, [1]);
});

test('processRenderRetryPoll: a failed retry increments attempts and records the error, without deleting the row', async () => {
  const dbx = makeDbx({ async getThumbnailV2() { throw new Error('still down'); } });
  const updates = [];
  const deleted = [];
  const sb = makeSb({
    async listPendingRenders() { return [pendingRow({ attempts: 2 })]; },
    async updatePendingRender(id, fields) { updates.push({ id, fields }); },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const res = await processRenderRetryPoll(ENV, { dbx, sb });
  assert.equal(res.failed, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].fields.attempts, 3);
  assert.equal(updates[0].fields.last_error, 'still down');
  assert.deepEqual(deleted, []);
});

test('processRenderRetryPoll: a row past MAX_RENDER_RETRY_ATTEMPTS is abandoned (deleted, not retried forever)', async () => {
  const dbx = makeDbx({ async getThumbnailV2() { throw new Error('gone'); } });
  const deleted = [];
  const updates = [];
  const sb = makeSb({
    async listPendingRenders() { return [pendingRow({ attempts: MAX_RENDER_RETRY_ATTEMPTS - 1 })]; },
    async updatePendingRender(id, fields) { updates.push({ id, fields }); },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const res = await processRenderRetryPoll(ENV, { dbx, sb });
  assert.equal(res.abandoned, 1);
  assert.deepEqual(deleted, [1]);
  assert.deepEqual(updates, []); // abandoned, not left pending for another attempt
});

test('processRenderRetryPoll: one bad row does not block the rest', async () => {
  const dbx = makeDbx({
    async getThumbnailV2(path, size) {
      if (path === '/JobA/MLS/bad.jpg') throw new Error('bad file');
      return base64ToBytesLocal(fakeThumb(path, size));
    },
  });
  const deleted = [];
  const sb = makeSb({
    async listPendingRenders() {
      return [
        pendingRow({ id: 1, source_path: '/JobA/MLS/bad.jpg', dest_path: '/JobA/MLS for download/bad.jpg' }),
        pendingRow({ id: 2, source_path: '/JobA/MLS/a.jpg', dest_path: '/JobA/MLS for download/a.jpg' }),
      ];
    },
    async deletePendingRender(id) { deleted.push(id); },
  });
  const res = await processRenderRetryPoll(ENV, { dbx, sb });
  assert.equal(res.succeeded, 1);
  assert.equal(res.failed, 1);
  assert.deepEqual(deleted, [2]); // only the good one got cleaned up
});

test('processPhotoBatch: HDR Photos/Callout photo -> download copy in MLS for download/Callout/, delete removes it', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const callout = { path: '/JobA/HDR Photos/Callout/c.jpg', subFolder: 'Callout', relPathFromJob: 'HDR Photos/Callout/c.jpg', filename: 'c.jpg' };
  await processPhotoBatch(ENV, { dbx, sb, now: () => 'T' }, {
    jobId: 'FV-1', jobFolderPath: '/JobA',
    items: [
      upsertItem({ ...callout, id: 'id:9', rev: 'r9', dims: { width: 100, height: 50 } }),
      // a Callout directly under the job folder (not a layout Job Generator creates) gets no download copy
      upsertItem({ path: '/JobA/Callout/d.jpg', subFolder: 'Callout', relPathFromJob: 'Callout/d.jpg', filename: 'd.jpg', id: 'id:10', rev: 'r10', dims: { width: 100, height: 50 } }),
    ],
  });
  assert.deepEqual(dbx.calls.uploads.map((u) => u.path), ['/JobA/MLS for download/Callout/c.jpg']);
  const rec = sb.calls.rpc.find((c) => c.args.p_photo && c.args.p_photo.filename === 'c.jpg').args.p_photo;
  assert.equal(rec.downloadDropboxPath, '/JobA/MLS for download/Callout/c.jpg');

  const dbx2 = makeDbx();
  await processPhotoBatch(ENV, { dbx: dbx2, sb: makeSb() }, {
    jobId: 'FV-1', jobFolderPath: '/JobA', items: [{ type: 'delete', ...callout }],
  });
  assert.deepEqual(dbx2.calls.deletes, ['/JobA/MLS for download/Callout/c.jpg']);
});
