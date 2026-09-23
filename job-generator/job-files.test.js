// Run with: node job-files.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildJobInfoText, buildJobJson, writeJobFiles, computePendingConfirmation } = require('./job-files.js');
const { calculatePrice } = require('./pricing-adapter.js');
const { computeCommission } = require('./commission-engine.js');

const FAKE_COMMISSION_CONFIG = {
  defaultRates: { photography: 5000, video: 5000, matterport_3d: 5000, drone: 3000, floor_tour: 1000 },
  photographers: { franky: { exempt: true } },
};

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
    componentFolders: ['0 RAW/1 Raws', 'HDR Photos', 'Video'],
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

test('flags a failed Dropbox sync', () => {
  const jobData = makeJobData({ dropboxResult: { attempted: true, success: false, error: 'network error' } });
  const pending = computePendingConfirmation(jobData);
  assert.strictEqual(pending.length, 1);
  assert.ok(pending[0].includes('Dropbox sync did not complete'));
  assert.ok(pending[0].includes('network error'));
});

test('does NOT flag a successful Dropbox sync', () => {
  const jobData = makeJobData({ dropboxResult: { attempted: true, success: true } });
  assert.deepStrictEqual(computePendingConfirmation(jobData), []);
});

test('does NOT flag anything when Dropbox sync was never attempted (dropboxResult undefined)', () => {
  const jobData = makeJobData();
  assert.deepStrictEqual(computePendingConfirmation(jobData), []);
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

test('buildJobJson carries the Dropbox sync result for later retry', () => {
  const dropboxResult = { attempted: true, success: false, error: 'network error' };
  const json = buildJobJson(makeJobData({ dropboxResult }));
  assert.deepStrictEqual(json.dropbox, dropboxResult);
});

// ---- Photographer Commission (commission-engine.js integration) ----

test('buildJobJson: photographer is a flat string, not a nested object', () => {
  const json = buildJobJson(makeJobData({ photographerName: 'Jane Contractor' }));
  assert.strictEqual(json.photographer, 'Jane Contractor');
});

test('buildJobJson: commission defaults to the all-zero shape when never computed', () => {
  const json = buildJobJson(makeJobData());
  assert.deepStrictEqual(json.commission, { items: [], travel_cents: 0, total_cents: 0 });
});

test('buildJobJson: exempt photographer (Franky) -> empty items, $0 total, even if checked items were passed in', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { drone_photos: true } };
  const commission = computeCommission({
    photographerName: 'Franky', order, checkedItemIds: ['photography', 'drone'], travelCents: 5000, config: FAKE_COMMISSION_CONFIG,
  });
  const json = buildJobJson(makeJobData({ order, photographerName: 'Franky', commission }));
  assert.deepStrictEqual(json.commission, { items: [], travel_cents: 0, total_cents: 0 });
});

test('buildJobJson: non-exempt photographer -> items array matches checked items, cents are integers', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { drone_photos: true, floor_plan: true } };
  const commission = computeCommission({
    photographerName: 'Jane Contractor', order, checkedItemIds: ['photography', 'drone', 'floor_tour'], travelCents: 2000, config: FAKE_COMMISSION_CONFIG,
  });
  const json = buildJobJson(makeJobData({ order, photographerName: 'Jane Contractor', commission }));
  assert.strictEqual(json.commission.items.length, 3);
  assert.strictEqual(json.commission.travel_cents, 2000);
  assert.strictEqual(json.commission.total_cents, 11000); // 5000 + 3000 + 1000 + 2000
  assert.ok(json.commission.items.every((i) => Number.isInteger(i.amountCents)));
});

test('buildJobInfoText: includes a Commission Breakdown section with Travel and Total Commission', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: { drone_photos: true, floor_plan: true } };
  const commission = computeCommission({
    photographerName: 'Jane Contractor', order, checkedItemIds: ['photography', 'drone', 'floor_tour'], travelCents: 2000, config: FAKE_COMMISSION_CONFIG,
  });
  const text = buildJobInfoText(makeJobData({ order, photographerName: 'Jane Contractor', commission }));
  assert.ok(text.includes('Commission Breakdown:'));
  assert.ok(text.includes('Travel'));
  assert.ok(text.includes('Total Commission'));
  assert.ok(text.includes('$110.00'));
});

test('buildJobInfoText: shows the exempt note for Franky instead of a breakdown', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: {} };
  const commission = computeCommission({ photographerName: 'Franky', order, checkedItemIds: ['photography'], travelCents: 0, config: FAKE_COMMISSION_CONFIG });
  const text = buildJobInfoText(makeJobData({ order, photographerName: 'Franky', commission }));
  assert.ok(text.includes('commission-exempt'));
  assert.ok(!text.includes('Total Commission'));
});

test('buildJobInfoText: notes commission was not calculated when Photographer is unset', () => {
  const text = buildJobInfoText(makeJobData({ photographerName: '' }));
  assert.ok(text.includes('not calculated'));
});

test('buildJobJson stores dropbox: null when sync was never attempted', () => {
  const json = buildJobJson(makeJobData());
  assert.strictEqual(json.dropbox, null);
});

test('buildJobJson: updatedAt defaults to createdAt, and is carried through on an update', () => {
  const created = buildJobJson(makeJobData());
  assert.strictEqual(created.updatedAt, created.createdAt);

  const updated = buildJobJson(makeJobData({ updatedAt: '2026-09-10T12:00:00.000Z' }));
  assert.strictEqual(updated.createdAt, '2026-08-27T16:17:48.447Z');
  assert.strictEqual(updated.updatedAt, '2026-09-10T12:00:00.000Z');
});

test('buildJobJson: completedAt defaults to null, and is carried through (never set by this build path itself)', () => {
  assert.strictEqual(buildJobJson(makeJobData()).completedAt, null);
  assert.strictEqual(buildJobJson(makeJobData({ completedAt: '2026-09-22T00:00:00.000Z' })).completedAt, '2026-09-22T00:00:00.000Z');
});

test('buildJobInfoText: shows an "Updated:" line only when updatedAt differs from createdAt', () => {
  assert.ok(!buildJobInfoText(makeJobData()).includes('Updated:'));
  const text = buildJobInfoText(makeJobData({ updatedAt: '2026-09-10T12:00:00.000Z' }));
  assert.ok(text.includes('Updated: 2026-09-10T12:00:00.000Z'));
});

// Shoot Notes text/images and the generated calendar file (calendar-file.js)
// are deliberately NOT part of job.json/Job Info.txt -- see job-files.js's
// jobData jsdoc and calendar-file.js's module comment.
test('buildJobJson/buildJobInfoText: never mention notes, images, or the calendar file', () => {
  const json = buildJobJson(makeJobData());
  assert.strictEqual(json.notes, undefined);
  assert.strictEqual(json.shootNotesImages, undefined);
  assert.strictEqual(json.calendar, undefined);
  const text = buildJobInfoText(makeJobData());
  assert.ok(!text.includes('Shoot Notes:'));
  assert.ok(!text.includes('Shoot Info'));
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
