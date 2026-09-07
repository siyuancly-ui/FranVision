// FranVision Job Generator -- Photographer Commission calculation.
//
// Pure calculation logic only -- no fs, no I/O, no HTTP. Takes the same
// `order` shape pricing-adapter.js/folder-builder.js use (so the same
// order object drives folders, pricing, AND which commission items apply
// -- one source of truth) plus a rate config (see commission-config.js)
// and returns a full commission breakdown.
//
// Deliberately independent from pricing/engine.js: no imports from
// pricing/, no shared state, no shared assumptions. A change to the
// client-facing Pricing Skill can never silently change a commission
// amount, and vice versa.
//
// Money amounts are integer CENTS throughout, same convention as the
// Pricing Skill.

'use strict';

// The fixed set of commission items that are auto-derived from the
// order's selected services. Order here is just display order.
// "Travel" is intentionally NOT in this list -- it has no rate to look
// up (see commission-config.js) and is always a manual per-job amount,
// carried separately as `travelCents`.
const COMMISSION_ITEMS = [
  { id: 'photography', label: 'Photography' },
  { id: 'video', label: 'Video' },
  { id: 'matterport_3d', label: 'Matterport 3D' },
  { id: 'drone', label: 'Drone' },
  { id: 'floor_tour', label: 'Floor Tour' },
];

// Same normalization for every lookup into config.photographers, so
// "Franky", "franky", " Franky " all match the same config entry.
function normalizePhotographerName(name) {
  return String(name || '').trim().toLowerCase();
}

// Given the order (same shape as pricing-adapter/folder-builder use),
// returns which commission item ids should be checked BY DEFAULT --
// i.e. which services this job actually has, mapped onto the fixed
// commission item list. The user is always free to override this by
// hand afterwards (see computeCommission's checkedItemIds param) --
// this only decides the starting point.
function getDefaultCommissionItemIds(order) {
  const addons = (order && order.addons) || {};
  const ids = ['photography']; // base photography (standard or luxury) is on every job
  if (addons.walkthrough_video || addons.vlog_video) ids.push('video');
  if (addons.three_d_tour) ids.push('matterport_3d');
  if (addons.drone_photos) ids.push('drone');
  if (addons.floor_plan || addons.site_plan) ids.push('floor_tour');
  return ids;
}

// Resolves which rate table applies to a photographer: an exempt flag
// (Franky today, config-driven -- never earns commission), a per-
// photographer override merged over the defaults, or the plain defaults
// for anyone not listed in config.photographers at all.
function getRateTable(photographerName, config) {
  const key = normalizePhotographerName(photographerName);
  const override = config.photographers && config.photographers[key];
  if (override && override.exempt) {
    return { exempt: true, rates: {} };
  }
  const rates = Object.assign({}, config.defaultRates, override && override.rates);
  return { exempt: false, rates };
}

// The one function server.js calls (both for the live UI preview via
// /api/commission, and again authoritatively inside /api/create-job --
// same "server always recomputes, never trusts a client-sent total"
// pattern pricing-adapter.js uses).
//
// checkedItemIds: which of COMMISSION_ITEMS' ids are currently checked.
//   Pass null/undefined to fall back to getDefaultCommissionItemIds(order)
//   -- used for the very first render before the user has touched anything.
// travelCents: manual Travel amount, always independent of the rate table.
//
// Returns:
//   {
//     photographer, exempt,
//     defaultItemIds,          -- for the UI to reset to on demand
//     allItems: [{id,label,amountCents,checked}, ...],  -- ALL 5 items,
//       so the UI can show every checkbox with its dollar amount even
//       when unchecked; amountCents is 0 for every item when exempt.
//     travelCents, totalCents,
//   }
function computeCommission({ photographerName, order, checkedItemIds, travelCents, config }) {
  const defaultItemIds = getDefaultCommissionItemIds(order);
  const idsSet = new Set(checkedItemIds != null ? checkedItemIds : defaultItemIds);
  const normalizedTravelCents = Math.round(Number(travelCents) || 0);

  const { exempt, rates } = getRateTable(photographerName, config);

  if (exempt) {
    return {
      photographer: photographerName || '',
      exempt: true,
      defaultItemIds,
      allItems: COMMISSION_ITEMS.map((item) => ({ id: item.id, label: item.label, amountCents: 0, checked: false })),
      travelCents: 0,
      totalCents: 0,
    };
  }

  const allItems = COMMISSION_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    amountCents: rates[item.id] || 0,
    checked: idsSet.has(item.id),
  }));
  const itemsTotalCents = allItems.filter((i) => i.checked).reduce((sum, i) => sum + i.amountCents, 0);
  const totalCents = itemsTotalCents + normalizedTravelCents;

  return {
    photographer: photographerName || '',
    exempt: false,
    defaultItemIds,
    allItems,
    travelCents: normalizedTravelCents,
    totalCents,
  };
}

module.exports = {
  COMMISSION_ITEMS,
  normalizePhotographerName,
  getDefaultCommissionItemIds,
  getRateTable,
  computeCommission,
};
