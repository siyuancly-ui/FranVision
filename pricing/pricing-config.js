// FranVision pricing configuration.
//
// This is the ONLY file you should need to edit when prices change.
// Do not put prices or package rules into engine.js or tester.html.
//
// All money amounts are in CENTS (integers) to avoid floating point
// rounding errors. $169.00 -> 16900.
//
// service.pricing.type:
//   "flat"           -> pricing.amountCents, same price regardless of property type
//   "byPropertyType" -> pricing.condo / pricing.house
//   "perUnit"        -> pricing.unitAmountCents, requires a quantity (e.g. Virtual Staging)
//   (omitted)        -> service has no standalone price (standaloneAllowed must be false)
//
// service.standaloneAllowed: false means this service can never be sold on
// its own -- it can only appear as part of a package (see restrictionMessage).
//
// service.requires: other service ids that must also be present in the order
// whenever this service is selected. The engine auto-adds missing
// requirements, chained if needed (e.g. Site Plan -> Floor Plan today; any
// new service can use this the same way, no engine.js change needed).
//
// package.includes: which service ids this package covers. A package is only
// considered "applicable" if every id in includes is present in the order.
// package.eligiblePropertyTypes: omit to allow both condo and house.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PRICING_CONFIG = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    taxRatePercent: 13,

    services: {
      standard_photo: {
        id: 'standard_photo',
        displayName: 'Standard Photography',
        category: 'photography',
        standaloneAllowed: true,
        pricing: { type: 'flat', amountCents: 9800 }, // $98, same Condo/House
      },
      luxury_photo: {
        id: 'luxury_photo',
        displayName: 'Luxury Photography',
        category: 'photography',
        standaloneAllowed: true,
        pricing: { type: 'byPropertyType', condo: 16900, house: 19900 }, // $169 / $199
      },
      floor_plan: {
        id: 'floor_plan',
        displayName: 'Floor Plan',
        category: 'addon',
        standaloneAllowed: true,
        pricing: { type: 'flat', amountCents: 6600 }, // $66
      },
      site_plan: {
        id: 'site_plan',
        displayName: 'Site Plan',
        category: 'addon',
        standaloneAllowed: false,
        requires: ['floor_plan'],
        restrictionMessage: 'Site Plan is only available together with Floor Plan.',
      },
      walkthrough_video: {
        id: 'walkthrough_video',
        displayName: 'Walkthrough Video',
        category: 'addon',
        standaloneAllowed: false,
        restrictionMessage: 'Walkthrough Video is only available as part of a package.',
      },
      vlog_video: {
        id: 'vlog_video',
        displayName: 'Vlog Video',
        category: 'addon',
        standaloneAllowed: true,
        pricing: { type: 'flat', amountCents: 19900 }, // $199
      },
      drone_photos: {
        id: 'drone_photos',
        displayName: 'Drone Photos',
        category: 'addon',
        standaloneAllowed: true,
        pricing: { type: 'flat', amountCents: 5000 }, // $50
      },
      virtual_staging: {
        id: 'virtual_staging',
        displayName: 'Virtual Staging',
        category: 'addon',
        standaloneAllowed: true,
        requiresQuantity: true,
        pricing: { type: 'perUnit', unitAmountCents: 1000 }, // $10 / photo
      },
      feature_sheets: {
        id: 'feature_sheets',
        displayName: 'Feature Sheets (30 copies)',
        category: 'addon',
        standaloneAllowed: true,
        pricing: { type: 'flat', amountCents: 6000 }, // $60
      },
      three_d_tour: {
        id: 'three_d_tour',
        displayName: '3D Virtual Tour',
        category: 'addon',
        standaloneAllowed: true,
        pricing: { type: 'byPropertyType', condo: 5000, house: 8000 }, // $50 / $80
      },
    },

    // Packages that combine the mandatory photography service with one
    // addon. Prices are flat (same for Condo and House) unless a package
    // explicitly sets eligiblePropertyTypes.
    packages: [
      {
        id: 'standard_floorplan',
        displayName: 'Standard Photo + Floor Plan',
        includes: ['standard_photo', 'floor_plan'],
        priceCents: 16900, // $169
      },
      {
        id: 'luxury_floorplan',
        displayName: 'Luxury Photo + Floor Plan',
        includes: ['luxury_photo', 'floor_plan'],
        priceCents: 24900, // $249
      },
      {
        id: 'standard_walkthrough',
        displayName: 'Standard Photo + Walkthrough Video',
        includes: ['standard_photo', 'walkthrough_video'],
        priceCents: 24900, // $249, same Condo/House
      },
      {
        id: 'luxury_walkthrough',
        displayName: 'Luxury Photo + Walkthrough Video',
        includes: ['luxury_photo', 'walkthrough_video'],
        priceCents: 29900, // $299
      },
      {
        id: 'luxury_vlog',
        displayName: 'Luxury Photo + Vlog Video',
        includes: ['luxury_photo', 'vlog_video'],
        priceCents: 39900, // $399
      },
      {
        id: 'floorplan_siteplan',
        displayName: 'Floor Plan + Site Plan',
        includes: ['floor_plan', 'site_plan'],
        priceCents: 14900, // $149
      },
    ],
  };
});
