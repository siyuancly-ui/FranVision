import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDelta, processPhotoBatch, runBackfill } from '../src/sync.js';

const ENV = {
  DROPBOX_JOBS_ROOT: '',
  SYNC_FOLDERS: 'MLS,Virtual Staging,Floorplan,Local Report',
  DOWNLOAD_SET_FOLDERS: 'MLS',
  DOWNLOAD_SUBFOLDER: 'MLS for download',
  THUMB_SIZE: 'w1024h768',
  DOWNLOAD_THUMB_SIZE: 'w2048h1536',
  LARGE_THUMB_FOLDERS: 'Cover Photo,Closing Photo,Drone Callout,Local Report',
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
  const calls = { uploads: [], deletes: [], thumbBatch: [], thumbV2: [], metadata: [] };
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
  const calls = { thumbs: [], larges: [], rpc: [], patch: [], lease: 0, release: 0 };
  return {
    calls,
    async uploadThumb(jobId, photoId, bytes) {
      calls.thumbs.push({ jobId, photoId, len: bytes.length });
    },
    async uploadLarge(jobId, photoId, bytes) {
      calls.larges.push({ jobId, photoId, len: bytes.length });
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
