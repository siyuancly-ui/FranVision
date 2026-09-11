// Run with: node file-sync.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner (same
// pattern as dropbox-sync.test.js). Real filesystem via temp dirs for the
// walk/manifest tests; a fake Dropbox client (dependency-injected via the
// `client`/`downloadImpl` params) for everything that would otherwise
// need a real network call, so this suite never touches the real Dropbox
// API.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fileSync = require('./file-sync.js');
const {
  isExcludedName,
  isUnderExcludedTopFolder,
  walkFiles,
  readManifest,
  writeManifest,
  planPush,
  planPull,
  uploadFile,
  downloadFile,
  pushJobFilesToDropbox,
  pullJobFilesFromDropbox,
  looksLikeAComponentFolderNotAJobFolder,
  MANIFEST_FILENAME,
} = fileSync;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-filesync-test-'));
}

// A fake filesUpload that never reads its `contents` stream leaves the
// stream's lazy async file-open pending; if the test's temp dir gets
// deleted before that fires, it surfaces as an unhandled 'error' event
// well after the test itself has already passed. Every fake filesUpload()
// below drains the stream through this first.
function consumeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('data', () => {});
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

// ---- isExcludedName ----

test('isExcludedName: .DS_Store and the manifest file are excluded', () => {
  assert.strictEqual(isExcludedName('.DS_Store'), true);
  assert.strictEqual(isExcludedName(MANIFEST_FILENAME), true);
});

test('isExcludedName: Office-style lock files (~$*) are excluded', () => {
  assert.strictEqual(isExcludedName('~$Feature Sheet.docx'), true);
});

test('isExcludedName: an ordinary photo/video filename is not excluded', () => {
  assert.strictEqual(isExcludedName('DSC_0001.jpg'), false);
});

test('isExcludedName: job.json, Job Info.txt, and Shoot Schedule.ics are excluded -- local-only, never synced', () => {
  assert.strictEqual(isExcludedName('job.json'), true);
  assert.strictEqual(isExcludedName('Job Info.txt'), true);
  assert.strictEqual(isExcludedName('Shoot Schedule.ics'), true);
});

test('isExcludedName: the legacy "Shoot Info" folder is still excluded', () => {
  assert.strictEqual(isExcludedName('Shoot Info'), true);
});

test('isExcludedName: the Dropbox-only "MLS for download" folder is excluded', () => {
  assert.strictEqual(isExcludedName('MLS for download'), true);
});

test('isUnderExcludedTopFolder: matches on the first path segment of a nested file', () => {
  assert.strictEqual(isUnderExcludedTopFolder('MLS for download/DSC_0001.jpg'), true);
  assert.strictEqual(isUnderExcludedTopFolder('MLS/DSC_0001.jpg'), false);
});

// ---- walkFiles ----

test('walkFiles: finds nested files with forward-slash relative paths, excludes junk', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, '0 RAW', '1 Raws'), { recursive: true });
    fs.writeFileSync(path.join(dir, '0 RAW', '1 Raws', 'DSC_0001.jpg'), 'fake image data');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(dir, 'job.json'), '{}');
    fs.writeFileSync(path.join(dir, 'Job Info.txt'), 'human-readable info');

    const files = walkFiles(dir);
    assert.deepStrictEqual(files.map((f) => f.relativePath), ['0 RAW/1 Raws/DSC_0001.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFiles: never descends into the "Shoot Info" folder (calendar .ics + reference images)', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, '0 RAW'), { recursive: true });
    fs.writeFileSync(path.join(dir, '0 RAW', 'DSC_0001.jpg'), 'fake image data');
    fs.mkdirSync(path.join(dir, 'Shoot Info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Shoot Info', 'Shoot Schedule.ics'), 'BEGIN:VCALENDAR');
    fs.writeFileSync(path.join(dir, 'Shoot Info', 'reference.jpg'), 'fake reference image');

    const files = walkFiles(dir);
    assert.deepStrictEqual(files.map((f) => f.relativePath), ['0 RAW/DSC_0001.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- manifest read/write ----

test('readManifest: returns {} when missing or malformed', () => {
  const dir = makeTmpDir();
  try {
    assert.deepStrictEqual(readManifest(dir), {});
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), 'not json');
    assert.deepStrictEqual(readManifest(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifest then readManifest round-trips', () => {
  const dir = makeTmpDir();
  try {
    const manifest = { 'a.jpg': { local: { size: 100, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 100 } } };
    writeManifest(dir, manifest);
    assert.deepStrictEqual(readManifest(dir), manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- looksLikeAComponentFolderNotAJobFolder (pure) ----
// Regression coverage for a real mistake (2026-09-08): pointing Push/Pull
// at a job's own subfolder (e.g. "0 RAW", "MLS") instead of the job's
// top-level folder created a disconnected top-level Dropbox folder named
// "0 RAW"/"MLS" with no relation to the actual job.

test('looksLikeAComponentFolderNotAJobFolder: true for every known component folder name', () => {
  ['0 RAW', 'Revisions', 'Home Report', 'Local Report', 'MLS', 'Floorplan', 'Virtual Staging', 'Feature Sheets', 'Video', 'VLOG'].forEach((name) => {
    assert.strictEqual(looksLikeAComponentFolderNotAJobFolder('/Users/x/Some Job/' + name), true, name);
  });
});

test('looksLikeAComponentFolderNotAJobFolder: false for a real job folder name', () => {
  assert.strictEqual(looksLikeAComponentFolderNotAJobFolder('/Users/x/Desktop/2026.09.07 186 Bachman Drive_Swan Si'), false);
});

test('looksLikeAComponentFolderNotAJobFolder: false for a nested raw subfolder (only checks the final segment)', () => {
  assert.strictEqual(looksLikeAComponentFolderNotAJobFolder('/Users/x/Some Job/0 RAW/1 Raws'), false);
});

// ---- planPush (pure) ----

test('planPush: a brand-new local file (never synced) is uploaded, no conflict', () => {
  const local = [{ relativePath: 'a.jpg', size: 10, mtimeMs: 1 }];
  const { toUpload, conflicts } = planPush(local, [], {});
  assert.strictEqual(toUpload.length, 1);
  assert.strictEqual(conflicts.length, 0);
});

test('planPush: unchanged-on-both-sides file is left alone', () => {
  const local = [{ relativePath: 'a.jpg', size: 10, mtimeMs: 1 }];
  const remote = [{ relativePath: 'a.jpg', size: 10, rev: 'r1' }];
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toUpload, toDeleteRemote, conflicts } = planPush(local, remote, manifest);
  assert.deepStrictEqual(toUpload, []);
  assert.deepStrictEqual(toDeleteRemote, []);
  assert.deepStrictEqual(conflicts, []);
});

test('planPush: local-only change is safely uploaded', () => {
  const local = [{ relativePath: 'a.jpg', size: 20, mtimeMs: 2 }]; // changed since manifest
  const remote = [{ relativePath: 'a.jpg', size: 10, rev: 'r1' }]; // unchanged since manifest
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toUpload, conflicts } = planPush(local, remote, manifest);
  assert.strictEqual(toUpload.length, 1);
  assert.strictEqual(conflicts.length, 0);
});

test('planPush: changed on BOTH sides since last sync -> conflict, not uploaded', () => {
  const local = [{ relativePath: 'a.jpg', size: 20, mtimeMs: 2 }];
  const remote = [{ relativePath: 'a.jpg', size: 30, rev: 'r2' }]; // rev changed from manifest's r1
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toUpload, conflicts } = planPush(local, remote, manifest);
  assert.deepStrictEqual(toUpload, []);
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].relativePath, 'a.jpg');
});

test('planPush: remote-only change (local untouched) is left alone -- nothing to push', () => {
  const local = [{ relativePath: 'a.jpg', size: 10, mtimeMs: 1 }]; // unchanged
  const remote = [{ relativePath: 'a.jpg', size: 999, rev: 'r2' }]; // changed on Dropbox
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toUpload, conflicts } = planPush(local, remote, manifest);
  assert.deepStrictEqual(toUpload, []);
  assert.deepStrictEqual(conflicts, []);
});

test('planPush: local deletion mirrors to a Dropbox deletion when remote is unchanged', () => {
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const remote = [{ relativePath: 'a.jpg', size: 10, rev: 'r1' }];
  const { toDeleteRemote, conflicts } = planPush([], remote, manifest);
  assert.deepStrictEqual(toDeleteRemote, ['a.jpg']);
  assert.deepStrictEqual(conflicts, []);
});

test('planPush: local deletion vs. a Dropbox-side edit is a conflict, not a delete', () => {
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const remote = [{ relativePath: 'a.jpg', size: 999, rev: 'r2' }]; // someone edited it on Dropbox after local deleted it
  const { toDeleteRemote, conflicts } = planPush([], remote, manifest);
  assert.deepStrictEqual(toDeleteRemote, []);
  assert.strictEqual(conflicts.length, 1);
  assert.ok(conflicts[0].reason.includes('Deleted locally'));
});

test('planPush: deleted on both sides already -- stale manifest entry, no-op', () => {
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toDeleteRemote, conflicts } = planPush([], [], manifest);
  assert.deepStrictEqual(toDeleteRemote, []);
  assert.deepStrictEqual(conflicts, []);
});

// ---- planPull (mirror of planPush) ----

test('planPull: a brand-new remote file is downloaded, no conflict', () => {
  const remote = [{ relativePath: 'a.jpg', size: 10, rev: 'r1' }];
  const { toDownload, conflicts } = planPull(remote, [], {});
  assert.strictEqual(toDownload.length, 1);
  assert.strictEqual(conflicts.length, 0);
});

test('planPull: remote-only change is safely downloaded', () => {
  const remote = [{ relativePath: 'a.jpg', size: 999, rev: 'r2' }];
  const local = [{ relativePath: 'a.jpg', size: 10, mtimeMs: 1 }]; // unchanged since manifest
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toDownload, conflicts } = planPull(remote, local, manifest);
  assert.strictEqual(toDownload.length, 1);
  assert.strictEqual(conflicts.length, 0);
});

test('planPull: changed on BOTH sides -> conflict, not downloaded', () => {
  const remote = [{ relativePath: 'a.jpg', size: 999, rev: 'r2' }];
  const local = [{ relativePath: 'a.jpg', size: 20, mtimeMs: 2 }]; // also changed locally
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const { toDownload, conflicts } = planPull(remote, local, manifest);
  assert.deepStrictEqual(toDownload, []);
  assert.strictEqual(conflicts.length, 1);
});

test('planPull: Dropbox deletion mirrors to a local deletion when local is unchanged', () => {
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const local = [{ relativePath: 'a.jpg', size: 10, mtimeMs: 1 }];
  const { toDeleteLocal, conflicts } = planPull([], local, manifest);
  assert.deepStrictEqual(toDeleteLocal, ['a.jpg']);
  assert.deepStrictEqual(conflicts, []);
});

test('planPull: Dropbox deletion vs. a local edit is a conflict, not a delete', () => {
  const manifest = { 'a.jpg': { local: { size: 10, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 10 } } };
  const local = [{ relativePath: 'a.jpg', size: 999, mtimeMs: 2 }]; // edited locally after Dropbox side was deleted
  const { toDeleteLocal, conflicts } = planPull([], local, manifest);
  assert.deepStrictEqual(toDeleteLocal, []);
  assert.strictEqual(conflicts.length, 1);
  assert.ok(conflicts[0].reason.includes('Deleted on Dropbox'));
});

// ---- uploadFile / downloadFile with fake clients ----

async function runAsyncTests() {

await testAsync('uploadFile: small file goes through a single filesUpload call, returns rev', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'small.jpg');
    fs.writeFileSync(filePath, Buffer.alloc(10));
    const fakeDbx = {
      filesUpload: async (arg) => { await consumeStream(arg.contents); return { result: { rev: 'r1', size: 10 } }; },
    };
    const entry = { relativePath: 'small.jpg', absolutePath: filePath, size: 10, mtimeMs: Date.now() };
    const result = await uploadFile(fakeDbx, entry, '/Job/small.jpg', { singleShotMaxBytes: 1000, chunkSize: 100 });
    assert.deepStrictEqual(result, { rev: 'r1', size: 10 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('uploadFile: large file goes through start -> append -> finish, returns finish rev', async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'big.mp4');
    fs.writeFileSync(filePath, Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXY')); // 25 bytes
    const calls = [];
    const fakeDbx = {
      filesUploadSessionStart: async (arg) => { calls.push(['start', arg.contents.toString()]); return { result: { session_id: 'sess-1' } }; },
      filesUploadSessionAppendV2: async (arg) => { calls.push(['append', arg.cursor.offset, arg.contents.toString()]); },
      filesUploadSessionFinish: async (arg) => { calls.push(['finish', arg.cursor.offset, arg.contents.toString()]); return { result: { rev: 'r-final', size: 25 } }; },
    };
    const entry = { relativePath: 'big.mp4', absolutePath: filePath, size: 25, mtimeMs: Date.now() };
    const result = await uploadFile(fakeDbx, entry, '/Job/big.mp4', { singleShotMaxBytes: 5, chunkSize: 10 });
    assert.deepStrictEqual(calls, [
      ['start', 'ABCDEFGHIJ'],
      ['append', 10, 'KLMNOPQRST'],
      ['finish', 20, 'UVWXY'],
    ]);
    assert.deepStrictEqual(result, { rev: 'r-final', size: 25 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('downloadFile: creates parent directories and calls the injected download implementation', async () => {
  const dir = makeTmpDir();
  try {
    const localPath = path.join(dir, 'nested', 'deep', 'photo.jpg');
    const calls = [];
    const fakeDownload = async (dbx, dropboxPath, dest) => {
      calls.push([dropboxPath, dest]);
      fs.writeFileSync(dest, 'downloaded content');
    };
    await downloadFile({}, '/Job/nested/deep/photo.jpg', localPath, fakeDownload);
    assert.deepStrictEqual(calls, [['/Job/nested/deep/photo.jpg', localPath]]);
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'downloaded content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- pushJobFilesToDropbox / pullJobFilesFromDropbox (full integration) ----

function withFakeDropboxEnv(fn) {
  const saved = {
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN,
    DROPBOX_TEMPLATE_ID: process.env.DROPBOX_TEMPLATE_ID,
  };
  process.env.DROPBOX_APP_KEY = 'fake';
  process.env.DROPBOX_APP_SECRET = 'fake';
  process.env.DROPBOX_REFRESH_TOKEN = 'fake';
  process.env.DROPBOX_TEMPLATE_ID = 'fake';
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function makeFakeDbx({ remoteFiles, onUpload, onDelete }) {
  const files = remoteFiles || []; // { relativePath, size, rev }
  return {
    filesListFolder: async ({ path: p }) => {
      const prefix = p + '/';
      return { result: { has_more: false, entries: files.map((f) => ({ '.tag': 'file', path_display: prefix + f.relativePath, size: f.size, rev: f.rev })) } };
    },
    filesListFolderContinue: async () => ({ result: { has_more: false, entries: [] } }),
    filesUpload: async (arg) => { await consumeStream(arg.contents); return onUpload ? onUpload(arg) : { result: { rev: 'r-new', size: 1 } }; },
    filesDeleteV2: async (arg) => { if (onDelete) onDelete(arg); return { result: {} }; },
  };
}

await testAsync('pushJobFilesToDropbox: skips cleanly when Dropbox is not configured', async () => {
  const dir = makeTmpDir();
  try {
    const saved = process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_KEY;
    try {
      const result = await pushJobFilesToDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'Job' });
      assert.strictEqual(result.attempted, false);
      assert.strictEqual(result.skipped, true);
    } finally {
      if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pushJobFilesToDropbox: refuses a component-subfolder path instead of silently pushing to the wrong Dropbox location', async () => {
  await withFakeDropboxEnv(async () => {
    const uploaded = [];
    const fakeDbx = makeFakeDbx({ remoteFiles: [], onUpload: (arg) => { uploaded.push(arg.path); return { result: { rev: 'r1', size: 1 } }; } });
    const result = await pushJobFilesToDropbox({ jobFolderPath: '/Users/x/Some Job/0 RAW', dropboxJobFolderName: '0 RAW', client: fakeDbx });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('subfolders'));
    assert.strictEqual(uploaded.length, 0); // never even tried
  });
});

await testAsync('pullJobFilesFromDropbox: refuses a component-subfolder path instead of silently pulling into the wrong local location', async () => {
  await withFakeDropboxEnv(async () => {
    const fakeDbx = makeFakeDbx({ remoteFiles: [{ relativePath: 'x.jpg', size: 1, rev: 'r1' }] });
    const result = await pullJobFilesFromDropbox({ jobFolderPath: '/Users/x/Some Job/MLS', dropboxJobFolderName: 'MLS', client: fakeDbx });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('subfolders'));
  });
});

await testAsync('pushJobFilesToDropbox: uploads a new file end-to-end and records both-side manifest state', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'hello');
    const fakeDbx = makeFakeDbx({ remoteFiles: [], onUpload: () => ({ result: { rev: 'r1', size: 5 } }) });

    await withFakeDropboxEnv(async () => {
      const result = await pushJobFilesToDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.uploadedCount, 1);
      assert.strictEqual(result.conflicts.length, 0);
    });

    const manifest = readManifest(dir);
    assert.deepStrictEqual(manifest['a.jpg'].dropbox, { rev: 'r1', size: 5 });
    assert.ok(manifest['a.jpg'].local);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pushJobFilesToDropbox: reports a conflict instead of overwriting, and does not touch the manifest for it', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'changed locally');
    writeManifest(dir, { 'a.jpg': { local: { size: 3, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 3 } } }); // stale baseline
    const fakeDbx = makeFakeDbx({ remoteFiles: [{ relativePath: 'a.jpg', size: 999, rev: 'r2' }] }); // Dropbox side also changed

    await withFakeDropboxEnv(async () => {
      const result = await pushJobFilesToDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx });
      assert.strictEqual(result.uploadedCount, 0);
      assert.strictEqual(result.conflicts.length, 1);
      assert.strictEqual(result.conflicts[0].relativePath, 'a.jpg');
      assert.strictEqual(result.success, true); // a conflict is not a failure
    });

    const manifest = readManifest(dir);
    assert.deepStrictEqual(manifest['a.jpg'].dropbox, { rev: 'r1', size: 3 }); // untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pushJobFilesToDropbox: mirrors a local deletion to Dropbox', async () => {
  const dir = makeTmpDir();
  try {
    writeManifest(dir, { 'a.jpg': { local: { size: 3, mtimeMs: 1 }, dropbox: { rev: 'r1', size: 3 } } });
    const deletedPaths = [];
    const fakeDbx = makeFakeDbx({ remoteFiles: [{ relativePath: 'a.jpg', size: 3, rev: 'r1' }], onDelete: (arg) => deletedPaths.push(arg.path) });

    await withFakeDropboxEnv(async () => {
      const result = await pushJobFilesToDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx });
      assert.strictEqual(result.deletedCount, 1);
    });

    assert.deepStrictEqual(deletedPaths, ['/MyJob/a.jpg']);
    assert.strictEqual(readManifest(dir)['a.jpg'], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pushJobFilesToDropbox: never uploads job.json or Job Info.txt, even alongside real content', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'real content');
    fs.writeFileSync(path.join(dir, 'job.json'), '{"jobId":"FVS-1"}');
    fs.writeFileSync(path.join(dir, 'Job Info.txt'), 'FranVision Job Info');
    const uploadedPaths = [];
    const fakeDbx = makeFakeDbx({ remoteFiles: [], onUpload: (arg) => { uploadedPaths.push(arg.path); return { result: { rev: 'r1', size: 1 } }; } });

    await withFakeDropboxEnv(async () => {
      const result = await pushJobFilesToDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx });
      assert.strictEqual(result.uploadedCount, 1); // only a.jpg
    });

    assert.deepStrictEqual(uploadedPaths, ['/MyJob/a.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pullJobFilesFromDropbox: skips cleanly when Dropbox is not configured', async () => {
  const dir = makeTmpDir();
  try {
    const saved = process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_KEY;
    try {
      const result = await pullJobFilesFromDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'Job' });
      assert.strictEqual(result.skipped, true);
    } finally {
      if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pullJobFilesFromDropbox: downloads a new remote file end-to-end', async () => {
  const dir = makeTmpDir();
  try {
    const fakeDbx = makeFakeDbx({ remoteFiles: [{ relativePath: '0 RAW/a.jpg', size: 7, rev: 'r1' }] });
    const fakeDownload = async (dbx, dropboxPath, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'content');
    };

    await withFakeDropboxEnv(async () => {
      const result = await pullJobFilesFromDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx, downloadImpl: fakeDownload });
      assert.strictEqual(result.downloadedCount, 1);
      assert.strictEqual(result.conflicts.length, 0);
    });

    assert.ok(fs.existsSync(path.join(dir, '0 RAW', 'a.jpg')));
    const manifest = readManifest(dir);
    assert.strictEqual(manifest['0 RAW/a.jpg'].dropbox.rev, 'r1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pullJobFilesFromDropbox: never pulls "MLS for download" -- Dropbox-only derived Photo Sync Worker renders', async () => {
  const dir = makeTmpDir();
  try {
    const fakeDbx = makeFakeDbx({
      remoteFiles: [
        { relativePath: 'MLS/a.jpg', size: 7, rev: 'r1' },
        { relativePath: 'MLS for download/a.jpg', size: 7, rev: 'r2' },
      ],
    });
    const fakeDownload = async (dbx, dropboxPath, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'content');
    };

    await withFakeDropboxEnv(async () => {
      const result = await pullJobFilesFromDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx, downloadImpl: fakeDownload });
      assert.strictEqual(result.downloadedCount, 1); // only MLS/a.jpg
    });

    assert.ok(fs.existsSync(path.join(dir, 'MLS', 'a.jpg')));
    assert.ok(!fs.existsSync(path.join(dir, 'MLS for download')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pullJobFilesFromDropbox: mirrors a Dropbox-side deletion to local', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'hi');
    writeManifest(dir, { 'a.jpg': { local: { size: 2, mtimeMs: fs.statSync(path.join(dir, 'a.jpg')).mtimeMs }, dropbox: { rev: 'r1', size: 2 } } });
    const fakeDbx = makeFakeDbx({ remoteFiles: [] }); // gone from Dropbox

    await withFakeDropboxEnv(async () => {
      const result = await pullJobFilesFromDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx });
      assert.strictEqual(result.deletedCount, 1);
    });

    assert.ok(!fs.existsSync(path.join(dir, 'a.jpg')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('pullJobFilesFromDropbox: a single failed download does not abort the rest of the batch', async () => {
  const dir = makeTmpDir();
  try {
    const fakeDbx = makeFakeDbx({ remoteFiles: [
      { relativePath: 'good.jpg', size: 1, rev: 'r1' },
      { relativePath: 'bad.jpg', size: 1, rev: 'r2' },
    ] });
    const fakeDownload = async (dbx, dropboxPath, dest) => {
      if (dropboxPath.includes('bad.jpg')) throw new Error('network blip');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'ok');
    };

    await withFakeDropboxEnv(async () => {
      const result = await pullJobFilesFromDropbox({ jobFolderPath: dir, dropboxJobFolderName: 'MyJob', client: fakeDbx, downloadImpl: fakeDownload });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.downloadedCount, 1);
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.failed[0].relativePath, 'bad.jpg');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

}

runAsyncTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
});
