// Run with: node folder-builder.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getComponentFolders, createJobFolders, diffComponentFolders, folderHasRealFiles } = require('./folder-builder.js');

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

function sortedSet(arr) {
  return [...new Set(arr)].sort();
}

// ---- pure logic ----

test('Standard photography, no add-ons: baseline four folders only', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: {} };
  assert.deepStrictEqual(sortedSet(getComponentFolders(order)), sortedSet(['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos']));
});

test('Luxury photography: adds Raw HDR, no dedicated Twilight folder (removed 2026-09-06)', () => {
  const order = { propertyType: 'condo', photography: 'luxury', addons: {} };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('0 RAW/4 Raw HDR'));
  assert.ok(!folders.some((f) => /twilight/i.test(f)));
});

test('Walkthrough Video: raw Video+Image folders plus finished Video, no VLOG', () => {
  const order = { propertyType: 'house', photography: 'standard', addons: { walkthrough_video: true } };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('0 RAW/2 Video'));
  assert.ok(folders.includes('0 RAW/3 Image'));
  assert.ok(folders.includes('Video'));
  assert.ok(!folders.includes('VLOG'));
});

test('Vlog Video: raw Video+Image folders plus finished VLOG, no Video', () => {
  const order = { propertyType: 'house', photography: 'luxury', addons: { vlog_video: true } };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('0 RAW/2 Video'));
  assert.ok(folders.includes('0 RAW/3 Image'));
  assert.ok(folders.includes('VLOG'));
  assert.ok(!folders.includes('Video'));
});

test('Both Walkthrough and Vlog selected: shared raw folders, both finished folders', () => {
  const order = { propertyType: 'house', photography: 'luxury', addons: { walkthrough_video: true, vlog_video: true } };
  const folders = getComponentFolders(order);
  // raw Video/Image should not be duplicated
  assert.strictEqual(folders.filter((f) => f === '0 RAW/2 Video').length, 1);
  assert.strictEqual(folders.filter((f) => f === '0 RAW/3 Image').length, 1);
  assert.ok(folders.includes('Video'));
  assert.ok(folders.includes('VLOG'));
});

test('Floor Plan selected: Floorplan folder only', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { floor_plan: true } };
  assert.ok(getComponentFolders(order).includes('Floorplan'));
});

test('Site Plan selected (without floor_plan flag): still produces Floorplan, no separate Site Plan folder', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { site_plan: true } };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('Floorplan'));
  assert.ok(!folders.some((f) => /site plan/i.test(f)));
});

test('3D Virtual Tour selected: no dedicated folder (removed 2026-09-06) -- still just the baseline four', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { three_d_tour: true } };
  const folders = getComponentFolders(order);
  assert.ok(!folders.some((f) => /3d/i.test(f)));
  assert.deepStrictEqual(sortedSet(folders), sortedSet(['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos']));
});

test('Virtual Staging: checkbox alone with qty 0 still creates the folder (photo count often unknown yet -- intentional)', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { virtual_staging: true, virtual_staging_qty: 0 } };
  assert.ok(getComponentFolders(order).includes('Virtual Staging'));
});

test('Virtual Staging: qty > 0 creates the folder regardless of the checkbox flag', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { virtual_staging_qty: 5 } };
  assert.ok(getComponentFolders(order).includes('Virtual Staging'));
});

test('Feature Sheets selected: Feature Sheets folder', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { feature_sheets: true } };
  assert.ok(getComponentFolders(order).includes('Feature Sheets'));
});

test('Drone Photos selected: no dedicated folder at all', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { drone_photos: true } };
  const folders = getComponentFolders(order);
  assert.deepStrictEqual(sortedSet(folders), sortedSet(['0 RAW/1 Raws', 'Revisions', 'Local Report', 'HDR Photos']));
});

test('Everything selected at once: full folder set, each exactly once', () => {
  const order = {
    propertyType: 'house',
    photography: 'luxury',
    addons: {
      floor_plan: true,
      site_plan: true,
      walkthrough_video: true,
      vlog_video: true,
      drone_photos: true,
      three_d_tour: true,
      virtual_staging: true,
      virtual_staging_qty: 3,
      feature_sheets: true,
    },
  };
  const folders = getComponentFolders(order);
  const expected = [
    '0 RAW/1 Raws', '0 RAW/4 Raw HDR', '0 RAW/2 Video', '0 RAW/3 Image',
    'Revisions', 'Local Report', 'HDR Photos', 'Floorplan',
    'Virtual Staging', 'Feature Sheets', 'Video', 'VLOG',
  ];
  assert.deepStrictEqual(sortedSet(folders), sortedSet(expected));
  // no duplicates
  assert.strictEqual(folders.length, new Set(folders).size);
});

// ---- fs layer ----

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-jobgen-test-'));
}

test('createJobFolders actually creates the job folder and every component folder on disk', () => {
  const root = makeTmpDir();
  try {
    const jobFolder = path.join(root, '2026.08.27 12 Cozens Dr_Jane Smith');
    const order = { propertyType: 'condo', photography: 'luxury', addons: { walkthrough_video: true, floor_plan: true, three_d_tour: true } };
    const created = createJobFolders(jobFolder, order);

    assert.ok(fs.existsSync(jobFolder) && fs.statSync(jobFolder).isDirectory());
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '1 Raws')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '4 Raw HDR')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '2 Video')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '3 Image')));
    assert.ok(!fs.existsSync(path.join(jobFolder, 'Twilight')));
    assert.ok(!fs.existsSync(path.join(jobFolder, '3D Tour')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Revisions')));
    assert.ok(!fs.existsSync(path.join(jobFolder, 'Home Report')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Local Report')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'HDR Photos')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Floorplan')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Video')));
    assert.ok(!fs.existsSync(path.join(jobFolder, 'VLOG')));
    assert.strictEqual(created[0], jobFolder);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createJobFolders is idempotent -- re-running on an existing job folder does not throw and tops up new selections', () => {
  const root = makeTmpDir();
  try {
    const jobFolder = path.join(root, 'Job');
    createJobFolders(jobFolder, { propertyType: 'condo', photography: 'standard', addons: {} });
    assert.ok(!fs.existsSync(path.join(jobFolder, 'Floorplan')));

    createJobFolders(jobFolder, { propertyType: 'condo', photography: 'standard', addons: { floor_plan: true } });
    assert.ok(fs.existsSync(path.join(jobFolder, 'Floorplan')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '1 Raws'))); // still there
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- diffComponentFolders ----

test('diffComponentFolders: adding Floor Plan -> Floorplan in toCreate, nothing removed', () => {
  const before = { photography: 'standard', addons: {} };
  const after = { photography: 'standard', addons: { floor_plan: true } };
  const diff = diffComponentFolders(after, before);
  assert.deepStrictEqual(diff.toCreate, ['Floorplan']);
  assert.deepStrictEqual(diff.toRemove, []);
});

test('diffComponentFolders: dropping Walkthrough while keeping Vlog removes only the finished Video folder', () => {
  const before = { photography: 'standard', addons: { walkthrough_video: true, vlog_video: true } };
  const after = { photography: 'standard', addons: { vlog_video: true } };
  const diff = diffComponentFolders(after, before);
  // '0 RAW/2 Video' and '0 RAW/3 Image' are shared by both videos -> kept.
  assert.deepStrictEqual(diff.toCreate, []);
  assert.deepStrictEqual(diff.toRemove, ['Video']);
});

test('diffComponentFolders: dropping Luxury removes 0 RAW/4 Raw HDR but never 0 RAW itself', () => {
  const before = { photography: 'luxury', addons: {} };
  const after = { photography: 'standard', addons: {} };
  const diff = diffComponentFolders(after, before);
  assert.deepStrictEqual(diff.toRemove, ['0 RAW/4 Raw HDR']);
  assert.ok(!diff.toRemove.includes('0 RAW'));
});

test('diffComponentFolders: toRemove is deepest-path-first', () => {
  const before = { photography: 'standard', addons: { walkthrough_video: true } };
  const after = { photography: 'standard', addons: {} };
  const diff = diffComponentFolders(after, before);
  // '0 RAW/2 Video' / '0 RAW/3 Image' (depth 2) must come before 'Video' (depth 1).
  const depths = diff.toRemove.map((p) => p.split('/').length);
  assert.deepStrictEqual(depths.slice().sort((a, b) => b - a), depths);
});

test('diffComponentFolders: identical orders -> empty diff', () => {
  const order = { photography: 'luxury', addons: { floor_plan: true, feature_sheets: true } };
  const diff = diffComponentFolders(order, order);
  assert.deepStrictEqual(diff, { toCreate: [], toRemove: [] });
});

// ---- folderHasRealFiles ----

test('folderHasRealFiles: false for a missing dir, an empty dir, and a dir with only .DS_Store', () => {
  const root = makeTmpDir();
  try {
    assert.strictEqual(folderHasRealFiles(path.join(root, 'nope')), false);
    fs.mkdirSync(path.join(root, 'empty'));
    assert.strictEqual(folderHasRealFiles(path.join(root, 'empty')), false);
    fs.mkdirSync(path.join(root, 'cruft'));
    fs.writeFileSync(path.join(root, 'cruft', '.DS_Store'), 'junk');
    fs.writeFileSync(path.join(root, 'cruft', '.dropbox-sync-manifest.json'), '{}');
    fs.writeFileSync(path.join(root, 'cruft', '~$draft.docx'), 'lock');
    assert.strictEqual(folderHasRealFiles(path.join(root, 'cruft')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folderHasRealFiles: true for a real file, including one nested deep', () => {
  const root = makeTmpDir();
  try {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'DSC_0001.jpg'), 'photo');
    assert.strictEqual(folderHasRealFiles(path.join(root, 'a')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
