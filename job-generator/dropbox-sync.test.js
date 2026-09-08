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
const {
  expandFolderPaths,
  extractDropboxErrorMessage,
  isFolderAlreadyExistsError,
  isPropertyGroupAlreadyExistsError,
  isConfigured,
  syncJobFolderToDropbox,
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
  const result = expandFolderPaths('Job', ['0 RAW/1 Raws', '0 RAW/4 Raw HDR', 'MLS']);
  // '0 RAW' itself must appear even though folder-builder.js never lists it
  // as its own entry -- Dropbox's create_folder doesn't make parents for you.
  assert.deepStrictEqual(result, ['Job', 'Job/0 RAW', 'Job/MLS', 'Job/0 RAW/1 Raws', 'Job/0 RAW/4 Raw HDR']);
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
      folderName: 'Job', componentFolders: ['0 RAW/1 Raws', 'MLS'], jobId: 'FVS-20260827-001', client: fakeDbx,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.propertiesTagged, true);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(created.sort(), ['/Job', '/Job/0 RAW', '/Job/0 RAW/1 Raws', '/Job/MLS'].sort());
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
    const result = await syncJobFolderToDropbox({ folderName: 'Job', componentFolders: ['MLS'], jobId: 'FVS-1', client: fakeDbx });
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

}

runAsyncTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
});
