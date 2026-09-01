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
    // HAS description -> 5-photo staggered collage across the top ~60% of
    // the column (2 across, then 2 stacked left + 1 large right), then a
    // justified description that AUTO-FITS (font 10-20pt + leading up to
    // ~1.9x, done by fitTexts) to fill the rest -- so photos + copy end
    // up evenly filling the whole left page.
    stagger5: {
      id: 'left-stagger5',
      column: LEFT,
      explicit: true,
      photos: [
        { id: 'p1L-1', rect: [0.009, 0.026, 0.230, 0.232] }, // top-left
        { id: 'p1L-2', rect: [0.253, 0.026, 0.237, 0.232] }, // top-right
        { id: 'p1L-3', rect: [0.009, 0.276, 0.150, 0.150] }, // mid-left upper
        { id: 'p1L-4', rect: [0.009, 0.440, 0.150, 0.150] }, // mid-left lower
        { id: 'p1L-5', rect: [0.171, 0.276, 0.319, 0.314] }, // right large
      ],
      photosPaired: [
        { id: 'p1L-1', rect: [0.009, 0.026, 0.230, 0.232] },
        { id: 'p1L-2', rect: [0.253, 0.026, 0.237, 0.232] },
        { id: 'p1L-3', rect: [0.009, 0.276, 0.150, 0.150] },
        { id: 'p1L-4', rect: [0.009, 0.440, 0.150, 0.150] },
        { id: 'p1L-5', rect: [0.171, 0.276, 0.319, 0.314] },
      ],
      desc: {
        rect: [0.009, 0.605, 0.481, 0.367],
        type: { font: 'serif', sizePt: 16, leadingPt: 22, align: 'justify' },
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
  // Font sizes are the EXACT IDML point sizes (Kevin-9 single, 3361 dual).
  var SERIF = 'serif';
  var BROKER_NAME  = { font: 'sans', sizePt: 17, weight: 600, token: 'ink' };    // "LYF Realty, Brokerage" 17pt 等线
  var BROKER_LINE  = { font: SERIF, sizePt: 17, weight: 400, token: 'ink' };     // "333 Denison St, Unit 2" 17pt
  var AGENT_NAME   = { font: SERIF, sizePt: 30, weight: 600, token: 'agentText' }; // "Kevin Zhao" 30pt
  var AGENT_TITLE  = { font: SERIF, sizePt: 11, weight: 400, token: 'agentText' }; // "Broker of Record" 11pt
  var AGENT_LINE   = { font: SERIF, sizePt: 17, weight: 400, token: 'agentText' }; // "Mobile: / Office: / Email:" 17pt
  var AGENT_EMAIL  = { font: SERIF, sizePt: 15, weight: 400, token: 'agentText' }; // "kevin@lyfrealty.com" value 15pt
  var QR_CAPTION   = { font: SERIF, sizePt: 9,  weight: 400, tracking: 0.04, token: 'ink' }; // "Wechat QR" 9pt

  var AGENT_NAME_DUAL = { font: SERIF, sizePt: 17, weight: 600, token: 'agentText' }; // 3361: "Mo Zhang" / "June Liu" 17pt
  var AGENT_LINE_DUAL = { font: SERIF, sizePt: 10, weight: 400, token: 'agentText' }; // 3361: "Tel: / Email:" 10pt

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
      { label: 'Email: ', field: ref + '.email', nowrap: true, fitShrink: true, type: AGENT_EMAIL },
    ] };
  }
  // dual (Starlink): Tel / Email only
  function contactBoxLite(ref, align, lineType) {
    var LT = lineType || AGENT_LINE;
    return { key: ref + '-contact', kind: 'stack', align: align || 'left', lines: [
      { label: 'Tel: ', field: ref + '.cellPhone', fmt: 'phone', nowrap: true, type: LT },
      { label: 'Email: ', field: ref + '.email', nowrap: true, fitShrink: true, type: LT },
    ] };
  }
  var logoBox = { key: 'logo', kind: 'image', img: 'agentInfo.brokerageLogoPhotoId', placeholder: 'Logo' };
  var brokerNameBox = { key: 'broker-name', kind: 'stack', align: 'left', lines: [
    { field: 'agentInfo.brokerage', wrap: true, type: BROKER_NAME },
  ] };
  var brokerAddrBox = { key: 'broker-address', kind: 'stack', align: 'left', lines: [
    { field: 'agentInfo.brokerageAddress', splitAddr: true, type: BROKER_LINE },
  ] };
  var tourBox = { key: 'online-tour', kind: 'qr', qr: 'propertyInfo.onlineTourUrl',
    caption: 'ONLINE TOUR', captionType: QR_CAPTION };
  // aspect = height / width; 4/3 = a 3:4 portrait, independent of the
  // agent band's height / whether the icon row is shown.
  function headshotBox(ref, key) { return { key: key, kind: 'headshot', ref: ref, aspect: 4 / 3 }; }

  // --- dual layout: left-side rects + mirror helpers -----------------
  // mirror() flips a rect across x = 0.5; centred() places a rect of
  // width w symmetrically on the centre line.
  function mirror(r) { return [1 - r[0] - r[2], r[1], r[2], r[3]]; }
  function centred(w, y, h) { return [0.5 - w / 2, y, w, h]; }
  var L_HEADSHOT = [0.003, 0.031, 0.182, 0.898];
  var L_NAME     = [0.106, 0.317, 0.372, 0.278];
  var L_CONTACT  = [0.195, 0.669, 0.245, 0.223];

  // Every rect below is the IDML text/graphic-frame bound converted to a
  // fraction of the agent band. SINGLE = Kevin-9, DUAL = the 3361 bar's
  // internal arrangement, mirrored so the two agents are symmetric. Both
  // sit in the RIGHT-half band by design (like Michelle & Sue); the 3361
  // file parks its bar bottom-left, but we keep the card on the right.
  var agentBlock = {
    single: {
      id: 'agent-single',
      boxes: [
        assign(logoBox,        { rect: [0.028, 0.003, 0.336, 0.479] }),   // u20e
        assign(brokerNameBox,  { rect: [0.071, 0.413, 0.262, 0.128] }),   // u1291
        assign(brokerAddrBox,  { rect: [0.034, 0.643, 0.308, 0.221] }),   // u692
        assign(nameBox('agentInfo', 'center'),      { rect: [0.364, 0.161, 0.365, 0.354] }), // u59a
        assign(contactBoxFull('agentInfo', 'left'), { rect: [0.364, 0.541, 0.419, 0.387] }), // u181
        assign(tourBox,        { rect: [0.648, 0.640, 0.100, 0.330] }),   // low, right of the email; caption drops below the email line
        assign(headshotBox('agentInfo', 'headshot1'), { rect: [0.770, 0.003, 0.224, 0.959] }), // u178
      ],
    },
    // DUAL is mirrored about the vertical centre line (x = 0.5): the
    // right-side rects are `mirror()` of the left-side ones so the two
    // agents' headshots / names / contacts are the same size and equally
    // spaced from the centre; logo, address and QR are centred on 0.5.
    dual: {
      id: 'agent-dual',
      boxes: [
        assign(headshotBox('agentInfo', 'headshot1'),                { rect: L_HEADSHOT }),
        assign(nameBox('agentInfo', 'center', AGENT_NAME_DUAL),       { rect: L_NAME }),
        assign(contactBoxLite('agentInfo', 'left', AGENT_LINE_DUAL),  { rect: L_CONTACT }),
        assign(logoBox,                                              { rect: centred(0.267, 0.037, 0.419) }),
        assign(brokerAddrBox,                                        { rect: centred(0.285, 0.469, 0.223), align: 'center' }),
        assign(tourBox,                                              { rect: centred(0.085, 0.660, 0.330) }),
        assign(nameBox('agentInfo2', 'center', AGENT_NAME_DUAL),      { rect: mirror(L_NAME) }),
        assign(contactBoxLite('agentInfo2', 'left', AGENT_LINE_DUAL), { rect: mirror(L_CONTACT) }),
        assign(headshotBox('agentInfo2', 'headshot2'),               { rect: mirror(L_HEADSHOT) }),
      ],
    },
  };

  function assign(a, b) { return Object.assign({}, a, b); }

  var MODULES = { LEFT: LEFT, RIGHT: RIGHT, leftColumn: leftColumn, agentBlock: agentBlock };

  if (typeof module !== 'undefined' && module.exports) module.exports = MODULES;
  if (root) root.FSB_V2_MODULES = MODULES;
})(typeof window !== 'undefined' ? window : null);
