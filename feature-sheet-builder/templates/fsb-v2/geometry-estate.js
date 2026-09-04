/*
 * FranVision Feature Sheet Builder -- "Estate" layout geometry
 * ==========================================================
 *
 * A second layout for fsb-v2 (the first being ./geometry.js). Selected when
 * a theme carries `layout: 'jason'` (e.g. estate-navy). SINGLE AGENT only.
 *
 * Every rect is [x, y, w, h] as a fraction (0..1) of the 1224 x 792 pt trim,
 * origin top-left. Lifted 1:1 from `Feature Sheet Template/Jason/Jason.idml`
 * via tools/idml_parse.py -- NOT eyeballed. Page 1 = outside spread
 * (back cover | front cover), page 2 = inside spread (2 photo panels).
 *
 * Artwork layers: each is a full 1224x792 PNG placed into a clipping
 * `frame` with the source scaled/offset per `img` (both page-normalised),
 * reproducing InDesign's fill-frame crop exactly.
 *   estate-bg-navy.jpg  -- velvet ground, both pages (asset from the theme)
 *   estate-chevron.png  -- downward metal chevron, page 1
 *   estate-metalbar.png -- brushed metal, page 1 (contact bar) + page 2 (mid band)
 *
 * All text is white (theme `ink`). Fonts map to the shared fsb-v2 stack
 * (script / sans / serif) -- the IDML's face names are broken substitutions.
 */
(function (root) {
  'use strict';

  var CHEVRON = '/template-assets/fsb-v2/assets/estate-chevron.png';
  var METALBAR = '/template-assets/fsb-v2/assets/estate-metalbar.png';

  var ESTATE = {
    id: 'estate',
    layout: 'jason',
    page: { trimWidthPt: 1224, trimHeightPt: 792, count: 2, foldX: 0.5 },
    whiteFrameWeightPt: 4,          // the white double-keyline around every photo group

    // ---- artwork layers, in paint order (ground first) ----------------
    // `bg` layers take their asset from the theme; chevron / metalbar are
    // layout constants shared by every Estate colour.
    artwork: {
      page1: [
        { kind: 'bg',       frame: [-0.0082, -0.0098, 1.0141, 1.0269], img: [-0.0078, -0.7088, 1.0133, 2.4249] },
        { kind: 'metalbar', asset: METALBAR, frame: [-0.0082, 0.8014, 0.4701, 0.1634], img: [-0.0217, 0.6413, 0.4835, 0.4835] },
        { kind: 'chevron',  asset: CHEVRON,  frame: [0.4941, 0.6887, 0.5124, 0.2331], img: [0.4944, 0.5491, 0.5095, 0.5124] },
      ],
      page2: [
        { kind: 'bg',       frame: [-0.0071, -0.0131, 1.0141, 1.0229], img: [-0.0067, -0.7141, 1.0133, 2.4249] },
        { kind: 'metalbar', asset: METALBAR, frame: [-0.0071, 0.3944, 1.0144, 0.3000], img: [-0.0956, -0.0504, 1.1897, 1.1897] },
      ],
    },

    // ================= PAGE 1 ==========================================
    page1: {
      // -- back cover (left) --
      collageFrame: [0.0076, 0.0473, 0.4756, 0.5665],   // white double keyline
      // IDML's raw right-column widths (c2/c5) left them ~2-3pt tighter
      // against the frame's right edge than the left column (c1/c3/c4) sits
      // against the left edge -- c2.width/c5.width trimmed by 0.0025 so both
      // sides clear the keyline by the same margin (left column's gap).
      collage: [
        { id: 'p1-c1', rect: [0.0128, 0.0568, 0.2303, 0.2429] },  // top-left
        { id: 'p1-c2', rect: [0.2502, 0.0568, 0.2278, 0.2429] },  // top-right
        { id: 'p1-c3', rect: [0.0128, 0.3114, 0.1625, 0.1414] },  // mid-left
        { id: 'p1-c4', rect: [0.0128, 0.4604, 0.1625, 0.1414] },  // low-left
        { id: 'p1-c5', rect: [0.1826, 0.3114, 0.2954, 0.2904] },  // big-right
      ],
      // justified; auto-fits (8-14pt) so the copy fills the box. Box height
      // trimmed to 0.152 (bottom 0.781) to leave a clear gap above the
      // metal bar (top 0.8014).
      description: { rect: [0.0083, 0.6289, 0.4735, 0.1520], font: 'serif', align: 'justify',
        fitMin: 8, fitMax: 14, fitLead: 1.3, bind: 'propertyInfo.description' },

      // brushed-metal contact bar (art layer sits behind these)
      backName:    { rect: [0.0294, 0.8173, 0.2322, 0.0445], font: 'sans', align: 'left', sizePt: 28, bind: 'agentInfo.name' },
      backContact: { rect: [0.0294, 0.8579, 0.3065, 0.0969], font: 'sans', align: 'left', sizePt: 13, leadingPt: 16 },
      qr:          { rect: [0.3631, 0.8373, 0.0586, 0.0906], source: 'agentInfo.onlineTourUrl' },
      qrCaption:   { rect: [0.3669, 0.9289, 0.0509, 0.0191], font: 'sans', align: 'left', sizePt: 9, text: 'ONLINE TOUR' },

      // -- front cover (right) --
      hero: { id: 'p1-hero', rect: [0.5000, 0.1941, 0.4983, 0.5210] },
      address: {
        // IDML is 43 / 33 pt; nudged up ~12% so the substitute `script`
        // face reads at the original's visual weight.
        rect: [0.5424, 0.0683, 0.4143, 0.1100], font: 'script', align: 'center',
        line1: { bind: 'propertyInfo.address', sizePt: 48 },
        gapPt: 37,
        line2: { bind: 'propertyInfo.city', sizePt: 37 },
      },
      // circular headshot straddling the chevron's left edge
      headshot: {
        plateRect: [0.5237, 0.7759, 0.0929, 0.1436],   // White.png ring/plate
        photoRect: [0.5246, 0.7773, 0.0912, 0.1409],   // headshot photo, circle-clipped
      },
      // agent name + phone sitting on the chevron
      chevronName: {
        rect: [0.6103, 0.7409, 0.2785, 0.0856], font: 'sans', align: 'center',
        line1: { bind: 'agentInfo.name', sizePt: 30 },
        line2: { bind: 'agentInfo.credentials', sizePt: 11 },
      },
      chevronPhone: { rect: [0.6677, 0.8327, 0.1637, 0.0503], font: 'sans', align: 'center', sizePt: 23, bind: 'agentInfo.cellPhone' },
      logo:  { rect: [0.9013, 0.7984, 0.0559, 0.0880] },   // brokerage logo plate
      // bottom-centre line: brokerage name, uppercased + tracked (was "SMART SOLD REALTY")
      footer: {
        rect: [0.6314, 0.9648, 0.2378, 0.0322], font: 'sans', align: 'center',
        sizePt: 16, leadingPt: 14, tracking: 0.1, transform: 'uppercase',
        bind: 'agentInfo.brokerage',
      },
    },

    // ================= PAGE 2 ==========================================
    page2: {
      panelFrame: [
        { panel: 'L', rect: [0.0124, 0.0392, 0.4756, 0.9195] },
        { panel: 'R', rect: [0.5140, 0.0392, 0.4756, 0.9195] },
      ],
      slots: [
        { id: 'p2L-hero', panel: 'L', rect: [0.0188, 0.0500, 0.4626, 0.4763] },
        { id: 'p2L-1', panel: 'L', rect: [0.0188, 0.5428, 0.2259, 0.2005] },
        { id: 'p2L-2', panel: 'L', rect: [0.2553, 0.5428, 0.2259, 0.2005] },
        { id: 'p2L-3', panel: 'L', rect: [0.0188, 0.7500, 0.2259, 0.2005] },
        { id: 'p2L-4', panel: 'L', rect: [0.2553, 0.7500, 0.2259, 0.2005] },

        { id: 'p2R-hero', panel: 'R', rect: [0.5200, 0.0495, 0.4626, 0.4763] },
        { id: 'p2R-1', panel: 'R', rect: [0.5200, 0.5422, 0.2259, 0.2005] },
        { id: 'p2R-2', panel: 'R', rect: [0.7565, 0.5422, 0.2259, 0.2005] },
        { id: 'p2R-3', panel: 'R', rect: [0.5200, 0.7500, 0.2259, 0.2005] },
        { id: 'p2R-4', panel: 'R', rect: [0.7565, 0.7500, 0.2259, 0.2005] },
      ],
    },
  };

  // every photo slot id, in reading order (used by registry.slotIds)
  ESTATE.slotIds = ESTATE.page1.collage.map(function (c) { return c.id; })
    .concat([ESTATE.page1.hero.id])
    .concat(ESTATE.page2.slots.map(function (s) { return s.id; }));

  if (typeof module !== 'undefined' && module.exports) module.exports = ESTATE;
  if (root) root.FSB_V2_GEOMETRY_ESTATE = ESTATE;
})(typeof window !== 'undefined' ? window : null);
