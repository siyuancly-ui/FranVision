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
  // Colour rule: BROKERAGE block (logo / name / office / address / the
  // "ONLINE TOUR" caption) is white (token 'ink'); AGENT lines (name /
  // title / phone / email) are gold (token 'gold').
  var BROKER_NAME = { font: 'sans', sizePt: 10, weight: 700, token: 'ink' };
  var BROKER_LINE = { font: 'sans', sizePt: 9, token: 'ink' };
  var AGENT_NAME = { font: 'serif', sizePt: 16, weight: 700, token: 'gold' };
  var AGENT_TITLE = { font: 'sans', sizePt: 10.5, token: 'gold' };
  var AGENT_LINE = { font: 'sans', sizePt: 10, token: 'gold' };
  var QR_CAPTION = { font: 'serif', sizePt: 9, tracking: 0.14, token: 'ink' };

  function brokerCenter(withOffice) {
    return [
      { img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo', hFrac: 0.30, resizeKey: 'logo' },
      { field: 'agentInfo.brokerage', type: BROKER_NAME },
      { label: 'Office: ', field: 'agentInfo.brokerageOffice', fmt: 'phone', type: BROKER_LINE },
      { field: 'agentInfo.brokerageAddress', wrap: true, type: BROKER_LINE },
      { qr: 'propertyInfo.onlineTourUrl', caption: 'ONLINE TOUR', captionType: QR_CAPTION, resizeKey: 'qr' },
    ];
  }

  var agentBlock = {
    // single agent: [ brokerage centre-left | agent detail | headshot ]
    single: {
      id: 'agent-single',
      cols: [
        { id: 'brand', wFrac: 0.36, kind: 'stack', align: 'center', lines: brokerCenter() },
        { id: 'detail', wFrac: 0.40, kind: 'stack', lines: [
          { field: 'agentInfo.name', type: AGENT_NAME },
          { field: 'agentInfo.credentials', type: AGENT_TITLE },
          { spacer: 0.015 },
          { label: 'Tel: ', field: 'agentInfo.cellPhone', fmt: 'phone', type: AGENT_LINE },
          { label: 'Email: ', field: 'agentInfo.email', type: AGENT_LINE },
        ] },
        { id: 'headshot', wFrac: 0.24, kind: 'headshot', aspect: 0.62, ref: 'agentInfo',
          fullHeight: true, resizeKey: 'headshot1' },
      ],
    },

    // co-listing (the "Mo Zhang / June Liu" reference):
    //   [headshot1] [name+title+contact, hugging h1] [brokerage centre]
    //   [name+title+contact, hugging h2] [headshot2]
    dual: {
      id: 'agent-dual',
      cols: [
        { id: 'headshot1', wFrac: 0.15, kind: 'headshot', aspect: 0.78, ref: 'agentInfo',
          fullHeight: true, resizeKey: 'headshot1' },
        { id: 'label1', wFrac: 0.19, kind: 'stack', align: 'left', lines: [
          { field: 'agentInfo.name', nowrap: true, type: AGENT_NAME },
          { field: 'agentInfo.credentials', type: AGENT_TITLE },
          { spacer: 0.012 },
          { label: 'Tel: ', field: 'agentInfo.cellPhone', fmt: 'phone', type: { font: 'sans', sizePt: 8.5, token: 'gold' } },
          { label: 'Email: ', field: 'agentInfo.email', wrap: true, type: { font: 'sans', sizePt: 8.5, token: 'gold' } },
        ] },
        { id: 'center', wFrac: 0.32, kind: 'stack', align: 'center', lines: brokerCenter() },
        { id: 'label2', wFrac: 0.19, kind: 'stack', align: 'right', lines: [
          { field: 'agentInfo2.name', nowrap: true, type: AGENT_NAME },
          { field: 'agentInfo2.credentials', type: AGENT_TITLE },
          { spacer: 0.012 },
          { label: 'Tel: ', field: 'agentInfo2.cellPhone', fmt: 'phone', type: { font: 'sans', sizePt: 8.5, token: 'gold' } },
          { label: 'Email: ', field: 'agentInfo2.email', wrap: true, type: { font: 'sans', sizePt: 8.5, token: 'gold' } },
        ] },
        { id: 'headshot2', wFrac: 0.15, kind: 'headshot', aspect: 0.78, ref: 'agentInfo2',
          fullHeight: true, resizeKey: 'headshot2' },
      ],
    },
  };

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
