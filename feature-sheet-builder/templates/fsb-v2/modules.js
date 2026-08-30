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
  var agentBlock = {
    // Kevin-9 layout: LEFT = logo (top) + brokerage name + office address
    // + QR;  MIDDLE = agent name + credentials + phones/email;
    // RIGHT = headshot, tall portrait, full height.
    single: {
      id: 'agent-single',
      cols: [
        { id: 'brand', wFrac: 0.36, kind: 'stack', lines: [
          { img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo', hFrac: 0.34 },
          { field: 'agentInfo.brokerage', type: { font: 'sans', sizePt: 8.5, weight: 600, token: 'inkMuted' } },
          { field: 'agentInfo.brokerageAddress', type: { font: 'sans', sizePt: 8, token: 'inkMuted' } },
          { qr: 'propertyInfo.onlineTourUrl' },
        ] },
        { id: 'detail', wFrac: 0.40, kind: 'stack', lines: [
          { field: 'agentInfo.name', type: { font: 'serif', sizePt: 17, weight: 700, token: 'gold', tracking: 0.03 } },
          { field: 'agentInfo.credentials', type: { font: 'sans', sizePt: 9, token: 'inkMuted' } },
          { spacer: 0.02 },
          { compose: ['Mobile: ', 'agentInfo.cellPhone'], type: { font: 'sans', sizePt: 9 } },
          { compose: ['Office: ', 'agentInfo.busPhone'], type: { font: 'sans', sizePt: 9 } },
          { compose: ['Email: ', 'agentInfo.email'], type: { font: 'sans', sizePt: 9 } },
        ] },
        { id: 'headshot', wFrac: 0.24, kind: 'headshot', aspect: 0.62, ref: 'agentInfo', fullHeight: true },
      ],
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
          { img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo', hFrac: 0.24 },
          { qr: 'propertyInfo.onlineTourUrl' },
        ] },
        { id: 'headshot2', wFrac: 0.20, kind: 'headshot', aspect: 0.62, ref: 'agentInfo2' },
      ],
    },
  };

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
