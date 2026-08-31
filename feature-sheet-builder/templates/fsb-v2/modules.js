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
  // Box rects + type sizes below are TAKEN FROM THE IDML (Kevin-9 single
  // card, 3361 dual bar), converted to fractions of the agent band. Sizes
  // are the real point sizes at trim scale. Colour: brokerage lines use
  // 'ink' (white on navy/burgundy, dark on marble -- flips already);
  // agent lines use 'agentText' (gold on navy/burgundy, dark on marble,
  // per the LYF reference).
  var SERIF = 'serif';
  var BROKER_NAME  = { font: 'sans', sizePt: 16, weight: 600, token: 'ink' };   // "LYF Realty, Brokerage" 17pt 等线
  var BROKER_LINE  = { font: SERIF, sizePt: 15, weight: 400, token: 'ink' };     // address 17pt
  var AGENT_NAME   = { font: SERIF, sizePt: 28, weight: 600, token: 'agentText' }; // "Kevin Zhao" 30pt
  var AGENT_TITLE  = { font: SERIF, sizePt: 12, weight: 400, token: 'agentText' }; // "Broker of Record" 11pt
  var AGENT_LINE   = { font: SERIF, sizePt: 15, weight: 400, token: 'agentText' }; // contact 15-17pt
  var QR_CAPTION   = { font: SERIF, sizePt: 8, weight: 400, tracking: 0.06, token: 'ink' };

  var AGENT_NAME_DUAL = { font: SERIF, sizePt: 22, weight: 600, token: 'agentText' }; // 3361 bar: 2 names side-by-side, tighter
  function nameBox(ref, align, nameType) {
    return { key: ref + '-name', kind: 'stack', align: align || 'center', lines: [
      { field: ref + '.name', nowrap: true, type: nameType || AGENT_NAME },
      { field: ref + '.credentials', wrap: true, type: AGENT_TITLE },
    ] };
  }
  // single (LYF): Mobile / Office / Email  (Office = brokerage number)
  function contactBoxFull(ref, align) {
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Mobile: ', field: ref + '.cellPhone', fmt: 'phone', nowrap: true, type: AGENT_LINE },
      { label: 'Office: ', field: 'agentInfo.brokerageOffice', fmt: 'phone', nowrap: true, type: AGENT_LINE },
      { label: 'Email: ', field: ref + '.email', wrap: true, type: AGENT_LINE },
    ] };
  }
  // dual (Starlink): Tel / Email only
  function contactBoxLite(ref, align) {
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Tel: ', field: ref + '.cellPhone', fmt: 'phone', nowrap: true, type: AGENT_LINE },
      { label: 'Email: ', field: ref + '.email', wrap: true, type: AGENT_LINE },
    ] };
  }
  var logoBox = { key: 'logo', kind: 'image', img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo' };
  var brokerNameBox = { key: 'broker-name', kind: 'stack', align: 'left', lines: [
    { field: 'agentInfo.brokerage', type: BROKER_NAME },
  ] };
  var brokerAddrBox = { key: 'broker-address', kind: 'stack', align: 'left', lines: [
    { field: 'agentInfo.brokerageAddress', wrap: true, type: BROKER_LINE },
  ] };
  var tourBox = { key: 'online-tour', kind: 'qr', qr: 'propertyInfo.onlineTourUrl',
    caption: 'ONLINE TOUR', captionType: QR_CAPTION };
  function headshotBox(ref, key) { return { key: key, kind: 'headshot', ref: ref }; }

  var agentBlock = {
    // SINGLE = Kevin-9 / LYF card (measured): logo top-left, brokerage
    // name under it, address bottom-left, agent name + Mobile/Office/Email
    // centred vertically in the middle column, headshot far-right portrait.
    single: {
      id: 'agent-single',
      boxes: [
        assign(logoBox,        { rect: [0.028, 0.010, 0.300, 0.380] }),
        assign(brokerNameBox,  { rect: [0.034, 0.410, 0.320, 0.130] }),
        assign(brokerAddrBox,  { rect: [0.034, 0.660, 0.320, 0.300] }),
        assign(nameBox('agentInfo', 'center'),      { rect: [0.360, 0.140, 0.380, 0.340] }),
        assign(contactBoxFull('agentInfo', 'left'), { rect: [0.375, 0.510, 0.235, 0.430] }),
        assign(tourBox,        { rect: [0.648, 0.560, 0.120, 0.380] }),
        assign(headshotBox('agentInfo', 'headshot1'), { rect: [0.775, 0.004, 0.221, 0.960] }),
      ],
    },
    // DUAL = 3361 bar (measured): [h1] [Mo name] [logo] [June name] [h2],
    // address centred under the logo, each agent's Tel/Email below their
    // name. Headshots inset (not bleeding).
    dual: {
      id: 'agent-dual',
      boxes: [
        assign(headshotBox('agentInfo', 'headshot1'),          { rect: [0.004, 0.033, 0.170, 0.898] }),
        assign(nameBox('agentInfo', 'center', AGENT_NAME_DUAL), { rect: [0.180, 0.120, 0.250, 0.320] }),
        assign(contactBoxLite('agentInfo', 'left'),            { rect: [0.180, 0.540, 0.235, 0.440] }),
        assign(logoBox,                                        { rect: [0.400, 0.030, 0.200, 0.320] }),
        assign(brokerAddrBox,                                  { rect: [0.360, 0.360, 0.280, 0.170], align: 'center' }),
        assign(tourBox,                                        { rect: [0.435, 0.560, 0.130, 0.380] }),
        assign(nameBox('agentInfo2', 'center', AGENT_NAME_DUAL),{ rect: [0.640, 0.120, 0.250, 0.320] }),
        assign(contactBoxLite('agentInfo2', 'left'),           { rect: [0.640, 0.540, 0.235, 0.440] }),
        assign(headshotBox('agentInfo2', 'headshot2'),         { rect: [0.836, 0.033, 0.170, 0.898] }),
      ],
    },
  };

  function assign(a, b) { return Object.assign({}, a, b); }

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
