import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyForTourLink, processTourLinkBatch } from '../src/tour-link-sync.js';

const cfg = { root: '', tourLinkFilename: 'Tour Link.txt' };

function makeDbx(over = {}) {
  const calls = { downloads: [] };
  return {
    calls,
    async downloadText(path) {
      calls.downloads.push(path);
      return 'https://my.matterport.com/show/?m=abc123\n';
    },
    ...over,
  };
}

function makeSb(over = {}) {
  const calls = { rpc: [] };
  return {
    calls,
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      return {};
    },
    ...over,
  };
}

test('classifyForTourLink: keeps only the Tour Link file, ignores everything else', () => {
  const entries = [
    { '.tag': 'file', path_display: '/JobA/Tour Link.txt' },
    { '.tag': 'file', path_display: '/JobA/HDR Photos/a.jpg' },
    { '.tag': 'file', path_display: '/JobA/HDR Photos/Tour Link.txt' }, // nested -- not the job root
    { '.tag': 'deleted', path_display: '/JobB/Tour Link.txt' },
  ];
  const out = classifyForTourLink(entries, cfg);
  assert.deepEqual(out.map((i) => [i.type, i.path, i.jobFolder]), [
    ['upsert', '/JobA/Tour Link.txt', 'JobA'],
    ['delete', '/JobB/Tour Link.txt', 'JobB'],
  ]);
});

test('processTourLinkBatch: upsert downloads the text and writes trimmed tourUrl', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processTourLinkBatch({}, { dbx, sb }, {
    jobId: 'FV-1',
    items: [{ type: 'upsert', path: '/JobA/Tour Link.txt', jobFolder: 'JobA' }],
  });
  assert.equal(res.ok, 1);
  assert.deepEqual(dbx.calls.downloads, ['/JobA/Tour Link.txt']);
  assert.equal(sb.calls.rpc[0].fn, 'project_set_delivery_info');
  assert.equal(sb.calls.rpc[0].args.p_project_id, 'FV-1');
  assert.equal(sb.calls.rpc[0].args.p_fields.tourUrl, 'https://my.matterport.com/show/?m=abc123');
});

test('processTourLinkBatch: an empty/whitespace-only file clears tourUrl to null, not an empty string', async () => {
  const dbx = makeDbx({ async downloadText() { return '   \n'; } });
  const sb = makeSb();
  await processTourLinkBatch({}, { dbx, sb }, {
    jobId: 'FV-1',
    items: [{ type: 'upsert', path: '/JobA/Tour Link.txt', jobFolder: 'JobA' }],
  });
  assert.equal(sb.calls.rpc[0].args.p_fields.tourUrl, null);
});

test('processTourLinkBatch: delete clears tourUrl without touching Dropbox', async () => {
  const dbx = makeDbx();
  const sb = makeSb();
  const res = await processTourLinkBatch({}, { dbx, sb }, {
    jobId: 'FV-1',
    items: [{ type: 'delete', path: '/JobA/Tour Link.txt', jobFolder: 'JobA' }],
  });
  assert.equal(res.cleared, 1);
  assert.equal(dbx.calls.downloads.length, 0);
  assert.equal(sb.calls.rpc[0].fn, 'project_set_delivery_info');
  assert.equal(sb.calls.rpc[0].args.p_fields.tourUrl, null);
});

test('processTourLinkBatch: a download failure is logged and skipped, does not throw', async () => {
  const dbx = makeDbx({ async downloadText() { throw new Error('dropbox 500'); } });
  const sb = makeSb();
  const res = await processTourLinkBatch({}, { dbx, sb }, {
    jobId: 'FV-1',
    items: [{ type: 'upsert', path: '/JobA/Tour Link.txt', jobFolder: 'JobA' }],
  });
  assert.equal(res.skipped, 1);
  assert.equal(sb.calls.rpc.length, 0);
});
