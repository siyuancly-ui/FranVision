// Run with: node engine.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const { calculatePrice } = require('./engine.js');
const config = require('./pricing-config.js');

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

// Convenience: build an order with sane defaults, override what you need.
function order(overrides) {
  return Object.assign(
    {
      propertyType: 'condo',
      photography: 'standard',
      addons: {},
      manualAdjustmentCents: 0,
    },
    overrides
  );
}

function run(o) {
  return calculatePrice(o, config);
}

console.log('FranVision pricing engine tests\n');

// 1. Standard only -> $98
test('1. Standard only = $98', () => {
  const r = run(order({ photography: 'standard' }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 9800);
});

// 2. Standard + Floor Plan -> package $169, not $164
test('2. Standard + Floor Plan = package $169 (not $164)', () => {
  const r = run(order({ photography: 'standard', addons: { floor_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 16900);
  assert.strictEqual(r.lineItems.length, 1);
  assert.strictEqual(r.lineItems[0].id, 'standard_floorplan');
});

// 3. Luxury Condo only -> $169
test('3. Luxury Condo only = $169', () => {
  const r = run(order({ propertyType: 'condo', photography: 'luxury' }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 16900);
});

// 4. Luxury House only -> $199
test('4. Luxury House only = $199', () => {
  const r = run(order({ propertyType: 'house', photography: 'luxury' }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 19900);
});

// 5. Luxury Condo + Floor Plan -> package $249, not $235
test('5. Luxury Condo + Floor Plan = package $249 (not $235)', () => {
  const r = run(order({ propertyType: 'condo', photography: 'luxury', addons: { floor_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 24900);
});

// 6. Luxury House + Floor Plan -> $249
test('6. Luxury House + Floor Plan = $249', () => {
  const r = run(order({ propertyType: 'house', photography: 'luxury', addons: { floor_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 24900);
});

// 7. Vlog standalone -> $199
// (Photography is mandatory on every order. Pair Vlog with Standard, not Luxury --
// no package matches Standard+Vlog, so Vlog is priced standalone. Luxury+Vlog always
// package-matches instead, per test 8.)
test('7. Vlog standalone = $199', () => {
  const r = run(order({ photography: 'standard', addons: { vlog_video: true } }));
  const vlogLine = r.lineItems.find((li) => li.id === 'vlog_video');
  assert.ok(vlogLine, 'expected a standalone vlog_video line item');
  assert.strictEqual(vlogLine.amountCents, 19900);
});

// 8. Luxury House + Vlog -> package $399, not $398
test('8. Luxury House + Vlog = package $399 (not $398)', () => {
  const r = run(order({ propertyType: 'house', photography: 'luxury', addons: { vlog_video: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 39900);
  assert.strictEqual(r.lineItems.length, 1);
  assert.strictEqual(r.lineItems[0].id, 'luxury_vlog');
});

// 9. Luxury + Vlog + Floor Plan -> Luxury+Vlog package $399 + Floor Plan addon $66 = $465
test('9. Luxury + Vlog + Floor Plan = $399 package + $66 addon = $465', () => {
  const r = run(order({ propertyType: 'house', photography: 'luxury', addons: { vlog_video: true, floor_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 46500);
  const pkg = r.lineItems.find((li) => li.type === 'package');
  const addon = r.lineItems.find((li) => li.type === 'addon');
  assert.strictEqual(pkg.id, 'luxury_vlog');
  assert.strictEqual(pkg.amountCents, 39900);
  assert.strictEqual(addon.id, 'floor_plan');
  assert.strictEqual(addon.amountCents, 6600);
});

// 10. Floor Plan standalone -> $66
// (Floor Plan alone always merges into the Standard/Luxury+FloorPlan package by
// design -- that's tests 2/5/6. To see the standalone Floor Plan price in a line
// item, pair it with Vlog, which forces Floor Plan to be left over as an add-on.)
test('10. Floor Plan standalone = $66', () => {
  const r = run(order({ photography: 'luxury', propertyType: 'house', addons: { vlog_video: true, floor_plan: true } }));
  const addon = r.lineItems.find((li) => li.id === 'floor_plan');
  assert.strictEqual(addon.amountCents, 6600);
});

// 11. Floor Plan + Site Plan -> package $149
test('11. Floor Plan + Site Plan = package $149', () => {
  const r = run(order({ photography: 'luxury', propertyType: 'house', addons: { vlog_video: true, floor_plan: true, site_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  const pkg = r.lineItems.find((li) => li.id === 'floorplan_siteplan');
  assert.ok(pkg, 'expected the Floor Plan + Site Plan package to be applied');
  assert.strictEqual(pkg.amountCents, 14900);
});

// 12. Site Plan only -> Floor Plan auto-added, resolves via the Floor Plan + Site Plan package
test('12. Site Plan only auto-adds Floor Plan (not left invalid)', () => {
  const r = run(order({ photography: 'standard', addons: { site_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.explanation.some((n) => /auto-added/i.test(n)));
  const pkg = r.lineItems.find((li) => li.id === 'floorplan_siteplan');
  assert.ok(pkg, 'expected Floor Plan + Site Plan package once Floor Plan is auto-added');
  assert.strictEqual(r.subtotalCents, 14900 + 9800); // package + standalone Standard Photo
});

// 13. Walkthrough Video used to be invalid with Standard photography (no matching package existed).
// As of the Standard+Walkthrough package addition below, every photography tier now has a
// matching Walkthrough package, so this now resolves to that package instead of erroring.
test('13. Standard + Walkthrough Video = package $249 (Basic/Standard, same Condo/House)', () => {
  const r = run(order({ photography: 'standard', addons: { walkthrough_video: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 24900);
  assert.strictEqual(r.lineItems.length, 1);
  assert.strictEqual(r.lineItems[0].id, 'standard_walkthrough');
});

// The "standalone not allowed" / invalid-with-reason mechanism itself is no longer reachable
// through real data now that every photography tier has a Walkthrough package (see test 13 above
// and the exhaustive sweep). Verify the mechanism still works correctly with a cloned config that
// removes all Walkthrough packages, so a regression here doesn't go unnoticed just because today's
// price list happens not to exercise it -- same reasoning as the synthetic ambiguity test below.
test('Synthetic: Walkthrough Video standalone = invalid when no package covers it', () => {
  const syntheticConfig = JSON.parse(JSON.stringify(config));
  syntheticConfig.packages = syntheticConfig.packages.filter((p) => !p.includes.includes('walkthrough_video'));
  const r = calculatePrice(order({ photography: 'standard', addons: { walkthrough_video: true } }), syntheticConfig);
  assert.strictEqual(r.status, 'invalid');
  assert.ok(/Walkthrough Video/.test(r.reason));
});

// 14. Virtual Staging x3 -> $30
test('14. Virtual Staging x3 = $30', () => {
  const r = run(order({ photography: 'standard', addons: { virtual_staging_qty: 3 } }));
  const staging = r.lineItems.find((li) => li.id === 'virtual_staging');
  assert.ok(staging);
  assert.strictEqual(staging.amountCents, 3000);
});

// 15. Manual adjustment: $465 subtotal, -$20 adjustment -> $445 subtotal, $57.85 HST, $502.85 total
test('15. Manual adjustment -$20 on $465 -> $445 subtotal / $57.85 HST / $502.85 total', () => {
  const r = run(
    order({
      propertyType: 'house',
      photography: 'luxury',
      addons: { vlog_video: true, floor_plan: true },
      manualAdjustmentCents: -2000,
    })
  );
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 46500);
  assert.strictEqual(r.finalSubtotalCents, 44500);
  assert.strictEqual(r.hstCents, 5785);
  assert.strictEqual(r.totalCents, 50285);
});

// --- Extra edge cases beyond the required 15 ---

test('Extra: HST math on $98 Standard order (13%)', () => {
  const r = run(order({ photography: 'standard' }));
  assert.strictEqual(r.hstCents, Math.round(9800 * 0.13));
  assert.strictEqual(r.totalCents, r.finalSubtotalCents + r.hstCents);
});

test('Extra: Luxury House + Floor Plan + Site Plan resolves via Floor Plan+Site Plan package, not Luxury+FloorPlan', () => {
  // Luxury+FloorPlan package would strand Site Plan (no standalone price) -> invalid combo, discarded.
  // Floor Plan+Site Plan package + standalone Luxury House is the only valid combo.
  const r = run(order({ propertyType: 'house', photography: 'luxury', addons: { floor_plan: true, site_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  const pkg = r.lineItems.find((li) => li.type === 'package');
  const base = r.lineItems.find((li) => li.type === 'base');
  assert.strictEqual(pkg.id, 'floorplan_siteplan');
  assert.strictEqual(pkg.amountCents, 14900);
  assert.strictEqual(base.id, 'luxury_photo');
  assert.strictEqual(base.amountCents, 19900);
  assert.strictEqual(r.subtotalCents, 34800);
});

test('Extra: 3D Tour is a plain add-on, priced by property type, never bundled into a package', () => {
  const condo = run(order({ propertyType: 'condo', photography: 'standard', addons: { three_d_tour: true } }));
  const house = run(order({ propertyType: 'house', photography: 'standard', addons: { three_d_tour: true } }));
  assert.strictEqual(condo.lineItems.find((li) => li.id === 'three_d_tour').amountCents, 5000);
  assert.strictEqual(house.lineItems.find((li) => li.id === 'three_d_tour').amountCents, 8000);
});

test('Extra: Drone Photos add-on = $50, independent of packages', () => {
  const r = run(order({ photography: 'luxury', propertyType: 'house', addons: { vlog_video: true, drone_photos: true } }));
  const drone = r.lineItems.find((li) => li.id === 'drone_photos');
  assert.strictEqual(drone.amountCents, 5000);
});

test('Extra: Feature Sheets add-on = $60', () => {
  const r = run(order({ photography: 'standard', addons: { feature_sheets: true } }));
  const fs = r.lineItems.find((li) => li.id === 'feature_sheets');
  assert.strictEqual(fs.amountCents, 6000);
});

test('Extra: Luxury + Walkthrough Video exact package match = $299 (not previously in an automated test)', () => {
  const r = run(order({ photography: 'luxury', propertyType: 'house', addons: { walkthrough_video: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.subtotalCents, 29900);
  assert.strictEqual(r.lineItems.length, 1);
  assert.strictEqual(r.lineItems[0].id, 'luxury_walkthrough');
});

test('Extra: two non-overlapping packages can both apply at once (Walkthrough + Site Plan stacks two packages)', () => {
  // Site Plan auto-adds Floor Plan. "Luxury+Walkthrough" ($299) and "FloorPlan+SitePlan" ($149)
  // don't share any covered service id, so both get applied instead of one being demoted to an add-on.
  // This is flagged as a pending business-rule confirmation in 待确认事项.md -- this test just locks in
  // what the engine currently does, so a future change to the algorithm shows up as a failing test here.
  const r = run(order({ photography: 'luxury', propertyType: 'house', addons: { walkthrough_video: true, site_plan: true } }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.lineItems.filter((li) => li.type === 'package').length, 2);
  assert.strictEqual(r.subtotalCents, 29900 + 14900);
});

// --- Exhaustive cross-check against an independently-written reference implementation ---
// (deliberately NOT reusing any of engine.js's internal matching code -- re-derives the
// expected answer straight from pricing-config.js so a shared bug in engine.js can't hide
// from this check). Sweeps every combination of the services that participate in package
// matching, across both property types and both photography tiers.

function powerset(arr) {
  let result = [[]];
  for (const item of arr) result = result.concat(result.map((s) => s.concat([item])));
  return result;
}

function standaloneCents(serviceId, propertyType) {
  const svc = config.services[serviceId];
  if (!svc.pricing) return null;
  if (svc.pricing.type === 'flat') return svc.pricing.amountCents;
  if (svc.pricing.type === 'byPropertyType') return svc.pricing[propertyType];
  return null;
}

function referenceBest(M, propertyType) {
  const applicable = config.packages.filter(
    (pkg) => pkg.includes.every((id) => M.has(id)) && (!pkg.eligiblePropertyTypes || pkg.eligiblePropertyTypes.includes(propertyType))
  );
  const combos = powerset(applicable).filter((combo) => {
    const used = new Set();
    for (const pkg of combo) for (const id of pkg.includes) { if (used.has(id)) return false; used.add(id); }
    return true;
  });
  const candidates = [];
  for (const combo of combos) {
    const covered = new Set();
    combo.forEach((p) => p.includes.forEach((id) => covered.add(id)));
    const leftover = [...M].filter((id) => !covered.has(id));
    let ok = true;
    let leftoverCost = 0;
    for (const id of leftover) {
      const svc = config.services[id];
      const price = svc.standaloneAllowed ? standaloneCents(id, propertyType) : null;
      if (price == null) { ok = false; break; }
      leftoverCost += price;
    }
    if (!ok) continue;
    candidates.push({ coveredCount: covered.size, packageCost: combo.reduce((s, p) => s + p.priceCents, 0), leftoverCost });
  }
  if (candidates.length === 0) return { status: 'invalid' };
  const maxCoverage = Math.max(...candidates.map((c) => c.coveredCount));
  const top = candidates.filter((c) => c.coveredCount === maxCoverage);
  const minLeftover = Math.min(...top.map((c) => c.leftoverCost));
  const best = top.filter((c) => c.leftoverCost === minLeftover);
  if (best.length > 1) return { status: 'ambiguous', count: best.length };
  return { status: 'ok', totalCents: best[0].packageCost + best[0].leftoverCost };
}

test('Exhaustive: 64 combinations (photography x propertyType x 2^4 add-on subsets) vs independent reference', () => {
  const MATCHABLE = ['floor_plan', 'site_plan', 'walkthrough_video', 'vlog_video'];
  let checkedCount = 0;
  const problems = [];

  for (const photography of ['standard', 'luxury']) {
    const photographyId = photography === 'luxury' ? 'luxury_photo' : 'standard_photo';
    for (const propertyType of ['condo', 'house']) {
      for (const addonSubset of powerset(MATCHABLE)) {
        checkedCount++;
        const addons = {};
        addonSubset.forEach((id) => { addons[id] = true; });
        const result = run(order({ propertyType, photography, addons }));

        const M = new Set([photographyId, ...addonSubset]);
        if (M.has('site_plan') && !M.has('floor_plan')) M.add('floor_plan');
        const ref = referenceBest(M, propertyType);

        const label = `photography=${photography} propertyType=${propertyType} addons=[${addonSubset.join(',')}]`;

        if (ref.status !== result.status) {
          problems.push(`status mismatch (${label}): engine=${result.status} reference=${ref.status}`);
          continue;
        }
        if (result.status === 'invalid') continue;
        if (result.status === 'ambiguous') {
          if (result.candidates.length !== ref.count) problems.push(`ambiguous count mismatch (${label})`);
          continue;
        }
        // status === 'ok'
        const hst = Math.round((ref.totalCents * config.taxRatePercent) / 100);
        if (result.totalCents !== ref.totalCents + hst) {
          problems.push(`total mismatch (${label}): engine=${result.totalCents} reference=${ref.totalCents + hst}`);
        }
        const lineSum = result.lineItems.reduce((s, li) => s + li.amountCents, 0);
        if (lineSum !== result.subtotalCents) problems.push(`line item sum != subtotalCents (${label})`);

        // Every M item accounted for exactly once, no double coverage.
        const accountedFor = new Set();
        result.lineItems.forEach((li) => {
          const ids = li.type === 'package' ? li.covers : [li.id];
          ids.forEach((id) => {
            if (!M.has(id)) return;
            if (accountedFor.has(id)) problems.push(`double-covered ${id} (${label})`);
            accountedFor.add(id);
          });
        });
        M.forEach((id) => { if (!accountedFor.has(id)) problems.push(`unaccounted ${id} (${label})`); });
      }
    }
  }

  assert.strictEqual(checkedCount, 64, 'expected exactly 64 combinations to be swept');
  assert.deepStrictEqual(problems, []);
});

test('Synthetic: engine returns "ambiguous" (never guesses) on a genuine tie, with correct candidates', () => {
  // The real pricing-config.js has zero genuine ties (see the exhaustive sweep above), so this
  // branch is otherwise never exercised by real data. Force one with a cloned, modified config
  // so a future refactor that breaks tie-handling shows up here instead of silently in production.
  const syntheticConfig = JSON.parse(JSON.stringify(config));
  // Make Floor Plan and Vlog Video the same standalone price so leaving either one as the
  // leftover add-on costs the same -- a genuine, unbreakable tie.
  syntheticConfig.services.floor_plan.pricing.amountCents = 19900;
  syntheticConfig.packages = [
    { id: 'synthetic_a', displayName: 'Synthetic A', includes: ['standard_photo', 'floor_plan'], priceCents: 16900 },
    { id: 'synthetic_b', displayName: 'Synthetic B', includes: ['standard_photo', 'vlog_video'], priceCents: 16900 },
  ];

  const result = calculatePrice(
    order({ photography: 'standard', addons: { floor_plan: true, vlog_video: true } }),
    syntheticConfig
  );

  assert.strictEqual(result.status, 'ambiguous');
  assert.strictEqual(result.candidates.length, 2);
  const candidatePackageIds = result.candidates.map((c) => c.lineItems.find((li) => li.type === 'package').id).sort();
  assert.deepStrictEqual(candidatePackageIds, ['synthetic_a', 'synthetic_b']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
