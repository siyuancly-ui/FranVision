// Run with: node folder-builder.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getComponentFolders, createJobFolders } = require('./folder-builder.js');

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
  assert.deepStrictEqual(sortedSet(getComponentFolders(order)), sortedSet(['0 RAW/1 Raws', 'Revisions', 'Home Report', 'MLS']));
});

test('Luxury photography: adds Raw HDR + top-level Twilight', () => {
  const order = { propertyType: 'condo', photography: 'luxury', addons: {} };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('0 RAW/4 Raw HDR'));
  assert.ok(folders.includes('Twilight'));
  assert.ok(!folders.includes('0 RAW/Twilight'), 'Twilight must be top-level, not nested under 0 RAW');
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

test('3D Virtual Tour selected: 3D Tour folder, no raw subfolder anywhere', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { three_d_tour: true } };
  const folders = getComponentFolders(order);
  assert.ok(folders.includes('3D Tour'));
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
  assert.deepStrictEqual(sortedSet(folders), sortedSet(['0 RAW/1 Raws', 'Revisions', 'Home Report', 'MLS']));
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
    'Twilight', 'Revisions', 'Home Report', 'MLS', 'Floorplan',
    '3D Tour', 'Virtual Staging', 'Feature Sheets', 'Video', 'VLOG',
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
    const order = { propertyType: 'condo', photography: 'luxury', addons: { walkthrough_video: true, floor_plan: true } };
    const created = createJobFolders(jobFolder, order);

    assert.ok(fs.existsSync(jobFolder) && fs.statSync(jobFolder).isDirectory());
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '1 Raws')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '4 Raw HDR')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '2 Video')));
    assert.ok(fs.existsSync(path.join(jobFolder, '0 RAW', '3 Image')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Twilight')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Revisions')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'Home Report')));
    assert.ok(fs.existsSync(path.join(jobFolder, 'MLS')));
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
