// FranVision Job Generator -- pricing integration.
//
// Thin wrapper around the existing pricing engine. Deliberately does NOT
// reimplement any pricing/package logic -- all of that lives in
// pricing/engine.js + pricing/pricing-config.js and is the single source
// of truth. This module only adapts between the Job Generator's order
// shape and PricingEngine.calculatePrice, so the rest of the Job
// Generator never has to know the engine's exact call signature.

const path = require('path');

const PricingEngine = require(path.join(__dirname, '..', 'pricing', 'engine.js'));
const PRICING_CONFIG = require(path.join(__dirname, '..', 'pricing', 'pricing-config.js'));

// order: { propertyType: 'condo'|'house', photography: 'standard'|'luxury',
//          addons: { floor_plan, site_plan, walkthrough_video, vlog_video,
//                     drone_photos, three_d_tour, feature_sheets,
//                     virtual_staging_qty }, manualAdjustmentCents }
//
// This is exactly the order shape pricing/engine.js already expects --
// the Job Generator UI's service-selection ids match the service ids in
// pricing-config.js one-to-one on purpose, so no translation is needed.
function calculatePrice(order) {
  return PricingEngine.calculatePrice(order, PRICING_CONFIG);
}

module.exports = {
  calculatePrice,
  centsToDisplay: PricingEngine.centsToDisplay,
  config: PRICING_CONFIG,
};
