// FranVision pricing advisor -- validation logic.
//
// Pure calculation logic only -- no DOM. Takes the CURRENT pricing config
// plus a list of pending hypothetical changes (services to add, packages to
// add, prices to edit), and reports whether they're safe to fold into
// pricing-config.js.
//
// Two severities (see project discussion for the reasoning):
//   - hardErrors: the engine literally can't compute a unique price for
//     some order, or a change doesn't parse / references something that
//     doesn't exist. Must be fixed before this goes into pricing-config.js.
//   - warnings: the engine computes fine, but the result looks off (could
//     be a deliberate promotion, e.g. a bundle priced below its parts) --
//     a human judgement call, not a blocker.
//
// A "change" is one of:
//   { type: 'newService', service: {...} }              -- service shape, see pricing-config.js
//   { type: 'newPackage', package: {...} }               -- package shape, see pricing-config.js
//   { type: 'editServicePrice', id, pricing: {...} }     -- replaces services[id].pricing
//   { type: 'editPackagePrice', id, priceCents: N }      -- replaces the matching package's priceCents
//   { type: 'setRequires', id, requires: [...] }         -- replaces services[id].requires (see suggestRequires)
//
// Two check tiers, run at different times (see project discussion for why):
//   - checkStatic(baseConfig, queuedChanges, candidate): safe to run the
//     moment a single change is filled in, before the rest of the batch is
//     known. Only checks things that are true in isolation (duplicate ids,
//     dangling references, malformed price fields) -- never runs the full
//     combinatorial matching, since an add-on that's meant to be standalone-
//     disallowed and paired with a package added later in the same batch
//     would otherwise look "invalid" prematurely.
//   - runFullCheck(baseConfig, changes): the real gate. Merges the whole
//     batch into one draft config and sweeps every order combination
//     through the actual engine, diffing against the current config.
//
// Works unmodified in Node (require) and in a plain <script> tag in the
// browser (sets window.PricingAdvisor).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../engine.js'));
  } else {
    root.PricingAdvisor = factory(root.PricingEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (PricingEngine) {
  'use strict';

  const calculatePrice = PricingEngine.calculatePrice;

  // A larger addon catalog makes the exhaustive sweep grow as 2^N (x4 for
  // property type x photography). 14 services is already far more than
  // today's real list (8) or one batch of changes is likely to add --
  // past this, skip the sweep rather than hang the page.
  const MAX_UNIVERSE = 14;

  // ---- change list -> draft config ---------------------------------------

  function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config));
  }

  function applyChanges(baseConfig, changes) {
    const draft = cloneConfig(baseConfig);
    changes.forEach((ch) => {
      if (ch.type === 'newService') {
        draft.services[ch.service.id] = JSON.parse(JSON.stringify(ch.service));
      } else if (ch.type === 'newPackage') {
        draft.packages.push(JSON.parse(JSON.stringify(ch.package)));
      } else if (ch.type === 'editServicePrice') {
        if (draft.services[ch.id]) draft.services[ch.id].pricing = JSON.parse(JSON.stringify(ch.pricing));
      } else if (ch.type === 'editPackagePrice') {
        const pkg = draft.packages.find((p) => p.id === ch.id);
        if (pkg) pkg.priceCents = ch.priceCents;
      } else if (ch.type === 'setRequires') {
        if (draft.services[ch.id]) draft.services[ch.id].requires = ch.requires.slice();
      }
    });
    return draft;
  }

  function slugify(name) {
    const s = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s || 'service';
  }

  // Appends _2, _3, ... on collision against both services and packages
  // (their ids are different namespaces to the engine, but sharing text
  // between them is confusing, so this dedupes against both).
  function uniqueId(desired, draft) {
    let id = desired;
    let n = 2;
    while (draft.services[id] || draft.packages.some((p) => p.id === id)) {
      id = desired + '_' + n;
      n++;
    }
    return id;
  }

  function isNonNegInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
  }

  function money(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  // ---- static, single-item checks ----------------------------------------

  function checkPricingShape(pricing, label) {
    const errors = [];
    if (!pricing || !pricing.type) {
      errors.push({ code: 'missing_pricing', message: '"' + label + '" 标记为可以单独出售，但没有填价格。' });
      return errors;
    }
    if (pricing.type === 'flat') {
      if (!isNonNegInt(pricing.amountCents)) errors.push({ code: 'bad_price', message: '"' + label + '" 的一口价不是合法的非负整数分。' });
    } else if (pricing.type === 'byPropertyType') {
      if (!isNonNegInt(pricing.condo)) errors.push({ code: 'bad_price', message: '"' + label + '" 缺少合法的 condo 价格。' });
      if (!isNonNegInt(pricing.house)) errors.push({ code: 'bad_price', message: '"' + label + '" 缺少合法的 house 价格。' });
    } else if (pricing.type === 'perUnit') {
      if (!isNonNegInt(pricing.unitAmountCents)) errors.push({ code: 'bad_price', message: '"' + label + '" 缺少合法的单价（分）。' });
    } else {
      errors.push({ code: 'bad_pricing_type', message: '"' + label + '" 的定价方式不是一口价/按房型/按数量之一。' });
    }
    return errors;
  }

  function checkServiceShape(svc) {
    const errors = [];
    if (!svc.id) errors.push({ code: 'missing_id', message: '服务缺少 id。' });
    if (!svc.displayName) errors.push({ code: 'missing_name', message: '服务缺少名称。' });
    if (svc.standaloneAllowed) {
      errors.push(...checkPricingShape(svc.pricing, svc.displayName || svc.id));
    }
    return errors;
  }

  // Runs only the checks that are true (or not) about `candidate` on its
  // own, against `baseConfig` + whatever's already in `queuedChanges` --
  // never the full combinatorial engine sweep (see file header).
  function checkStatic(baseConfig, queuedChanges, candidate) {
    const errors = [];
    const before = applyChanges(baseConfig, queuedChanges);
    const draft = applyChanges(baseConfig, queuedChanges.concat([candidate]));

    if (candidate.type === 'newService') {
      const svc = candidate.service;
      if (before.services[svc.id]) {
        errors.push({ code: 'duplicate_id', message: '服务 id "' + svc.id + '" 已经存在。' });
      }
      errors.push(...checkServiceShape(svc));
      (svc.requires || []).forEach((reqId) => {
        if (!draft.services[reqId]) {
          errors.push({ code: 'dangling_reference', message: '"' + svc.displayName + '" 的依赖项指向不存在的服务 id "' + reqId + '"。' });
        }
      });
    } else if (candidate.type === 'newPackage') {
      const pkg = candidate.package;
      if (before.packages.some((p) => p.id === pkg.id)) {
        errors.push({ code: 'duplicate_id', message: '套餐 id "' + pkg.id + '" 已经存在。' });
      }
      if (!pkg.displayName) errors.push({ code: 'missing_name', message: '套餐缺少名称。' });
      if (!pkg.includes || pkg.includes.length === 0) {
        errors.push({ code: 'empty_includes', message: '套餐 "' + (pkg.displayName || pkg.id) + '" 没有选择任何包含的服务。' });
      }
      (pkg.includes || []).forEach((id) => {
        if (!draft.services[id]) {
          errors.push({ code: 'dangling_reference', message: '套餐 "' + (pkg.displayName || pkg.id) + '" 包含一个不存在的服务 id "' + id + '"。' });
        }
      });
      if (!isNonNegInt(pkg.priceCents)) {
        errors.push({ code: 'bad_price', message: '套餐 "' + (pkg.displayName || pkg.id) + '" 的价格不是合法的非负整数分。' });
      }
      // Duplicate includes-set conflict against every other package in the draft.
      // Two packages with the same includes but different eligiblePropertyTypes
      // (e.g. one condo-only, one house-only) are NOT a conflict -- that's the
      // supported way to give a combo two different prices per property type.
      if (pkg.includes && pkg.includes.length) {
        const ptKey = (pt) => (pt && pt.length ? pt.slice().sort().join(',') : 'both');
        const key = pkg.includes.slice().sort().join('+') + '|' + ptKey(pkg.eligiblePropertyTypes);
        draft.packages.forEach((other) => {
          if (other === pkg || other.id === pkg.id) return;
          const otherKey = other.includes.slice().sort().join('+') + '|' + ptKey(other.eligiblePropertyTypes);
          if (otherKey === key && other.priceCents !== pkg.priceCents) {
            errors.push({
              code: 'package_conflict',
              message: '套餐 "' + pkg.displayName + '" 包含的服务组合跟已有套餐 "' + other.displayName + '" 完全一样，但价格不同（' + money(pkg.priceCents) + ' vs ' + money(other.priceCents) + '）。',
            });
          }
        });
      }
    } else if (candidate.type === 'editServicePrice') {
      if (!before.services[candidate.id]) {
        errors.push({ code: 'missing_target', message: '找不到要修改价格的服务 "' + candidate.id + '"。' });
      }
      errors.push(...checkPricingShape(candidate.pricing, candidate.id));
    } else if (candidate.type === 'editPackagePrice') {
      if (!before.packages.some((p) => p.id === candidate.id)) {
        errors.push({ code: 'missing_target', message: '找不到要修改价格的套餐 "' + candidate.id + '"。' });
      }
      if (!isNonNegInt(candidate.priceCents)) {
        errors.push({ code: 'bad_price', message: '新价格不是合法的非负整数分。' });
      }
    }

    return errors;
  }

  // ---- full / comprehensive checks (need the whole batch at once) --------

  function addonUniverse(config) {
    return Object.keys(config.services).filter((id) => id !== 'standard_photo' && id !== 'luxury_photo');
  }

  function powerset(arr) {
    let result = [[]];
    for (const item of arr) result = result.concat(result.map((s) => s.concat([item])));
    return result;
  }

  function buildOrder(propertyType, photography, addonIds, config) {
    const addons = {};
    addonIds.forEach((id) => {
      const svc = config.services[id];
      if (svc && svc.requiresQuantity) addons[id + '_qty'] = 1;
      else addons[id] = true;
    });
    return { propertyType, photography, addons, manualAdjustmentCents: 0 };
  }

  // Sweeps every order combination through the draft config and flags any
  // that can no longer be priced -- but only if that exact combination was
  // fine on the CURRENT config (or is unreachable there because it uses a
  // brand-new service), so an already-existing gap in the price list isn't
  // mistakenly blamed on this batch of changes.
  function runExhaustiveDiff(baseConfig, draftConfig) {
    const universe = addonUniverse(draftConfig);
    if (universe.length > MAX_UNIVERSE) {
      return {
        errors: [{
          code: 'universe_too_large',
          message: '服务数量太多（' + universe.length + ' 个），穷举检测跳过了，请人工多测几个组合确认。',
        }],
        combosChecked: 0,
      };
    }

    const subsets = powerset(universe);
    const errors = [];
    let combosChecked = 0;

    ['condo', 'house'].forEach((propertyType) => {
      ['standard', 'luxury'].forEach((photography) => {
        subsets.forEach((addonIds) => {
          combosChecked++;
          const draftResult = calculatePrice(buildOrder(propertyType, photography, addonIds, draftConfig), draftConfig);
          if (draftResult.status === 'ok') return;

          const usesOnlyOldServices = addonIds.every((id) => baseConfig.services[id]);
          const baselineResult = usesOnlyOldServices
            ? calculatePrice(buildOrder(propertyType, photography, addonIds, baseConfig), baseConfig)
            : null;
          const wasFineBefore = baselineResult && baselineResult.status === 'ok';

          if (!usesOnlyOldServices || wasFineBefore) {
            const label = photography + '/' + propertyType + (addonIds.length ? ' + ' + addonIds.join('+') : '');
            if (draftResult.status === 'ambiguous') {
              errors.push({ code: 'new_ambiguous', message: '订单组合「' + label + '」现在算不出唯一价格了（多个套餐组合打平，需要人工选一个）。' });
            } else {
              errors.push({ code: 'new_invalid', message: '订单组合「' + label + '」现在算不出价格：' + (draftResult.reason || '未知原因') });
            }
          }
        });
      });
    });

    return { errors, combosChecked };
  }

  // ---- warnings ------------------------------------------------------------

  function checkPackageSubsetInversion(config) {
    const warnings = [];
    const pkgs = config.packages;
    for (let i = 0; i < pkgs.length; i++) {
      for (let j = 0; j < pkgs.length; j++) {
        if (i === j) continue;
        const a = pkgs[i];
        const b = pkgs[j];
        const aSet = new Set(a.includes);
        const isProperSubset = b.includes.length < a.includes.length && b.includes.every((id) => aSet.has(id));
        if (isProperSubset && a.priceCents < b.priceCents) {
          warnings.push({
            code: 'subset_inversion',
            message: '套餐 "' + a.displayName + '"（包含更多服务）比 "' + b.displayName + '"（包含更少服务）还便宜：' + money(a.priceCents) + ' vs ' + money(b.priceCents) + '。',
          });
        }
      }
    }
    return warnings;
  }

  function checkLuxuryVsStandard(config) {
    const warnings = [];
    const byNormalizedIncludes = {};
    config.packages.forEach((pkg) => {
      const usesLuxury = pkg.includes.includes('luxury_photo');
      const usesStandard = pkg.includes.includes('standard_photo');
      if (!usesLuxury && !usesStandard) return;
      const normalized = pkg.includes
        .map((id) => (id === 'luxury_photo' || id === 'standard_photo' ? 'PHOTO' : id))
        .sort()
        .join('+');
      byNormalizedIncludes[normalized] = byNormalizedIncludes[normalized] || {};
      byNormalizedIncludes[normalized][usesLuxury ? 'luxury' : 'standard'] = pkg;
    });
    Object.keys(byNormalizedIncludes).forEach((key) => {
      const pair = byNormalizedIncludes[key];
      if (pair.luxury && pair.standard && pair.luxury.priceCents <= pair.standard.priceCents) {
        warnings.push({
          code: 'luxury_not_pricier',
          message: '"' + pair.luxury.displayName + '"（Luxury）的价格不高于 "' + pair.standard.displayName + '"（Standard）：' + money(pair.luxury.priceCents) + ' vs ' + money(pair.standard.priceCents) + '。',
        });
      }
    });
    return warnings;
  }

  // For every order that prices fine, adding one more selected service
  // should never make the total go DOWN. A drop is either a genuine bug or
  // a deliberate promotion -- flagged either way for a human to judge.
  function checkMonotonicity(draftConfig) {
    const warnings = [];
    const universe = addonUniverse(draftConfig);
    if (universe.length > MAX_UNIVERSE) return warnings;

    const seen = new Set();
    ['condo', 'house'].forEach((propertyType) => {
      ['standard', 'luxury'].forEach((photography) => {
        powerset(universe).forEach((addonIds) => {
          const base = calculatePrice(buildOrder(propertyType, photography, addonIds, draftConfig), draftConfig);
          if (base.status !== 'ok') return;
          universe.forEach((extraId) => {
            if (addonIds.includes(extraId)) return;
            const withExtra = calculatePrice(buildOrder(propertyType, photography, addonIds.concat([extraId]), draftConfig), draftConfig);
            if (withExtra.status !== 'ok') return;
            if (withExtra.totalCents < base.totalCents) {
              const key = propertyType + '|' + photography + '|' + addonIds.slice().sort().join(',') + '|+' + extraId;
              if (seen.has(key)) return;
              seen.add(key);
              const svc = draftConfig.services[extraId];
              const label = photography + '/' + propertyType + (addonIds.length ? ' + ' + addonIds.join('+') : '');
              warnings.push({
                code: 'non_monotonic',
                message: '订单「' + label + '」加了 "' + (svc ? svc.displayName : extraId) + '" 之后总价反而变低了：' + money(base.totalCents) + ' -> ' + money(withExtra.totalCents) + '。',
              });
            }
          });
        });
      });
    });
    return warnings;
  }

  // ---- "auto-add" suggestions ----------------------------------------------

  // A bundle-only service (standaloneAllowed:false, no `requires` yet) that
  // shows up in 2+ packages, always alongside the same other id(s), is
  // structurally the same shape as Site Plan -> Floor Plan. Surface it as an
  // optional convenience (not a correctness requirement -- pricing already
  // works fine via the packages themselves) so a human can decide whether to
  // wire up the auto-add. Needs 2+ occurrences before suggesting anything --
  // a single package's companion set is just that package's own recipe, not
  // evidence of a structural requirement.
  function suggestRequires(config) {
    const suggestions = [];
    Object.keys(config.services).forEach((id) => {
      const svc = config.services[id];
      if (svc.standaloneAllowed) return;
      if (svc.requires && svc.requires.length) return;
      const pkgs = config.packages.filter((p) => p.includes.includes(id));
      if (pkgs.length < 2) return;
      let common = null;
      pkgs.forEach((p) => {
        const others = new Set(p.includes.filter((x) => x !== id));
        common = common === null ? others : new Set([...common].filter((x) => others.has(x)));
      });
      if (common && common.size > 0) {
        suggestions.push({ id, requires: Array.from(common) });
      }
    });
    return suggestions;
  }

  // ---- top-level entry point ------------------------------------------------

  // The authoritative gate: merges the whole pending-changes batch into one
  // draft config and validates it as a whole (see file header for why this
  // differs from checkStatic).
  function runFullCheck(baseConfig, changes) {
    const draft = applyChanges(baseConfig, changes);

    const hardErrors = [];
    changes.forEach((ch, idx) => {
      hardErrors.push(...checkStatic(baseConfig, changes.slice(0, idx), ch));
    });
    const exhaustive = runExhaustiveDiff(baseConfig, draft);
    hardErrors.push(...exhaustive.errors);

    const warnings = []
      .concat(checkPackageSubsetInversion(draft))
      .concat(checkLuxuryVsStandard(draft))
      .concat(checkMonotonicity(draft));

    return {
      hardErrors,
      warnings,
      combosChecked: exhaustive.combosChecked,
      draftConfig: draft,
    };
  }

  return {
    cloneConfig,
    applyChanges,
    slugify,
    uniqueId,
    money,
    checkStatic,
    runFullCheck,
    addonUniverse,
    suggestRequires,
  };
});
