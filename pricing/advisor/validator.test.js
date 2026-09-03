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

test('checkStatic: hard-error / non-error cases', () => {
  const cases = [
    {
      label: 'duplicate service id',
      queued: [],
      candidate: { type: 'newService', service: { id: 'floor_plan', displayName: 'Dup', standaloneAllowed: false } },
      expectCode: 'duplicate_id',
    },
    {
      label: 'package references an unknown service id',
      queued: [],
      candidate: { type: 'newPackage', package: { id: 'ghost_pkg', displayName: 'Ghost', includes: ['luxury_photo', 'nope'], priceCents: 10000 } },
      expectCode: 'dangling_reference',
    },
    {
      label: 'standalone-allowed service missing a price',
      queued: [],
      candidate: { type: 'newService', service: { id: 'x', displayName: 'X', standaloneAllowed: true } },
      expectCode: 'missing_pricing',
    },
    {
      label: 'same includes, same (unrestricted) property types, different price -- conflict',
      queued: [{ type: 'newPackage', package: { id: 'a', displayName: 'A', includes: ['luxury_photo', 'vlog_video'], priceCents: 10000 } }],
      candidate: { type: 'newPackage', package: { id: 'b', displayName: 'B', includes: ['vlog_video', 'luxury_photo'], priceCents: 20000 } },
      expectCode: 'package_conflict',
    },
    {
      label: 'same includes, condo-only vs house-only, different price -- NOT a conflict (that\'s how a combo gets two prices)',
      queued: [{ type: 'newPackage', package: { id: 'combo_condo', displayName: 'Combo (condo)', includes: ['luxury_photo', 'drone_photos'], priceCents: 20000, eligiblePropertyTypes: ['condo'] } }],
      candidate: { type: 'newPackage', package: { id: 'combo_house', displayName: 'Combo (house)', includes: ['luxury_photo', 'drone_photos'], priceCents: 23000, eligiblePropertyTypes: ['house'] } },
      expectCode: null,
    },
    {
      label: 'a new package referencing a same-batch new service is NOT a dangling reference',
      queued: [{ type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', standaloneAllowed: false } }],
      candidate: { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } },
      expectCode: null,
    },
  ];
  cases.forEach((c) => {
    const errors = advisor.checkStatic(config, c.queued, c.candidate);
    if (c.expectCode) {
      assert.ok(errors.some((e) => e.code === c.expectCode), c.label + ' -- expected code "' + c.expectCode + '", got ' + JSON.stringify(errors));
    } else {
      assert.deepStrictEqual(errors, [], c.label);
    }
  });
});

test('runFullCheck: the Home Tour example, only Luxury covered, correctly flags every Standard combo as new_invalid', () => {
  const changes = [
    { type: 'newService', service: { id: 'home_tour', displayName: 'Home Tour', category: 'addon', standaloneAllowed: false, restrictionMessage: 'Home Tour is only available as part of a package.' } },
    { type: 'newPackage', package: { id: 'luxury_hometour', displayName: 'Luxury Photos + Home Tour', includes: ['luxury_photo', 'home_tour'], priceCents: 25000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  assert.ok(r.hardErrors.length > 0);
  assert.ok(r.hardErrors.every((e) => e.code === 'new_invalid'));
  // Home Tour is the one thing broken in every case: alone on the Standard tier (no
  // package covers it there at all), or paired with Walkthrough Video on the Luxury
  // tier -- the "two standaloneAllowed:false services competing for one photo slot"
  // conflict covered explicitly in the next test, so it's expected to show up here too.
  assert.ok(r.hardErrors.every((e) => e.message.includes('Home Tour')));
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
  assert.ok(r.hardErrors.every((e) => e.code === 'new_invalid'));
  // Walkthrough Video is pre-existing (not part of this batch), so per the "only blame what
  // this batch actually introduced" rule its restriction message is deliberately left out of
  // the reason text -- only Home Tour (the new, genuinely-added-by-this-batch culprit) is named.
  // The conflict is still correctly caught as invalid; the message just doesn't spell out that
  // it's specifically the pairing with Walkthrough Video that triggers it.
  assert.ok(r.hardErrors.every((e) => e.message.includes('Home Tour')));
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

test('runFullCheck: warning cases (computable, but worth a human look)', () => {
  const cases = [
    {
      label: 'a superset package priced below a subset package',
      changes: [{ type: 'newPackage', package: { id: 'super_pkg', displayName: 'Super Bundle', includes: ['standard_photo', 'floor_plan', 'drone_photos'], priceCents: 10000 } }],
      expectCode: 'subset_inversion',
    },
    {
      label: 'a Luxury package priced at or below its Standard equivalent',
      changes: [
        { type: 'newPackage', package: { id: 'luxury_drone_pkg', displayName: 'Luxury + Drone', includes: ['luxury_photo', 'drone_photos'], priceCents: 5000 } },
        { type: 'newPackage', package: { id: 'standard_drone_pkg', displayName: 'Standard + Drone', includes: ['standard_photo', 'drone_photos'], priceCents: 10000 } },
      ],
      expectCode: 'luxury_not_pricier',
    },
    {
      label: 'a discount package that makes the total drop when it applies on top of an order',
      changes: [{ type: 'newPackage', package: { id: 'weird_discount', displayName: 'Weird Discount', includes: ['standard_photo', 'feature_sheets'], priceCents: 5000 } }],
      expectCode: 'non_monotonic',
    },
  ];
  cases.forEach((c) => {
    const r = advisor.runFullCheck(config, c.changes);
    assert.ok(r.warnings.some((w) => w.code === c.expectCode), c.label + ' -- expected a "' + c.expectCode + '" warning, got ' + JSON.stringify(r.warnings));
  });
});

test('runFullCheck: non_monotonic warnings are capped and sorted biggest-drop-first', () => {
  // Two separate discount packages that undercut different base orders by very
  // different amounts -- the $60 feature_sheets base drops a lot more (bigger
  // dollar gap) than the $50 drone_photos base does.
  const changes = [
    { type: 'newPackage', package: { id: 'big_discount', displayName: 'Big Discount', includes: ['standard_photo', 'feature_sheets'], priceCents: 100 } },
    { type: 'newPackage', package: { id: 'small_discount', displayName: 'Small Discount', includes: ['standard_photo', 'drone_photos'], priceCents: 14000 } },
  ];
  const r = advisor.runFullCheck(config, changes);
  const hits = r.warnings.filter((w) => w.code === 'non_monotonic');
  assert.ok(hits.length <= 5, 'expected at most 5 non_monotonic warnings, got ' + hits.length);
  assert.ok(hits.length > 0);
  // The biggest-drop case (the near-free Big Discount package) should be the one reported.
  assert.ok(hits[0].message.includes('Feature Sheets'), 'expected the worst offender first, got: ' + hits[0].message);
});

test('suggestRequires: cases', () => {
  const cases = [
    {
      label: 'a bundle-only service appearing in 2+ packages always alongside the same companion is suggested',
      changes: [
        { type: 'newService', service: { id: 'home_report', displayName: 'Home Report', category: 'addon', standaloneAllowed: false } },
        { type: 'newPackage', package: { id: 'floorplan_homereport', displayName: 'Floor Plan + Home Report', includes: ['floor_plan', 'home_report'], priceCents: 6600 } },
        { type: 'newPackage', package: { id: 'luxury_floorplan_homereport', displayName: 'Luxury + Floor Plan + Home Report', includes: ['luxury_photo', 'floor_plan', 'home_report'], priceCents: 25000 } },
      ],
      assertion: (suggestions) => {
        const forHomeReport = suggestions.find((s) => s.id === 'home_report');
        assert.ok(forHomeReport, 'expected a suggestion for home_report');
        assert.deepStrictEqual(forHomeReport.requires, ['floor_plan']);
      },
    },
    {
      label: 'no suggestion when the service only appears in one package so far (not enough evidence)',
      changes: [
        { type: 'newService', service: { id: 'home_report', displayName: 'Home Report', category: 'addon', standaloneAllowed: false } },
        { type: 'newPackage', package: { id: 'floorplan_homereport', displayName: 'Floor Plan + Home Report', includes: ['floor_plan', 'home_report'], priceCents: 6600 } },
      ],
      assertion: (suggestions) => assert.ok(!suggestions.some((s) => s.id === 'home_report')),
    },
    {
      label: 'existing Site Plan (already has requires) is not re-suggested',
      changes: [],
      assertion: (suggestions) => assert.ok(!suggestions.some((s) => s.id === 'site_plan')),
    },
  ];
  cases.forEach((c) => {
    const draft = advisor.applyChanges(config, c.changes);
    const suggestions = advisor.suggestRequires(draft);
    try {
      c.assertion(suggestions);
    } catch (err) {
      err.message = c.label + ' -- ' + err.message;
      throw err;
    }
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
