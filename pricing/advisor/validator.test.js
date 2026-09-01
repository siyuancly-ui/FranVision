// Run with: node pricing/advisor/validator.test.js
const assert = require('assert');
const advisor = require('./validator.js');
const config = require('../pricing-config.js');

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

console.log('FranVision pricing advisor tests\n');

test('Sanity: the real current price list has zero hard errors and zero warnings on its own', () => {
  const r = advisor.runFullCheck(config, []);
  assert.deepStrictEqual(r.hardErrors, []);
  assert.deepStrictEqual(r.warnings, []);
  assert.ok(r.combosChecked > 0);
});

test('checkStatic: duplicate service id is a hard error', () => {
  const candidate = { type: 'newService', service: { id: 'floor_plan', displayName: 'Dup', standaloneAllowed: false } };
  const errors = advisor.checkStatic(config, [], candidate);
  assert.ok(errors.some((e) => e.code === 'duplicate_id'));
});

test('checkStatic: package referencing an unknown service id is a hard error', () => {
  const candidate = { type: 'newPackage', package: { id: 'ghost_pkg', displayName: 'Ghost', includes: ['luxury_photo', 'nope'], priceCents: 10000 } };
  const errors = advisor.checkStatic(config, [], candidate);
  assert.ok(errors.some((e) => e.code === 'dangling_reference'));
});

test('checkStatic: standalone-allowed service missing a price is a hard error', () => {
  const candidate = { type: 'newService', service: { id: 'x', displayName: 'X', standaloneAllowed: true } };
  const errors = advisor.checkStatic(config, [], candidate);
  assert.ok(errors.some((e) => e.code === 'missing_pricing'));
});

test('checkStatic: two packages with the same includes set but different prices conflict', () => {
  const queued = [{ type: 'newPackage', package: { id: 'a', displayName: 'A', includes: ['luxury_photo', 'vlog_video'], priceCents: 10000 } }];
  const candidate = { type: 'newPackage', package: { id: 'b', displayName: 'B', includes: ['vlog_video', 'luxury_photo'], priceCents: 20000 } };
  const errors = advisor.checkStatic(config, queued, candidate);
  assert.ok(errors.some((e) => e.code === 'package_conflict'));
});

test('checkStatic: a brand-new service referenced by a same-batch package is NOT a dangling reference', () => {
  const queued = [{ type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', standaloneAllowed: false } }];
  const candidate = { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } };
  const errors = advisor.checkStatic(config, queued, candidate);
  assert.deepStrictEqual(errors, []);
});

test('runFullCheck: the Home Tour example, only Luxury covered, correctly flags every Standard combo as new_invalid', () => {
  const changes = [
    { type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', category: 'addon', standaloneAllowed: false, restrictionMessage: 'Home Tour is only available as part of a package.' } },
    { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury Photos + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.hardErrors.length > 0);
  assert.ok(r.hardErrors.every((e) => e.code === 'new_invalid'));
  // Standard-tier combos are always broken (no package covers home_tour there at all).
  // Luxury-tier combos are fine UNLESS walkthrough_video is also selected -- that's the
  // same "two standaloneAllowed:false services competing for one photo slot" conflict
  // covered explicitly in the next test, so it's expected to show up here too.
  assert.ok(r.hardErrors.every((e) => e.message.includes('standard/') || e.message.includes('walkthrough_video')));
});

test('runFullCheck: both tiers covered, and the new service has a standalone fallback price, is clean end to end', () => {
  // home_tour is standaloneAllowed here (unlike the test above), so if it ever loses the
  // "standard_photo slot" fight to the existing standard_walkthrough package, it still has
  // a standalone price to fall back on -- same reason Floor Plan coexists fine with
  // Walkthrough Video today (see engine.test.js "Extra: two non-overlapping packages...").
  const changes = [
    { type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', category: 'addon', standaloneAllowed: true, pricing: { type: 'flat', amountCents: 5000 } } },
    { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury Photos + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } },
    { type: 'newPackage', package: { id: 'standard_hometour', displayName: 'Standard Photos + Home Tour', includes: ['standard_photo', 'home_tour'], priceCents: 18000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.deepStrictEqual(r.hardErrors, []);
});

test('runFullCheck: two standalone-disallowed services both wanting the same photo slot correctly surfaces the real conflict', () => {
  // Both Home Tour (new) and Walkthrough Video (existing) are standaloneAllowed:false, and for
  // whichever tier is chosen, both their packages need that tier's photo id -- a package can't
  // double-cover a service id, so an order wanting BOTH together genuinely can't be priced no
  // matter which package "wins" (same shape of conflict at both tiers: luxury_walkthrough vs
  // luxury_hometour, and standard_walkthrough vs standard_hometour).
  const changes = [
    { type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', category: 'addon', standaloneAllowed: false, restrictionMessage: 'Home Tour is only available as part of a package.' } },
    { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury Photos + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } },
    { type: 'newPackage', package: { id: 'standard_hometour', displayName: 'Standard Photos + Home Tour', includes: ['standard_photo', 'home_tour'], priceCents: 18000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.hardErrors.length > 0);
  // Every flagged combo should be one that selected walkthrough_video and home_tour together.
  assert.ok(r.hardErrors.every((e) => e.code === 'new_invalid'));
  assert.ok(r.hardErrors.every((e) => e.message.includes('walkthrough_video') && e.message.includes('home_tour')));
});

test('runFullCheck: a standalone-disallowed service with NO covering package surfaces as new_invalid (not caught earlier)', () => {
  const changes = [
    { type: 'newService', service: { id: 'orphan', displayName: 'Orphan Service', category: 'addon', standaloneAllowed: false, restrictionMessage: 'Orphan is only available as part of a package.' } },
  ];
  // Confirm checkStatic alone does NOT flag this (that's the whole point of deferring to the full check).
  const staticErrors = advisor.checkStatic(config, [], changes[0]);
  assert.deepStrictEqual(staticErrors, []);

  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.hardErrors.some((e) => e.code === 'new_invalid'));
});

test('runFullCheck: a superset package priced below a subset package is a subset_inversion warning', () => {
  const changes = [
    { type: 'newPackage', package: { id: 'super_pkg', displayName: 'Super Bundle', includes: ['standard_photo', 'floor_plan', 'drone_photos'], priceCents: 10000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.warnings.some((w) => w.code === 'subset_inversion'));
});

test('runFullCheck: a Luxury package priced at or below its Standard equivalent is a luxury_not_pricier warning', () => {
  const changes = [
    { type: 'newPackage', package: { id: 'luxury_drone_pkg', displayName: 'Luxury + Drone', includes: ['luxury_photo', 'drone_photos'], priceCents: 5000 } },
    { type: 'newPackage', package: { id: 'standard_drone_pkg', displayName: 'Standard + Drone', includes: ['standard_photo', 'drone_photos'], priceCents: 10000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.warnings.some((w) => w.code === 'luxury_not_pricier'));
});

test('runFullCheck: a service priced so total drops when added is a non_monotonic warning', () => {
  const changes = [
    { type: 'editServicePrice', id: 'drone_photos', pricing: { type: 'flat', amountCents: -500 } },
  ];
  // Note: this also trips bad_price in checkStatic since -500 is negative --
  // use a different angle: a discount package that undercuts standalone Standard Photo itself.
  const altChanges = [
    { type: 'newPackage', package: { id: 'weird_discount', displayName: 'Weird Discount', includes: ['standard_photo', 'feature_sheets'], priceCents: 5000 } },
  ];
  const r = advisor.runFullCheck(config, altChanges);
  assert.ok(r.warnings.some((w) => w.code === 'non_monotonic'));
});

test('checkStatic: same includes, different eligiblePropertyTypes (condo vs house pricing) is NOT a conflict', () => {
  const queued = [{ type: 'newPackage', package: { id: 'combo_condo', displayName: 'Combo (condo)', includes: ['luxury_photo', 'drone_photos'], priceCents: 20000, eligiblePropertyTypes: ['condo'] } }];
  const candidate = { type: 'newPackage', package: { id: 'combo_house', displayName: 'Combo (house)', includes: ['luxury_photo', 'drone_photos'], priceCents: 23000, eligiblePropertyTypes: ['house'] } };
  const errors = advisor.checkStatic(config, queued, candidate);
  assert.deepStrictEqual(errors, []);
});

test('checkStatic: same includes, same (or no) eligiblePropertyTypes, different price IS still a conflict', () => {
  const queued = [{ type: 'newPackage', package: { id: 'combo_a', displayName: 'Combo A', includes: ['luxury_photo', 'drone_photos'], priceCents: 20000 } }];
  const candidate = { type: 'newPackage', package: { id: 'combo_b', displayName: 'Combo B', includes: ['drone_photos', 'luxury_photo'], priceCents: 21000 } };
  const errors = advisor.checkStatic(config, queued, candidate);
  assert.ok(errors.some((e) => e.code === 'package_conflict'));
});

test('suggestRequires: a bundle-only service appearing in 2+ packages always alongside the same companion is suggested', () => {
  const changes = [
    { type: 'newService', service: { id: 'home_report', displayName: 'Home Report', category: 'addon', standaloneAllowed: false } },
    { type: 'newPackage', package: { id: 'floorplan_homereport', displayName: 'Floor Plan + Home Report', includes: ['floor_plan', 'home_report'], priceCents: 6600 } },
    { type: 'newPackage', package: { id: 'luxury_floorplan_homereport', displayName: 'Luxury + Floor Plan + Home Report', includes: ['luxury_photo', 'floor_plan', 'home_report'], priceCents: 25000 } },
  ];
  const draft = advisor.applyChanges(config, changes);
  const suggestions = advisor.suggestRequires(draft);
  const forHomeReport = suggestions.find((s) => s.id === 'home_report');
  assert.ok(forHomeReport, 'expected a suggestion for home_report');
  assert.deepStrictEqual(forHomeReport.requires, ['floor_plan']);
});

test('suggestRequires: no suggestion when the service only appears in one package so far (not enough evidence)', () => {
  const changes = [
    { type: 'newService', service: { id: 'home_report', displayName: 'Home Report', category: 'addon', standaloneAllowed: false } },
    { type: 'newPackage', package: { id: 'floorplan_homereport', displayName: 'Floor Plan + Home Report', includes: ['floor_plan', 'home_report'], priceCents: 6600 } },
  ];
  const draft = advisor.applyChanges(config, changes);
  const suggestions = advisor.suggestRequires(draft);
  assert.ok(!suggestions.some((s) => s.id === 'home_report'));
});

test('suggestRequires: existing Site Plan (already has requires) is not re-suggested', () => {
  const suggestions = advisor.suggestRequires(config);
  assert.ok(!suggestions.some((s) => s.id === 'site_plan'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
