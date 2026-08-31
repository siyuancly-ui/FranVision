/*
 * FranVision Feature Sheet Builder -- v2 conditional modules
 * =========================================================
 *
 * The parts of page 1 that change with what the agent fills in. Each
 * module is expressed as a vertical STACK of bands for layout-engine.js:
 *
 *   band = {
 *     id,
 *     kind: 'photos' | 'text' | 'group',
 *     slots: [ { id, wFrac, aspect } ]   // for kind:'photos' (row of 1..n)
 *     field:  '<data path>'              // for kind:'text'
 *     minHFrac,                          // natural / minimum height (frac of TRIM height)
 *     growWeight,                        // share of leftover vertical space (0 = fixed)
 *   }
 *
 * gapWeight between consecutive bands decides how leftover space that is
 * NOT taken by growWeight bands is spread as breathing room. Photo bands
 * never distort: their height is wFrac / aspect and is fixed; only text
 * bands grow and only gaps stretch.
 *
 * Column bounds come from geometry: left column x 0.009..0.490,
 * right column x 0.503..0.996.
 */
(function (root) {
  'use strict';

  var LEFT = { x: 0.009, w: 0.481, top: 0.026, bottom: 0.972 };
  var RIGHT = { x: 0.503, w: 0.493, top: 0.016, bottom: 0.977 };

  // ---- helpers -------------------------------------------------------
  function row(ids, opts) {
    opts = opts || {};
    var n = ids.length;
    var gap = opts.gap == null ? 0.014 : opts.gap;      // frac of page width
    var wEach = (LEFT.w - gap * (n - 1)) / n;
    var aspect = opts.aspect || (n === 1 ? 2.15 : n === 2 ? 1.30 : 1.30);
    return ids.map(function (id) {
      return { id: id, wFrac: wEach, aspect: aspect };
    });
  }

  // ================================================================
  //  LEFT COLUMN VARIANTS
  //  chosen by:  description filled?  ->  stagger5 (+desc) | collage6
  // ================================================================
  var leftColumn = {
    // HAS description -> 5-photo staggered collage + justified description.
    // Explicit rects (compose() places them directly, not via the band
    // solver): 2 across the top, then 2 stacked (left) + 1 large (right).
    stagger5: {
      id: 'left-stagger5',
      column: LEFT,
      explicit: true,
      photos: [
        { id: 'p1L-1', rect: [0.009, 0.026, 0.230, 0.232] }, // top-left
        { id: 'p1L-2', rect: [0.253, 0.026, 0.237, 0.232] }, // top-right
        { id: 'p1L-3', rect: [0.009, 0.276, 0.150, 0.150] }, // bottom-left upper
        { id: 'p1L-4', rect: [0.009, 0.440, 0.150, 0.150] }, // bottom-left lower
        { id: 'p1L-5', rect: [0.171, 0.276, 0.319, 0.314] }, // bottom-right large
      ],
      desc: {
        rect: [0.009, 0.612, 0.481, 0.360],
        type: { font: 'serif', sizePt: 16, leadingPt: 22, align: 'justify' },
      },
    },

    // no description -> 6-photo collage filling the column (1 + 2 + 3)
    collage6: {
      id: 'left-collage6',
      column: LEFT,
      bands: [
        { id: 'p1L-big', kind: 'photos', slots: row(['p1L-1'], { aspect: 1.78 }),
          growWeight: 0, gapAfter: 0.015 },
        { id: 'p1L-mid', kind: 'photos', slots: row(['p1L-2', 'p1L-3'], { aspect: 1.30, gap: 0.015 }),
          growWeight: 0, gapAfter: 0.015 },
        { id: 'p1L-bot', kind: 'photos', slots: row(['p1L-4', 'p1L-5', 'p1L-6'], { aspect: 1.16, gap: 0.013 }),
          growWeight: 0, gapAfter: 0 },
      ],
      // any small leftover is spread into the two gapAfter values
      slackToGaps: true,
    },
  };

  // ================================================================
  //  AGENT BLOCK VARIANTS
  //  chosen by:  agentInfo2 present?  ->  dual | single
  //  Rendered inside geometry.page1Right.agentBandRect. Logo + QR are a
  //  single shared copy in both.
  // ================================================================
  // Colour rule (from the LYF / Starlink references): BROKERAGE lines
  // (brokerage name, address, "ONLINE TOUR") are white (token 'ink');
  // AGENT lines (name / title / phone / email) are gold (token 'gold').
  // On the light "marble" theme the renderer's tokens already flip.
  var SERIF = 'serif';
  var BROKER_NAME  = { font: SERIF, sizePt: 15, weight: 400, token: 'ink' };
  var BROKER_LINE  = { font: SERIF, sizePt: 12, weight: 400, token: 'ink' };
  var AGENT_NAME   = { font: SERIF, sizePt: 23, weight: 700, token: 'gold' };
  var AGENT_TITLE  = { font: SERIF, sizePt: 13, weight: 400, token: 'gold' };
  var AGENT_LINE   = { font: SERIF, sizePt: 13, weight: 400, token: 'gold' };
  var QR_CAPTION   = { font: SERIF, sizePt: 11, weight: 400, tracking: 0.12, token: 'ink' };

  // ---------------------------------------------------------------
  //  The agent + brokerage area is a set of INDEPENDENT boxes. Each has
  //  a default rect (fraction of the agent band); Franky can drag it
  //  (project.boxOffsets[key]) and scale it (project.boxSizes[key]) in
  //  the ?admin= view. Agents just see the final positions.
  // ---------------------------------------------------------------
  function nameBox(ref, align) {
    return { key: ref + '-name', kind: 'stack', align: align || 'center', lines: [
      { field: ref + '.name', nowrap: true, type: AGENT_NAME },
      { field: ref + '.credentials', wrap: true, type: AGENT_TITLE },
    ] };
  }
  // single: Mobile / Office / Email (Office = the brokerage number, shown
  // with the agent's details as in the LYF reference).
  function contactBoxFull(ref, align) {
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Mobile: ', field: ref + '.cellPhone', fmt: 'phone', type: AGENT_LINE },
      { label: 'Office: ', field: 'agentInfo.brokerageOffice', fmt: 'phone', type: AGENT_LINE },
      { label: 'Email: ', field: ref + '.email', wrap: true, type: AGENT_LINE },
    ] };
  }
  // dual: Tel / Email only (Starlink reference).
  function contactBoxLite(ref, align) {
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Tel: ', field: ref + '.cellPhone', fmt: 'phone', type: AGENT_LINE },
      { label: 'Email: ', field: ref + '.email', wrap: true, type: AGENT_LINE },
    ] };
  }
  var logoBox = { key: 'logo', kind: 'image', img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo' };
  var brokerNameBox = { key: 'broker-name', kind: 'stack', align: 'center', lines: [
    { field: 'agentInfo.brokerage', type: BROKER_NAME },
  ] };
  var brokerAddrBox = { key: 'broker-address', kind: 'stack', align: 'center', lines: [
    { field: 'agentInfo.brokerageAddress', wrap: true, type: BROKER_LINE },
  ] };
  var tourBox = { key: 'online-tour', kind: 'qr', qr: 'propertyInfo.onlineTourUrl',
    caption: 'ONLINE TOUR', captionType: QR_CAPTION };
  function headshotBox(ref, key) { return { key: key, kind: 'headshot', ref: ref }; }

  var agentBlock = {
    // LYF / Kevin Zhao reference: logo + brokerage + address (left) ·
    // name + title + Mobile/Office/Email (centre) · QR bottom-left of the
    // headshot · headshot full-height cover, bleeding off the right edge.
    single: {
      id: 'agent-single',
      boxes: [
        assign(logoBox,        { rect: [0.00, 0.02, 0.32, 0.34] }),
        assign(brokerNameBox,  { rect: [0.00, 0.36, 0.34, 0.16] }),
        assign(brokerAddrBox,  { rect: [0.00, 0.55, 0.34, 0.42] }),
        assign(nameBox('agentInfo', 'center'),     { rect: [0.34, 0.03, 0.36, 0.36] }),
        assign(contactBoxFull('agentInfo', 'left'), { rect: [0.36, 0.42, 0.35, 0.55] }),
        assign(tourBox,        { rect: [0.65, 0.54, 0.15, 0.44] }),
        assign(headshotBox('agentInfo', 'headshot1'), { rect: [0.80, 0.00, 0.20, 1.00] }),
      ],
    },
    // Starlink / Mo Zhang + June Liu reference: headshots bleed off both
    // edges · name+title just inside each · logo + address + QR stacked
    // centre · each agent's Tel/Email under their name.
    dual: {
      id: 'agent-dual',
      boxes: [
        assign(headshotBox('agentInfo', 'headshot1'),  { rect: [0.00, 0.02, 0.155, 0.96] }),
        assign(nameBox('agentInfo', 'center'),          { rect: [0.155, 0.14, 0.22, 0.36] }),
        assign(contactBoxLite('agentInfo', 'left'),     { rect: [0.155, 0.56, 0.24, 0.34] }),
        assign(logoBox,        { rect: [0.39, 0.00, 0.22, 0.42] }),
        assign(brokerAddrBox,  { rect: [0.35, 0.40, 0.30, 0.22] }),
        assign(tourBox,        { rect: [0.44, 0.60, 0.12, 0.40] }),
        assign(contactBoxLite('agentInfo2', 'right'),   { rect: [0.545, 0.56, 0.24, 0.34] }),
        assign(nameBox('agentInfo2', 'center'),          { rect: [0.625, 0.14, 0.22, 0.36] }),
        assign(headshotBox('agentInfo2', 'headshot2'),  { rect: [0.845, 0.02, 0.155, 0.96] }),
      ],
    },
  };

  function assign(a, b) { return Object.assign({}, a, b); }

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
