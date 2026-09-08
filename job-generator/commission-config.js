// FranVision Job Generator -- Photographer Commission configuration.
//
// This is the ONLY file you should need to edit when commission rates
// change, or a new photographer needs a different rate table (or an
// exemption). Same spirit as pricing/pricing-config.js: pure data, no
// logic -- all calculation lives in commission-engine.js and never
// hardcodes a rate or a photographer name.
//
// All money amounts are in CENTS (integers). $50.00 -> 5000.
//
// Commission calculation is entirely independent from the client-facing
// Pricing Skill (pricing/engine.js + pricing-config.js) -- this file and
// commission-engine.js never import or reuse anything from pricing/, and
// nothing here can affect what a client is charged.
//
// Structure:
//   defaultRates -- the rate table used for any photographer NOT listed
//     in `photographers` below.
//   photographers -- keyed by a normalized photographer name (trimmed,
//     lowercased -- see commission-engine.js#normalizePhotographerName).
//     Each entry is either:
//       { exempt: true }              -- never earns commission on any
//                                         job (all items forced to $0,
//                                         no Commission Breakdown lines
//                                         at all). This is how "Franky
//                                         gets $0" is expressed -- not a
//                                         hardcoded name check anywhere
//                                         in commission-engine.js.
//       { rates: { <itemId>: cents } } -- overrides just the listed
//                                          items; anything not listed
//                                          here falls back to
//                                          defaultRates for that item.
//
// See commission-engine.js#COMMISSION_ITEMS for the fixed list of
// auto-derived item ids (photography/video/matterport_3d/drone/
// floor_tour). "Travel" is deliberately NOT a rate-table entry -- it's
// always a manual dollar amount entered per job, never looked up here.

module.exports = {
  defaultRates: {
    photography: 5000,   // $50 -- base photography (standard or luxury), flat
    video: 5000,          // $50 -- Walkthrough Video and/or Vlog Video (either/both selected -> still one $50 line, not per-video)
    matterport_3d: 5000,  // $50 -- 3D Virtual Tour
    drone: 3000,           // $30 -- Drone Photos
    floor_tour: 1000,      // $10 -- Floor Plan or Site Plan (shared, same as the Floorplan folder rule)
  },

  photographers: {
    franky: { exempt: true },
  },
};
