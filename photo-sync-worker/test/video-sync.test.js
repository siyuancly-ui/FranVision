import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyForVideoSync, processVideoBatch, processVideoPoll } from '../src/video-sync.js';

const cfg = { root: '', videoSyncFolders: ['Video', 'VLOG'] };

function makeDbx(over = {}) {
  const calls = { tempLinks: [] };
  return {
    calls,
    async getTemporaryLink(path) {
      calls.tempLinks.push(path);
      return { link: `https://dropbox.example/tmp?path=${encodeURIComponent(path)}` };
    },
    ...over,
  };
}

function makeStream(over = {}) {
  const calls = { copies: [], statuses: [] };
  return {
    calls,
    async copyFromUrl(url, meta) {
      calls.copies.push({ url, meta });
      return { uid: `uid-${meta.videoId}` };
    },
    async getStatus(uid) {
      calls.statuses.push(uid);
      return { readyToStream: false, status: { state: 'inprogress' } };
    },
    ...over,
  };
}

function makeSb(over = {}) {
  const calls = { rpc: [], pending: [], deletedPending: [] };
  return {
    calls,
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      return {};
    },
    async insertPendingVideo(row) {
      calls.pending.push(row);
    },
    async listPendingVideos() {
      return calls._rows || [];
    },
    async deletePendingVideo(id) {
      calls.deletedPending.push(id);
    },
    ...over,
  };
}

const upsertItem = (over = {}) => ({
  type: 'upsert',
  path: '/JobA/Video/walkthrough.mp4',
  subFolder: 'Video',
  relPathFromJob: 'Video/walkthrough.mp4',
  filename: 'walkthrough.mp4',
  id: 'id:1',
  rev: 'r1',
  ...over,
});

test('classifyForVideoSync: keeps video files under VIDEO_SYNC_FOLDERS, ignores images/other folders', () => {
  const entries = [
    { '.tag': 'file', path_display: '/JobA/Video/walkthrough.mp4' },
    { '.tag': 'file', path_display: '/JobA/MLS/a.jpg' },
    { '.tag': 'file', path_display: '/JobA/Video/notes.pdf' },
    { '.tag': 'deleted', path_display: '/JobA/VLOG/day1.mov' },
  ];
  const out = classifyForVideoSync(entries, cfg);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'upsert');
  assert.equal(out[0].filename, 'walkthrough.mp4');
  assert.equal(out[1].type, 'delete');
  assert.equal(out[1].filename, 'day1.mov');
});

test('processVideoBatch: upsert gets a temp link, kicks off a Stream copy, writes processing + pending row', async () => {
  const dbx = makeDbx();
  const stream = makeStream();
  const sb = makeSb();

  const res = await processVideoBatch({}, { dbx, sb, stream, now: () => 'T' }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [upsertItem()],
  });

  assert.equal(res.ok, 1);
  assert.equal(dbx.calls.tempLinks[0], '/JobA/Video/walkthrough.mp4');
  assert.equal(stream.calls.copies.length, 1);
  assert.equal(stream.calls.copies[0].meta.jobId, 'FV-1');

  const rpcCall = sb.calls.rpc.find((c) => c.fn === 'videos_upsert');
  assert.ok(rpcCall);
  assert.equal(rpcCall.args.p_video.status, 'processing');
  assert.equal(rpcCall.args.p_video.filename, 'walkthrough.mp4');
  assert.equal(rpcCall.args.p_video.streamUid, `uid-${stream.calls.copies[0].meta.videoId}`);

  assert.equal(sb.calls.pending.length, 1);
  assert.equal(sb.calls.pending[0].projectId, 'FV-1');
  assert.equal(sb.calls.pending[0].streamUid, rpcCall.args.p_video.streamUid);
});

test('processVideoBatch: delete marks pending_review, does not touch Stream', async () => {
  const dbx = makeDbx();
  const stream = makeStream();
  const sb = makeSb();

  const res = await processVideoBatch({}, { dbx, sb, stream }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [{ type: 'delete', path: '/JobA/Video/old.mp4', subFolder: 'Video', relPathFromJob: 'Video/old.mp4', filename: 'old.mp4' }],
  });

  assert.equal(res.deletes, 1);
  const rpcCall = sb.calls.rpc.find((c) => c.fn === 'videos_mark_pending');
  assert.ok(rpcCall);
  assert.equal(stream.calls.copies.length, 0);
});

test('processVideoBatch: one bad item is skipped, does not sink the batch', async () => {
  const dbx = makeDbx({ async getTemporaryLink() { throw new Error('dropbox 500'); } });
  const stream = makeStream();
  const sb = makeSb();

  const res = await processVideoBatch({}, { dbx, sb, stream }, {
    jobId: 'FV-1',
    jobFolderPath: '/JobA',
    items: [upsertItem()],
  });

  assert.equal(res.ok, 0);
  assert.equal(res.skipped, 1);
});

test('processVideoPoll: ready video gets finalized and removed from pending', async () => {
  const stream = makeStream({
    async getStatus(uid) {
      return { readyToStream: true, duration: 42, thumbnail: 'https://thumb', status: { state: 'ready' } };
    },
  });
  const sb = makeSb();
  sb.calls._rows = [{ id: 1, project_id: 'FV-1', video_id: 'v1', stream_uid: 'uid-v1' }];

  const res = await processVideoPoll({}, { sb, stream, now: () => 'T' });

  assert.equal(res.ready, 1);
  const rpcCall = sb.calls.rpc.find((c) => c.fn === 'videos_upsert');
  assert.equal(rpcCall.args.p_video.status, 'ok');
  assert.equal(rpcCall.args.p_video.durationSec, 42);
  assert.ok(rpcCall.args.p_video.playbackUrl.includes('uid-v1'));
  assert.deepEqual(sb.calls.deletedPending, [1]);
});

test('processVideoPoll: Stream-reported error finalizes as error and clears the pending row', async () => {
  const stream = makeStream({
    async getStatus() { return { readyToStream: false, status: { state: 'error' } }; },
  });
  const sb = makeSb();
  sb.calls._rows = [{ id: 2, project_id: 'FV-1', video_id: 'v2', stream_uid: 'uid-v2' }];

  const res = await processVideoPoll({}, { sb, stream });

  assert.equal(res.errored, 1);
  const rpcCall = sb.calls.rpc.find((c) => c.fn === 'videos_upsert');
  assert.equal(rpcCall.args.p_video.status, 'error');
  assert.deepEqual(sb.calls.deletedPending, [2]);
});

test('processVideoPoll: still-encoding video is left alone for the next tick', async () => {
  const stream = makeStream(); // default: readyToStream:false, state:'inprogress'
  const sb = makeSb();
  sb.calls._rows = [{ id: 3, project_id: 'FV-1', video_id: 'v3', stream_uid: 'uid-v3' }];

  const res = await processVideoPoll({}, { sb, stream });

  assert.equal(res.stillPending, 1);
  assert.equal(sb.calls.rpc.length, 0);
  assert.equal(sb.calls.deletedPending.length, 0);
});

test('processVideoPoll: a transient status-check failure leaves the row for the next tick', async () => {
  const stream = makeStream({ async getStatus() { throw new Error('network blip'); } });
  const sb = makeSb();
  sb.calls._rows = [{ id: 4, project_id: 'FV-1', video_id: 'v4', stream_uid: 'uid-v4' }];

  const res = await processVideoPoll({}, { sb, stream });

  assert.equal(res.ready, 0);
  assert.equal(res.errored, 0);
  assert.equal(sb.calls.deletedPending.length, 0);
});
