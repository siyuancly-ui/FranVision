// Run with: node dropbox-sync.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner (same
// pattern as sanitize.test.js etc).
//
// These tests never touch the real Dropbox API: the pure helpers
// (expandFolderPaths, error classifiers) need no network at all, and
// syncJobFolderToDropbox is exercised by monkey-patching getClient() to
// return a fake client object instead of a real Dropbox instance.

const assert = require('assert');
const dropboxSync = require('./dropbox-sync.js');
const folderBuilder = require('./folder-builder.js');
const {
  expandFolderPaths,
  extractDropboxErrorMessage,
  isFolderAlreadyExistsError,
  isPropertyGroupAlreadyExistsError,
  isConfigured,
  syncJobFolderToDropbox,
  updateJobFoldersOnDropbox,
} = dropboxSync;

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

// ---- expandFolderPaths ----

test('expandFolderPaths: includes the top-level folder alone', () => {
  assert.deepStrictEqual(expandFolderPaths('2026.08.27 Addr_Client', []), ['2026.08.27 Addr_Client']);
});

test('expandFolderPaths: fills in intermediate directories Dropbox needs', () => {
  const result = expandFolderPaths('Job', ['0 RAW/1 Raws', '0 RAW/4 Raw HDR', 'HDR Photos']);
  // '0 RAW' itself must appear even though folder-builder.js never lists it
  // as its own entry -- Dropbox's create_folder doesn't make parents for you.
  assert.deepStrictEqual(result, ['Job', 'Job/0 RAW', 'Job/HDR Photos', 'Job/0 RAW/1 Raws', 'Job/0 RAW/4 Raw HDR']);
});

test('expandFolderPaths: de-duplicates a shared intermediate directory', () => {
  const result = expandFolderPaths('Job', ['0 RAW/1 Raws', '0 RAW/2 Video', '0 RAW/3 Image']);
  assert.strictEqual(result.filter((p) => p === 'Job/0 RAW').length, 1);
});

test('expandFolderPaths: orders shallowest-first (parents before children)', () => {
  const result = expandFolderPaths('Job', ['0 RAW/1 Raws']);
  assert.ok(result.indexOf('Job') < result.indexOf('Job/0 RAW'));
  assert.ok(result.indexOf('Job/0 RAW') < result.indexOf('Job/0 RAW/1 Raws'));
});

// Regression test for a real Windows bug (2026-09-11): server.js used to
// derive componentFolders by round-tripping folder-builder.js's OWN
// output through path.join()/path.relative() (to create the local
// folders, then convert the resulting ABSOLUTE paths back to relative
// ones) instead of just calling folder-builder.js#getComponentFolders()
// directly. path.join()/path.relative() use the HOST OS's native
// separator -- '\' on Windows -- so on Windows, componentFolders came out
// as e.g. "0 RAW\1 Raws" instead of "0 RAW/1 Raws". expandFolderPaths()
// here splits on '/' only, so that string never split at all: Dropbox
// would get a single oddly-named folder ("0 RAW\1 Raws", literal
// backslash in the name) directly under the job folder instead of a
// proper "0 RAW" parent containing "1 Raws" -- meaning "0 RAW" itself
// never got created. Single-segment folders (Revisions, MLS, ...) were
// unaffected, which is why only "0 RAW" looked missing to the user.
// This test feeds expandFolderPaths folder-builder.js's REAL output
// (never anything derived via path.join/path.relative) to prove the
// integration between the two modules stays correct -- and to catch it
// immediately if that boundary is ever reintroduced.
test('expandFolderPaths: integrates correctly with folder-builder.js\'s real output (regression -- Windows "0 RAW" missing bug)', () => {
  const order = { propertyType: 'house', photography: 'luxury', addons: { walkthrough_video: true } };
  const componentFolders = folderBuilder.getComponentFolders(order);
  assert.ok(componentFolders.every((p) => !p.includes('\\')), 'getComponentFolders() must never contain a backslash');

  const result = expandFolderPaths('Job', componentFolders);
  assert.ok(result.includes('Job/0 RAW'), '"0 RAW" parent folder must be its own entry, not just embedded in a longer un-split string');
  assert.ok(result.includes('Job/0 RAW/1 Raws'));
  assert.ok(result.includes('Job/0 RAW/4 Raw HDR'));
  assert.ok(result.every((p) => !p.includes('\\')), 'no entry should ever contain a literal backslash');
});

// ---- error classification ----

test('extractDropboxErrorMessage: reads error_summary off a Dropbox API error', () => {
  const err = { error: { error_summary: 'path/conflict/folder/...', error: {} } };
  assert.strictEqual(extractDropboxErrorMessage(err), 'path/conflict/folder/...');
});

test('extractDropboxErrorMessage: falls back to .message for a network error', () => {
  const err = new Error('fetch failed');
  assert.strictEqual(extractDropboxErrorMessage(err), 'fetch failed');
});

test('extractDropboxErrorMessage: never throws on garbage input', () => {
  assert.strictEqual(extractDropboxErrorMessage(null), 'Unknown error');
  assert.strictEqual(extractDropboxErrorMessage(undefined), 'Unknown error');
  assert.doesNotThrow(() => extractDropboxErrorMessage({}));
});

test('isFolderAlreadyExistsError: true on a path/conflict/folder error', () => {
  const err = { error: { error_summary: 'path/conflict/folder/....' } };
  assert.strictEqual(isFolderAlreadyExistsError(err), true);
});

test('isFolderAlreadyExistsError: false on an unrelated error', () => {
  const err = { error: { error_summary: 'path/not_found/....' } };
  assert.strictEqual(isFolderAlreadyExistsError(err), false);
});

test('isPropertyGroupAlreadyExistsError: true when already tagged', () => {
  const err = { error: { error_summary: 'path/property_group_already_exists/...' } };
  assert.strictEqual(isPropertyGroupAlreadyExistsError(err), true);
});

// ---- isConfigured ----

test('isConfigured: false when credentials are missing', () => {
  const saved = {
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN,
    DROPBOX_TEMPLATE_ID: process.env.DROPBOX_TEMPLATE_ID,
  };
  delete process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_SECRET;
  delete process.env.DROPBOX_REFRESH_TOKEN;
  delete process.env.DROPBOX_TEMPLATE_ID;
  try {
    assert.strictEqual(isConfigured(), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ---- syncJobFolderToDropbox, with a fake client (no real network) ----
//
// syncJobFolderToDropbox accepts an injectable `client` param specifically
// so these tests never touch the real Dropbox API or need real credentials.

async function withFakeCredentials(fn) {
  const savedEnv = {
    DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY,
    DROPBOX_APP_SECRET: process.env.DROPBOX_APP_SECRET,
    DROPBOX_REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN,
    DROPBOX_TEMPLATE_ID: process.env.DROPBOX_TEMPLATE_ID,
  };
  // isConfigured() checks env vars directly, so fake them too -- the
  // "not configured" case is covered by its own test below instead.
  process.env.DROPBOX_APP_KEY = 'fake';
  process.env.DROPBOX_APP_SECRET = 'fake';
  process.env.DROPBOX_REFRESH_TOKEN = 'fake';
  process.env.DROPBOX_TEMPLATE_ID = 'fake-template-id';
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function runAsyncTests() {

await testAsync('syncJobFolderToDropbox: skips cleanly when not configured', async () => {
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: [], jobId: 'FVS-20260827-001' });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.skipped, true);
  } finally {
    if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
  }
});

await testAsync('syncJobFolderToDropbox: success path creates folders and tags them', async () => {
  const created = [];
  const tagged = [];
  const fakeDbx = {
    filesCreateFolderV2: async ({ path }) => { created.push(path); return { result: {} }; },
    filePropertiesPropertiesAdd: async (arg) => { tagged.push(arg); return { result: null }; },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({
      folderName: 'Job', componentFolders: ['0 RAW/1 Raws', 'HDR Photos'], jobId: 'FVS-20260827-001', client: fakeDbx,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.propertiesTagged, true);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(created.sort(), ['/Job', '/Job/0 RAW', '/Job/0 RAW/1 Raws', '/Job/HDR Photos'].sort());
    assert.strictEqual(tagged.length, 1);
    assert.strictEqual(tagged[0].path, '/Job');
    assert.strictEqual(tagged[0].property_groups[0].fields[0].value, 'FVS-20260827-001');
  });
});

await testAsync('syncJobFolderToDropbox: treats "already exists" as success, not failure', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => {
      const err = new Error('conflict');
      err.error = { error_summary: 'path/conflict/folder/...' };
      throw err;
    },
    filePropertiesPropertiesAdd: async () => {
      const err = new Error('already tagged');
      err.error = { error_summary: 'path/property_group_already_exists/...' };
      throw err;
    },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: ['HDR Photos'], jobId: 'FVS-1', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.propertiesTagged, true);
  });
});

await testAsync('syncJobFolderToDropbox: a real folder-creation failure never throws, comes back as success:false', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async ({ path }) => {
      if (path === '/Job') {
        const err = new Error('nope');
        err.error = { error_summary: 'path/insufficient_space/...' };
        throw err;
      }
      return { result: {} };
    },
    filePropertiesPropertiesAdd: async () => { throw new Error('should not be called'); },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: [], jobId: 'FVS-1', client: fakeDbx });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.attempted, true);
    assert.ok(result.error.indexOf('top-level Dropbox folder') !== -1);
  });
});

await testAsync('syncJobFolderToDropbox: a property-tag failure never throws, comes back as success:false', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => ({ result: {} }),
    filePropertiesPropertiesAdd: async () => {
      const err = new Error('nope');
      err.error = { error_summary: 'template_error/...' };
      throw err;
    },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: [], jobId: 'FVS-1', client: fakeDbx });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.propertiesTagged, false);
    assert.ok(result.error.indexOf('tagging') !== -1);
  });
});

await testAsync('syncJobFolderToDropbox: jobId: null (a Save-Draft\'d job) creates folders but skips tagging, and that alone is still success', async () => {
  const created = [];
  const fakeDbx = {
    filesCreateFolderV2: async ({ path }) => { created.push(path); return { result: {} }; },
    filePropertiesPropertiesAdd: async () => { throw new Error('should not be called -- nothing to tag yet'); },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: ['HDR Photos'], jobId: null, client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.propertiesTagged, false);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(created.sort(), ['/Job', '/Job/HDR Photos']);
  });
});

await testAsync('syncJobFolderToDropbox: promoting a draft to a real Job ID tags it on the very next call', async () => {
  const tagged = [];
  const fakeDbx = {
    filesCreateFolderV2: async () => ({ result: {} }), // already exists from the earlier draft save
    filePropertiesPropertiesAdd: async (arg) => { tagged.push(arg); return { result: null }; },
  };
  await withFakeCredentials(async () => {
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: [], jobId: 'FVS-20260913-001', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.propertiesTagged, true);
    assert.strictEqual(tagged[0].property_groups[0].fields[0].value, 'FVS-20260913-001');
  });
});

await testAsync('updateJobFoldersOnDropbox: skips cleanly when not configured', async () => {
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    const result = await updateJobFoldersOnDropbox({ folderName: 'Job', foldersToCreate: [], foldersToPrune: [] });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.skipped, true);
  } finally {
    if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
  }
});

await testAsync('updateJobFoldersOnDropbox: creates new folders and prunes only the EMPTY no-longer-wanted ones', async () => {
  const created = [];
  const deleted = [];
  const fakeDbx = {
    filesCreateFolderV2: async ({ path }) => { created.push(path); return { result: {} }; },
    filesListFolder: async ({ path }) => ({
      // "Video" still has a file on Dropbox -> must be kept; "Floorplan" is empty -> pruned.
      result: { entries: path.endsWith('/Video') ? [{ name: 'walk.mp4' }] : [] },
    }),
    filesDeleteV2: async ({ path }) => { deleted.push(path); return { result: {} }; },
  };
  await withFakeCredentials(async () => {
    const result = await updateJobFoldersOnDropbox({
      folderName: 'Job', client: fakeDbx,
      foldersToCreate: ['Feature Sheets'],
      foldersToPrune: ['Video', 'Floorplan'],
    });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(created, ['/Job/Feature Sheets']);
    assert.deepStrictEqual(deleted, ['/Job/Floorplan']);
    assert.deepStrictEqual(result.foldersRemoved, ['/Job/Floorplan']);
    assert.deepStrictEqual(result.foldersKeptWithFiles, ['/Job/Video']);
  });
});

await testAsync('updateJobFoldersOnDropbox: a path_not_found on prune is not an error', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => ({ result: {} }),
    filesListFolder: async () => { const e = new Error('x'); e.error = { error_summary: 'path/not_found/..' }; throw e; },
    filesDeleteV2: async () => ({ result: {} }),
  };
  await withFakeCredentials(async () => {
    const result = await updateJobFoldersOnDropbox({ folderName: 'Job', client: fakeDbx, foldersToCreate: [], foldersToPrune: ['Gone'] });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.foldersRemoved, []);
  });
});

await testAsync('updateJobFoldersOnDropbox: never throws -- a real failure comes back as success:false', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => { const e = new Error('boom'); e.error = { error_summary: 'internal_error/..' }; throw e; },
    filesListFolder: async () => ({ result: { entries: [] } }),
    filesDeleteV2: async () => ({ result: {} }),
  };
  await withFakeCredentials(async () => {
    const result = await updateJobFoldersOnDropbox({ folderName: 'Job', client: fakeDbx, foldersToCreate: ['HDR Photos'], foldersToPrune: [] });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length >= 1);
  });
});

// ---- ensureMlsForDownloadFolder (delivery-email.js's link source) ----

await testAsync('ensureMlsForDownloadFolder: skips cleanly when not configured', async () => {
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    const result = await dropboxSync.ensureMlsForDownloadFolder({ folderName: 'Job' });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.skipped, true);
  } finally {
    if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
  }
});

await testAsync('ensureMlsForDownloadFolder: creates the top-level "MLS for download" folder', async () => {
  const created = [];
  const fakeDbx = { filesCreateFolderV2: async ({ path }) => { created.push(path); return { result: {} }; } };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.ensureMlsForDownloadFolder({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(created, ['/Job/MLS for download']);
  });
});

await testAsync('ensureMlsForDownloadFolder: already-exists is success, not an error', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => { const e = new Error('x'); e.error = { error_summary: 'path/conflict/folder/..' }; throw e; },
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.ensureMlsForDownloadFolder({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, true);
  });
});

await testAsync('ensureMlsForDownloadFolder: never throws -- a real failure comes back as success:false', async () => {
  const fakeDbx = {
    filesCreateFolderV2: async () => { const e = new Error('boom'); e.error = { error_summary: 'internal_error/..' }; throw e; },
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.ensureMlsForDownloadFolder({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });
});

// ---- createSharedLink (delivery-email.js's per-line link resolver) ----

await testAsync('createSharedLink: fails cleanly when not configured', async () => {
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    const result = await dropboxSync.createSharedLink({ dropboxPath: '/Job/HDR Photos' });
    assert.strictEqual(result.success, false);
  } finally {
    if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
  }
});

await testAsync('createSharedLink: creates a fresh link', async () => {
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async ({ path }) => ({ result: { url: 'https://dropbox.com/fake' + path } }),
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.createSharedLink({ dropboxPath: '/Job/HDR Photos', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.url, 'https://dropbox.com/fake/Job/HDR Photos');
  });
});

await testAsync('createSharedLink: reuses an existing link instead of erroring', async () => {
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async () => { const e = new Error('x'); e.error = { error_summary: 'shared_link_already_exists/..' }; throw e; },
    sharingListSharedLinks: async () => ({ result: { links: [{ url: 'https://dropbox.com/existing' }] } }),
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.createSharedLink({ dropboxPath: '/Job/HDR Photos', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.url, 'https://dropbox.com/existing');
  });
});

await testAsync('createSharedLink: never throws -- a real failure comes back as success:false', async () => {
  const fakeDbx = {
    sharingCreateSharedLinkWithSettings: async () => { const e = new Error('boom'); e.error = { error_summary: 'internal_error/..' }; throw e; },
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.createSharedLink({ dropboxPath: '/Job/HDR Photos', client: fakeDbx });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });
});

// ---- deleteJobFolderFromDropbox (deleting a Save-Draft'd job the user
// decided not to go ahead with, 2026-09-13) ----

await testAsync('deleteJobFolderFromDropbox: skips cleanly when not configured', async () => {
  const saved = process.env.DROPBOX_APP_KEY;
  delete process.env.DROPBOX_APP_KEY;
  try {
    const result = await dropboxSync.deleteJobFolderFromDropbox({ folderName: 'Job' });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.skipped, true);
  } finally {
    if (saved !== undefined) process.env.DROPBOX_APP_KEY = saved;
  }
});

await testAsync('deleteJobFolderFromDropbox: deletes the whole top-level folder', async () => {
  const deleted = [];
  const fakeDbx = { filesDeleteV2: async ({ path }) => { deleted.push(path); return { result: {} }; } };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.deleteJobFolderFromDropbox({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(deleted, ['/Job']);
  });
});

await testAsync('deleteJobFolderFromDropbox: already-gone (path_not_found) is success, not an error', async () => {
  const fakeDbx = {
    filesDeleteV2: async () => { const e = new Error('x'); e.error = { error_summary: 'path_lookup/not_found/..' }; throw e; },
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.deleteJobFolderFromDropbox({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, true);
  });
});

await testAsync('deleteJobFolderFromDropbox: never throws -- a real failure comes back as success:false', async () => {
  const fakeDbx = {
    filesDeleteV2: async () => { const e = new Error('boom'); e.error = { error_summary: 'internal_error/..' }; throw e; },
  };
  await withFakeCredentials(async () => {
    const result = await dropboxSync.deleteJobFolderFromDropbox({ folderName: 'Job', client: fakeDbx });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });
});

}

runAsyncTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
});
