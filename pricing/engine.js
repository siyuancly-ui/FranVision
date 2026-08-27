// FranVision pricing engine.
//
// Pure calculation logic only -- no DOM, no I/O. Takes an order + a config
// (see pricing-config.js) and returns a full pricing breakdown. Does not
// hardcode any prices or package rules; those all come from config.
//
// Works unmodified in Node (require) and in a plain <script> tag in the
// browser (sets window.PricingEngine).
//
// ---------------------------------------------------------------------
// Algorithm (see project discussion for the reasoning / worked examples)
// ---------------------------------------------------------------------
// "Package First": a package price is used whenever it applies, even if
// summing standalone prices would be cheaper. Packages are never chosen
// to minimize total cost.
//
// 1. Build M = the set of "matchable" service ids on the order: the
//    mandatory base photography service (standard_photo or luxury_photo)
//    plus whichever of {floor_plan, site_plan, walkthrough_video,
//    vlog_video} were selected. (Site Plan auto-adds Floor Plan if it's
//    missing, since Site Plan can never be sold without it.)
//
//    Everything else (3D Tour, Drone Photos, Virtual Staging, Feature
//    Sheets) never appears inside a package in the current price list, so
//    those are always priced standalone regardless of what else is on the
//    order -- they don't participate in the matching below.
//
// 2. Find every package whose `includes` is fully contained in M. Try
//    every combination of these packages that doesn't reuse a service id
//    (a service already covered by one chosen package can't also be
//    covered by another -- "no double charging" and no double-covering).
//
// 3. For each such combination, whatever is left over from M must be
//    payable standalone (standaloneAllowed + a price). If any leftover
//    item can't be sold standalone, that whole combination is invalid
//    (e.g. picking the Luxury+FloorPlan package would leave Site Plan
//    stranded with no price -- that combination is discarded).
//
// 4. Rank the surviving combinations: prefer the one covering the most
//    service ids via packages. If tied, prefer the one whose leftover
//    (standalone) items add up to the lowest price -- i.e. let the
//    cheaper item stay a standalone add-on, per the client's own rule.
//    If still tied, the result is "ambiguous": every tied option is
//    returned so a human can pick one, rather than the engine guessing.
//
// 5. If there is no valid combination at all, the result is "invalid"
//    with a human-readable reason (e.g. "Walkthrough Video is only
//    available as part of a package.").

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PricingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MATCHABLE_ADDON_IDS = ['floor_plan', 'site_plan', 'walkthrough_video', 'vlog_video'];

  function standaloneCents(service, propertyType) {
    if (!service.pricing) return null;
    if (service.pricing.type === 'flat') return service.pricing.amountCents;
    if (service.pricing.type === 'byPropertyType') {
      const v = service.pricing[propertyType];
      return typeof v === 'number' ? v : null;
    }
    return null;
  }

  function allSubsets(arr) {
    let result = [[]];
    for (const item of arr) {
      const next = [];
      for (const s of result) {
        next.push(s);
        next.push(s.concat([item]));
      }
      result = next;
    }
    return result;
  }

  function centsToDisplay(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return sign + '$' + (abs / 100).toFixed(2);
  }

  function calculatePrice(order, config) {
    const services = config.services;
    const propertyType = order.propertyType;
    const addons = order.addons || {};
    const notes = [];

    if (propertyType !== 'condo' && propertyType !== 'house') {
      return { status: 'invalid', reason: 'propertyType must be "condo" or "house".' };
    }
    if (order.photography !== 'standard' && order.photography !== 'luxury') {
      return { status: 'invalid', reason: 'photography must be "standard" or "luxury".' };
    }

    const photographyId = order.photography === 'luxury' ? 'luxury_photo' : 'standard_photo';

    // ---- Step 1: build M ----
    const M = new Set([photographyId]);
    for (const id of MATCHABLE_ADDON_IDS) {
      if (addons[id]) M.add(id);
    }
    if (M.has('site_plan') && !M.has('floor_plan')) {
      M.add('floor_plan');
      notes.push('Floor Plan was auto-added because Site Plan requires it.');
    }

    // ---- Step 2: eligible packages + disjoint combinations ----
    const eligiblePackages = config.packages.filter((pkg) => {
      const includesOk = pkg.includes.every((id) => M.has(id));
      const eligiblePT = !pkg.eligiblePropertyTypes || pkg.eligiblePropertyTypes.includes(propertyType);
      return includesOk && eligiblePT;
    });

    const packageCombinations = allSubsets(eligiblePackages).filter((combo) => {
      const seen = new Set();
      for (const pkg of combo) {
        for (const id of pkg.includes) {
          if (seen.has(id)) return false;
          seen.add(id);
        }
      }
      return true;
    });

    // ---- Step 3: validate leftovers, build candidates ----
    const candidates = [];
    for (const chosenPackages of packageCombinations) {
      const covered = new Set();
      chosenPackages.forEach((pkg) => pkg.includes.forEach((id) => covered.add(id)));
      const leftoverIds = [...M].filter((id) => !covered.has(id));

      let valid = true;
      let leftoverCostCents = 0;
      const leftoverItems = [];
      for (const id of leftoverIds) {
        const svc = services[id];
        if (!svc || !svc.standaloneAllowed) {
          valid = false;
          break;
        }
        const priceCents = standaloneCents(svc, propertyType);
        if (priceCents == null) {
          valid = false;
          break;
        }
        leftoverCostCents += priceCents;
        leftoverItems.push({ id, priceCents });
      }
      if (!valid) continue;

      candidates.push({
        packages: chosenPackages,
        coveredCount: covered.size,
        leftoverItems,
        leftoverCostCents,
        packageCostCents: chosenPackages.reduce((sum, p) => sum + p.priceCents, 0),
      });
    }

    if (candidates.length === 0) {
      const blockedMessages = [...M]
        .map((id) => services[id])
        .filter((svc) => svc && svc.standaloneAllowed === false)
        .map((svc) => svc.restrictionMessage || svc.displayName + ' is not available standalone.');
      return {
        status: 'invalid',
        reason: blockedMessages.length
          ? blockedMessages.join(' ')
          : 'No valid pricing combination found for the selected services.',
        notes,
      };
    }

    // ---- Step 4: rank ----
    const bestCoveredCount = Math.max(...candidates.map((c) => c.coveredCount));
    const topByCoverage = candidates.filter((c) => c.coveredCount === bestCoveredCount);
    const bestLeftoverCost = Math.min(...topByCoverage.map((c) => c.leftoverCostCents));
    const best = topByCoverage.filter((c) => c.leftoverCostCents === bestLeftoverCost);

    function buildResult(candidate) {
      const lineItems = [];

      candidate.packages.forEach((pkg) => {
        lineItems.push({
          type: 'package',
          id: pkg.id,
          label: pkg.displayName,
          amountCents: pkg.priceCents,
          covers: pkg.includes.slice(),
        });
      });

      candidate.leftoverItems.forEach((item) => {
        const svc = services[item.id];
        const isBasePhotography = item.id === photographyId;
        lineItems.push({
          type: isBasePhotography ? 'base' : 'addon',
          id: item.id,
          label: svc.displayName,
          amountCents: item.priceCents,
        });
      });

      // Always-standalone add-ons (never part of a package in this catalog).
      if (addons.drone_photos) {
        const svc = services.drone_photos;
        lineItems.push({ type: 'addon', id: 'drone_photos', label: svc.displayName, amountCents: standaloneCents(svc, propertyType) });
      }
      if (addons.feature_sheets) {
        const svc = services.feature_sheets;
        lineItems.push({ type: 'addon', id: 'feature_sheets', label: svc.displayName, amountCents: standaloneCents(svc, propertyType) });
      }
      if (addons.three_d_tour) {
        const svc = services.three_d_tour;
        lineItems.push({ type: 'addon', id: 'three_d_tour', label: svc.displayName, amountCents: standaloneCents(svc, propertyType) });
      }
      const stagingQty = Number(addons.virtual_staging_qty) || 0;
      if (stagingQty > 0) {
        const svc = services.virtual_staging;
        lineItems.push({
          type: 'addon',
          id: 'virtual_staging',
          label: svc.displayName + ' ×' + stagingQty,
          amountCents: svc.pricing.unitAmountCents * stagingQty,
        });
      }

      const subtotalCents = lineItems.reduce((sum, li) => sum + li.amountCents, 0);
      const manualAdjustmentCents = Math.round(Number(order.manualAdjustmentCents) || 0);
      const finalSubtotalCents = subtotalCents + manualAdjustmentCents;
      const hstCents = Math.round((finalSubtotalCents * config.taxRatePercent) / 100);
      const totalCents = finalSubtotalCents + hstCents;

      const explanation = notes.slice();
      if (candidate.packages.length) {
        explanation.push('Matched package(s): ' + candidate.packages.map((p) => p.displayName).join(', '));
      }
      const leftoverAddonNames = candidate.leftoverItems
        .filter((i) => i.id !== photographyId)
        .map((i) => services[i.id].displayName);
      if (leftoverAddonNames.length) {
        explanation.push('Remaining add-on(s): ' + leftoverAddonNames.join(', '));
      }
      if (manualAdjustmentCents !== 0) {
        explanation.push('Manual adjustment applied: ' + centsToDisplay(manualAdjustmentCents));
      }

      return {
        lineItems,
        subtotalCents,
        manualAdjustmentCents,
        finalSubtotalCents,
        hstCents,
        totalCents,
        explanation,
      };
    }

    if (best.length > 1) {
      return {
        status: 'ambiguous',
        notes,
        candidates: best.map(buildResult),
      };
    }

    return Object.assign({ status: 'ok' }, buildResult(best[0]));
  }

  return { calculatePrice, centsToDisplay };
});
