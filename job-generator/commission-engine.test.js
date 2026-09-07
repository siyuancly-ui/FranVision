// Run with: node commission-engine.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner (same
// pattern as sanitize.test.js etc). Uses its own tiny fake config rather
// than the real commission-config.js, so these tests don't break if the
// real rates or photographer roster change later.

const assert = require('assert');
const {
  normalizePhotographerName,
  getDefaultCommissionItemIds,
  getRateTable,
  computeCommission,
} = require('./commission-engine.js');

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

const FAKE_CONFIG = {
  defaultRates: { photography: 5000, video: 5000, matterport_3d: 5000, drone: 3000, floor_tour: 1000 },
  photographers: {
    franky: { exempt: true },
    jenny: { rates: { drone: 4000 } }, // Jenny gets a higher drone rate, everything else default
  },
};

// ---- normalizePhotographerName ----

test('normalizePhotographerName: trims and lowercases', () => {
  assert.strictEqual(normalizePhotographerName('  Franky  '), 'franky');
  assert.strictEqual(normalizePhotographerName('FRANKY'), 'franky');
});

test('normalizePhotographerName: handles null/undefined', () => {
  assert.strictEqual(normalizePhotographerName(null), '');
  assert.strictEqual(normalizePhotographerName(undefined), '');
});

// ---- getDefaultCommissionItemIds ----

test('getDefaultCommissionItemIds: photography alone by default', () => {
  const order = { propertyType: 'condo', photography: 'standard', addons: {} };
  assert.deepStrictEqual(getDefaultCommissionItemIds(order), ['photography']);
});

test('getDefaultCommissionItemIds: video counted once whether Walkthrough, Vlog, or both are selected', () => {
  const onlyWalkthrough = { addons: { walkthrough_video: true } };
  const onlyVlog = { addons: { vlog_video: true } };
  const both = { addons: { walkthrough_video: true, vlog_video: true } };
  assert.deepStrictEqual(getDefaultCommissionItemIds(onlyWalkthrough), ['photography', 'video']);
  assert.deepStrictEqual(getDefaultCommissionItemIds(onlyVlog), ['photography', 'video']);
  assert.deepStrictEqual(getDefaultCommissionItemIds(both), ['photography', 'video']);
});

test('getDefaultCommissionItemIds: floor_tour from either Floor Plan or Site Plan', () => {
  assert.deepStrictEqual(getDefaultCommissionItemIds({ addons: { floor_plan: true } }), ['photography', 'floor_tour']);
  assert.deepStrictEqual(getDefaultCommissionItemIds({ addons: { site_plan: true } }), ['photography', 'floor_tour']);
});

test('getDefaultCommissionItemIds: everything selected at once', () => {
  const order = { addons: { walkthrough_video: true, three_d_tour: true, drone_photos: true, floor_plan: true } };
  assert.deepStrictEqual(getDefaultCommissionItemIds(order), ['photography', 'video', 'matterport_3d', 'drone', 'floor_tour']);
});

test('getDefaultCommissionItemIds: never includes "travel" -- it is always manual', () => {
  const order = { addons: { walkthrough_video: true, three_d_tour: true, drone_photos: true, floor_plan: true } };
  assert.ok(getDefaultCommissionItemIds(order).indexOf('travel') === -1);
});

// ---- getRateTable ----

test('getRateTable: exempt photographer (Franky) short-circuits to exempt', () => {
  const { exempt } = getRateTable('Franky', FAKE_CONFIG);
  assert.strictEqual(exempt, true);
});

test('getRateTable: unlisted photographer falls back to defaultRates untouched', () => {
  const { exempt, rates } = getRateTable('Some New Contractor', FAKE_CONFIG);
  assert.strictEqual(exempt, false);
  assert.deepStrictEqual(rates, FAKE_CONFIG.defaultRates);
});

test('getRateTable: a photographer with a partial override merges over defaults', () => {
  const { exempt, rates } = getRateTable('Jenny', FAKE_CONFIG);
  assert.strictEqual(exempt, false);
  assert.strictEqual(rates.drone, 4000); // overridden
  assert.strictEqual(rates.photography, 5000); // inherited from defaults
});

// ---- computeCommission ----

test('computeCommission: exempt photographer -> everything forced to $0, no items', () => {
  const order = { addons: { drone_photos: true, floor_plan: true } };
  const result = computeCommission({
    photographerName: 'Franky', order, checkedItemIds: ['drone', 'floor_tour'], travelCents: 5000, config: FAKE_CONFIG,
  });
  assert.strictEqual(result.exempt, true);
  assert.strictEqual(result.totalCents, 0);
  assert.strictEqual(result.travelCents, 0);
  assert.ok(result.allItems.every((i) => i.amountCents === 0 && i.checked === false));
});

test('computeCommission: matches the worked example from the spec (Photography+Drone+Floor Tour+Travel = $110)', () => {
  const order = { addons: { drone_photos: true, floor_plan: true } };
  const result = computeCommission({
    photographerName: 'Some Contractor',
    order,
    checkedItemIds: ['photography', 'drone', 'floor_tour'],
    travelCents: 2000,
    config: FAKE_CONFIG,
  });
  assert.strictEqual(result.exempt, false);
  assert.strictEqual(result.totalCents, 11000); // 5000 + 3000 + 1000 + 2000
});

test('computeCommission: falls back to computed defaults when checkedItemIds is omitted', () => {
  const order = { addons: { three_d_tour: true } };
  const result = computeCommission({ photographerName: 'Some Contractor', order, travelCents: 0, config: FAKE_CONFIG });
  const checkedIds = result.allItems.filter((i) => i.checked).map((i) => i.id);
  assert.deepStrictEqual(checkedIds.sort(), ['matterport_3d', 'photography'].sort());
});

test('computeCommission: user can uncheck an auto-derived item (manual override)', () => {
  const order = { addons: { drone_photos: true } };
  const result = computeCommission({
    photographerName: 'Some Contractor', order, checkedItemIds: ['photography'], travelCents: 0, config: FAKE_CONFIG,
  });
  const drone = result.allItems.find((i) => i.id === 'drone');
  assert.strictEqual(drone.checked, false); // drone_photos was selected on the order, but the user unchecked its commission line
  assert.strictEqual(result.totalCents, 5000); // only Photography
});

test('computeCommission: user can check an item the order does not imply', () => {
  const order = { addons: {} };
  const result = computeCommission({
    photographerName: 'Some Contractor', order, checkedItemIds: ['photography', 'drone'], travelCents: 0, config: FAKE_CONFIG,
  });
  assert.strictEqual(result.totalCents, 8000); // Photography + Drone, even though drone_photos was never on the order
});

test('computeCommission: rate override actually changes the total (Jenny\'s higher drone rate)', () => {
  const order = { addons: { drone_photos: true } };
  const result = computeCommission({
    photographerName: 'Jenny', order, checkedItemIds: ['photography', 'drone'], travelCents: 0, config: FAKE_CONFIG,
  });
  assert.strictEqual(result.totalCents, 9000); // 5000 photography + 4000 (Jenny's overridden drone rate, not the default 3000)
});

test('computeCommission: travelCents is always additive and independent of the rate table', () => {
  const order = { addons: {} };
  const result = computeCommission({
    photographerName: 'Some Contractor', order, checkedItemIds: [], travelCents: 1234, config: FAKE_CONFIG,
  });
  assert.strictEqual(result.travelCents, 1234);
  assert.strictEqual(result.totalCents, 1234);
});

test('computeCommission: non-integer/garbage travelCents is sanitized to an integer', () => {
  const order = { addons: {} };
  const result = computeCommission({
    photographerName: 'Some Contractor', order, checkedItemIds: [], travelCents: '20.6', config: FAKE_CONFIG,
  });
  assert.strictEqual(result.travelCents, 21);
});

test('computeCommission: amounts are always integer cents', () => {
  const order = { addons: { drone_photos: true } };
  const result = computeCommission({
    photographerName: 'Some Contractor', order, checkedItemIds: ['photography', 'drone'], travelCents: 500, config: FAKE_CONFIG,
  });
  assert.strictEqual(Number.isInteger(result.totalCents), true);
  result.allItems.forEach((i) => assert.strictEqual(Number.isInteger(i.amountCents), true));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
