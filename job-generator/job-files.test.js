// Run with: node job-files.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildJobInfoText, buildJobJson, writeJobFiles, computePendingConfirmation } = require('./job-files.js');
const { calculatePrice } = require('./pricing-adapter.js');

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

function makeJobData(overrides) {
  const order = { propertyType: 'condo', photography: 'luxury', addons: { walkthrough_video: true } };
  return Object.assign({
    jobId: 'FVS-20260827-001',
    createdAt: '2026-08-27T16:17:48.447Z',
    clientName: 'Jane Smith',
    photographerName: 'Franky Chen',
    address: '12 Cozens Dr, Markham',
    propertyType: 'condo',
    shootDate: '2026/08/27',
    order,
    price: calculatePrice(order),
    folderName: '2026.08.27 12 Cozens Dr, Markham_Jane Smith',
    componentFolders: ['0 RAW/1 Raws', 'MLS', 'Video'],
  }, overrides);
}

// ---- computePendingConfirmation ----

test('nothing pending when photographer is filled and no unconfirmed virtual staging', () => {
  const jobData = makeJobData();
  assert.deepStrictEqual(computePendingConfirmation(jobData), []);
});

test('flags missing photographer name', () => {
  const jobData = makeJobData({ photographerName: '' });
  assert.deepStrictEqual(computePendingConfirmation(jobData), ['Photographer Name not filled in yet.']);
});

test('flags virtual staging checked with qty 0', () => {
  const jobData = makeJobData({
    order: { propertyType: 'condo', photography: 'standard', addons: { virtual_staging: true, virtual_staging_qty: 0 } },
  });
  const pending = computePendingConfirmation(jobData);
  assert.strictEqual(pending.length, 1);
  assert.ok(pending[0].includes('Virtual Staging'));
});

test('does NOT flag virtual staging once qty is confirmed > 0', () => {
  const jobData = makeJobData({
    order: { propertyType: 'condo', photography: 'standard', addons: { virtual_staging: true, virtual_staging_qty: 4 } },
  });
  assert.deepStrictEqual(computePendingConfirmation(jobData), []);
});

test('can flag both photographer AND virtual staging at once', () => {
  const jobData = makeJobData({
    photographerName: '  ',
    order: { propertyType: 'condo', photography: 'standard', addons: { virtual_staging: true, virtual_staging_qty: 0 } },
  });
  assert.strictEqual(computePendingConfirmation(jobData).length, 2);
});

// ---- buildJobInfoText / buildJobJson ----

test('buildJobInfoText includes a follow-up section when something is pending', () => {
  const jobData = makeJobData({ photographerName: '' });
  const text = buildJobInfoText(jobData);
  assert.ok(text.includes('Needs follow-up before invoicing'));
  assert.ok(text.includes('Photographer Name not filled in yet.'));
});

test('buildJobInfoText omits the follow-up section when nothing is pending', () => {
  const text = buildJobInfoText(makeJobData());
  assert.ok(!text.includes('Needs follow-up'));
});

test('buildJobJson carries pendingConfirmation as structured data', () => {
  const json = buildJobJson(makeJobData({ photographerName: '' }));
  assert.deepStrictEqual(json.pendingConfirmation, ['Photographer Name not filled in yet.']);
});

test('buildJobJson stores amounts as integer cents', () => {
  const json = buildJobJson(makeJobData());
  assert.strictEqual(Number.isInteger(json.pricing.totalCents), true);
});

// ---- writeJobFiles (fs) ----

test('writeJobFiles writes both files with matching jobId', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-jobfiles-test-'));
  try {
    const jobData = makeJobData();
    const { infoPath, jsonPath } = writeJobFiles(dir, jobData);
    assert.ok(fs.existsSync(infoPath));
    assert.ok(fs.existsSync(jsonPath));
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.strictEqual(json.jobId, jobData.jobId);
    assert.ok(fs.readFileSync(infoPath, 'utf8').includes(jobData.jobId));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
