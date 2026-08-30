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
  //  chosen by:  description filled?  ->  hero/pair (topPhotoStyle) | collage6
  // ================================================================
  var leftColumn = {
    // has description + one wide photo on top
    heroDesc: {
      id: 'left-heroDesc',
      column: LEFT,
      bands: [
        { id: 'p1L-top', kind: 'photos', slots: row(['p1L-1'], { aspect: 2.15 }),
          growWeight: 0, gapAfter: 0.024 },
        { id: 'p1L-desc', kind: 'text', field: 'propertyInfo.description',
          minHFrac: 0.26, growWeight: 1,
          type: { font: 'serif', sizePt: 15, leadingPt: 20, align: 'left' } },
      ],
    },

    // has description + two photos side by side on top
    pairDesc: {
      id: 'left-pairDesc',
      column: LEFT,
      bands: [
        { id: 'p1L-top', kind: 'photos', slots: row(['p1L-1', 'p1L-2'], { aspect: 1.10, gap: 0.016 }),
          growWeight: 0, gapAfter: 0.024 },
        { id: 'p1L-desc', kind: 'text', field: 'propertyInfo.description',
          minHFrac: 0.24, growWeight: 1,
          type: { font: 'serif', sizePt: 15, leadingPt: 20, align: 'left' } },
      ],
    },

    // no description -> 6-photo collage filling the column (1 + 2 + 3)
    collage6: {
      id: 'left-collage6',
      column: LEFT,
      bands: [
        { id: 'p1L-big', kind: 'photos', slots: row(['p1L-1'], { aspect: 2.02 }),
          growWeight: 0, gapAfter: 0.016 },
        { id: 'p1L-mid', kind: 'photos', slots: row(['p1L-2', 'p1L-3'], { aspect: 1.42, gap: 0.016 }),
          growWeight: 0, gapAfter: 0.016 },
        { id: 'p1L-bot', kind: 'photos', slots: row(['p1L-4', 'p1L-5', 'p1L-6'], { aspect: 1.34, gap: 0.014 }),
          growWeight: 0, gapAfter: 0 },
      ],
      // leftover vertical slack is spread into the two gapAfter values
      slackToGaps: true,
    },
  };

  // ================================================================
  //  AGENT BLOCK VARIANTS
  //  chosen by:  agentInfo2 present?  ->  dual | single
  //  Rendered inside geometry.page1Right.agentBandRect. Logo + QR are a
  //  single shared copy in both.
  // ================================================================
  var agentBlock = {
    single: {
      id: 'agent-single',
      // business-card style: logo (left) | name+title+phones (mid) | headshot (right)
      cols: [
        { id: 'logo', wFrac: 0.30, kind: 'logo' },
        { id: 'detail', wFrac: 0.44, kind: 'stack', lines: [
          { field: 'agentInfo.name', type: { font: 'serif', sizePt: 17, weight: 700, token: 'gold', tracking: 0.04 } },
          { field: 'agentInfo.credentials', type: { font: 'sans', sizePt: 9, token: 'inkMuted' } },
          { field: 'agentInfo.brokerage', type: { font: 'sans', sizePt: 9, token: 'inkMuted' } },
          { field: 'agentInfo.brokerageAddress', type: { font: 'sans', sizePt: 8.5, token: 'inkMuted' } },
          { compose: ['Mobile: ', 'agentInfo.cellPhone'], type: { font: 'sans', sizePt: 9 } },
          { compose: ['Office: ', 'agentInfo.busPhone'], type: { font: 'sans', sizePt: 9 } },
          { compose: ['Email: ', 'agentInfo.email'], type: { font: 'sans', sizePt: 9 } },
        ] },
        { id: 'headshot', wFrac: 0.26, kind: 'headshot', aspect: 0.78 },
      ],
      qr: { anchor: 'detail-bottom', sizeFrac: 0.05, count: [0, 2], source: 'propertyInfo.onlineTourUrl' },
    },

    dual: {
      id: 'agent-dual',
      // 2 headshots flank a centred "Presented By" + shared logo below
      cols: [
        { id: 'headshot1', wFrac: 0.20, kind: 'headshot', aspect: 0.62, ref: 'agentInfo' },
        { id: 'center', wFrac: 0.60, kind: 'stack', align: 'center', lines: [
          { text: 'PRESENTED BY', type: { font: 'sans', sizePt: 10, weight: 600, tracking: 0.14, token: 'gold' } },
          { compose: ['agentInfo.name', ' & ', 'agentInfo2.name'], type: { font: 'serif', sizePt: 15, weight: 700 } },
          { field: 'agentInfo.brokerage', type: { font: 'sans', sizePt: 9, token: 'inkMuted' } },
          { field: 'agentInfo.brokerageAddress', type: { font: 'sans', sizePt: 8.5, token: 'inkMuted' } },
        ], logoBelow: true },
        { id: 'headshot2', wFrac: 0.20, kind: 'headshot', aspect: 0.62, ref: 'agentInfo2' },
      ],
      // per-agent phone shown as a gold chip on each headshot's lower edge
      headshotChip: { fields: ['cellPhone'], type: { font: 'sans', sizePt: 8.5, weight: 600 } },
      qr: { anchor: 'center-bottom', sizeFrac: 0.045, count: [0, 2], source: 'propertyInfo.onlineTourUrl' },
    },
  };

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
