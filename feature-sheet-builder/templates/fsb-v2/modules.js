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


  // ================================================================
  //  LEFT COLUMN VARIANTS
  //  chosen by:  description filled?  ->  stagger5 (+desc) | collage6
  // ================================================================
  // Both variants use EXPLICIT rects taken straight from the IDML
  // (3361 = with-description master, Kevin-9 = no-description master),
  // as fractions of the trim. No band solver -- the source files place
  // these by hand and the photo proportions are the whole point.
  var leftColumn = {
    // HAS description -> ONE wide photo up top, then a tall justified
    // description filling the column (3361: photo u153, desc frame u6a1).
    // topPhotoStyle:'paired' swaps the single top photo for two half-width
    // ones (registry picks `photosPaired`).
    stagger5: {
      id: 'left-hero-desc',
      column: LEFT,
      explicit: true,
      photos: [
        { id: 'p1L-1', rect: [0.009, 0.016, 0.481, 0.384] },
      ],
      photosPaired: [
        { id: 'p1L-1', rect: [0.009, 0.016, 0.233, 0.300] },
        { id: 'p1L-2', rect: [0.257, 0.016, 0.233, 0.300] },
      ],
      desc: {
        rect: [0.008, 0.420, 0.484, 0.300],
        type: { font: 'serif', sizePt: 15, leadingPt: 20, align: 'justify' },
      },
    },

    // no description -> 6-photo collage (Kevin-9: u153 / uf5d / uf63 /
    // ufd9 / uf68 / uf6d). 1 wide across the top, 2 side-by-side, then a
    // small stack on the left + one larger frame on the right.
    collage6: {
      id: 'left-collage6',
      column: LEFT,
      explicit: true,
      photos: [
        { id: 'p1L-1', rect: [0.009, 0.026, 0.481, 0.378] }, // top wide
        { id: 'p1L-2', rect: [0.009, 0.415, 0.237, 0.265] }, // mid left
        { id: 'p1L-3', rect: [0.253, 0.415, 0.237, 0.265] }, // mid right
        { id: 'p1L-4', rect: [0.009, 0.692, 0.156, 0.137] }, // bot-left upper
        { id: 'p1L-5', rect: [0.009, 0.836, 0.156, 0.137] }, // bot-left lower
        { id: 'p1L-6', rect: [0.170, 0.692, 0.320, 0.282] }, // bot-right large
      ],
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
      { label: 'Email: ', field: ref + '.email', nowrap: true, fitShrink: true, type: AGENT_LINE },
    ] };
  }
  // dual (Starlink): Tel / Email only
  function contactBoxLite(ref, align) {
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Tel: ', field: ref + '.cellPhone', fmt: 'phone', nowrap: true, type: AGENT_LINE },
      { label: 'Email: ', field: ref + '.email', nowrap: true, fitShrink: true, type: AGENT_LINE },
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
        assign(contactBoxFull('agentInfo', 'left'), { rect: [0.362, 0.470, 0.330, 0.470] }),
        assign(tourBox,        { rect: [0.695, 0.640, 0.078, 0.315] }),
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
        assign(nameBox('agentInfo', 'center', AGENT_NAME_DUAL), { rect: [0.176, 0.120, 0.260, 0.320] }),
        assign(contactBoxLite('agentInfo', 'left'),            { rect: [0.176, 0.520, 0.260, 0.460] }),
        assign(logoBox,                                        { rect: [0.400, 0.030, 0.200, 0.320] }),
        assign(brokerAddrBox,                                  { rect: [0.360, 0.360, 0.280, 0.170], align: 'center' }),
        assign(tourBox,                                        { rect: [0.440, 0.575, 0.120, 0.360] }),
        assign(nameBox('agentInfo2', 'center', AGENT_NAME_DUAL),{ rect: [0.575, 0.120, 0.260, 0.320] }),
        assign(contactBoxLite('agentInfo2', 'left'),           { rect: [0.575, 0.520, 0.260, 0.460] }),
        assign(headshotBox('agentInfo2', 'headshot2'),         { rect: [0.836, 0.033, 0.170, 0.898] }),
      ],
    },
  };

  function assign(a, b) { return Object.assign({}, a, b); }

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
