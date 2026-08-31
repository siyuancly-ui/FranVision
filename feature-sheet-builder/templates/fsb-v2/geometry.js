/*
 * FranVision Feature Sheet Builder -- v2 shared geometry
 * =====================================================
 *
 * ONE geometry, shared by all 3 colour themes (navy / marble / burgundy).
 * Derived from the 5 original InDesign files in `Feature Sheet Template/`
 * (120, 3361 = "全新蓝色版本", Kevin-9, "Michelle & Sue", Sue) via
 * ./tools/idml_parse.py.  Every rect is [x, y, w, h] as a fraction (0..1)
 * of the TRIM box (1224 x 792 pt = 17 x 11 in landscape spread), origin
 * top-left.  Pasteboard/scratch items in the source files (x<0 or x>1)
 * are excluded.
 *
 * The finished piece = one 11x17 sheet folded once at the centre (x=0.5),
 * 4 panels.  "page 1" spread = outside (back cover | front cover),
 * "page 2" spread = inside (left | right).
 *
 * Page-1 LEFT column and the agent block are conditional -- see
 * ./modules.js.  This file holds the fixed frame + the page-1 right
 * column + all of page 2.
 */
(function (root) {
  'use strict';

  var PT_PER_IN = 72;
  var MM = 1 / 25.4;

  var GEOMETRY = {
    id: 'fsb-v2',

    page: {
      trimWidthPt: 17 * PT_PER_IN,   // 1224
      trimHeightPt: 11 * PT_PER_IN,  // 792
      bleedPt: 3 * MM * PT_PER_IN,   // 8.5039  (0.1181 in)
      safeMarginPt: 20 * MM * PT_PER_IN, // 56.693 (0.7874 in)
      cropMarkPt: { offset: 8, length: 20, weight: 0.5 }, // drawn as vector on export
      foldX: 0.5,
      count: 2,
      get aspect() { return this.trimWidthPt / this.trimHeightPt; },
    },

    // bleed / safe as page fractions, for convenience
    get bleedFrac() {
      return {
        x: this.page.bleedPt / this.page.trimWidthPt,   // ~0.006948
        y: this.page.bleedPt / this.page.trimHeightPt,  // ~0.010737
      };
    },
    get safeFrac() {
      return {
        x: this.page.safeMarginPt / this.page.trimWidthPt,  // ~0.046318
        y: this.page.safeMarginPt / this.page.trimHeightPt, // ~0.071582
      };
    },

    // ================================================================
    //  PAGE 1 -- RIGHT column (front cover). Same across all variants;
    //  the master (3361 / layout A) nudges address+hero down, handled
    //  by the left-column module choice, not here.
    // ================================================================
    page1Right: {
      address: {
        rect: [0.539, 0.016, 0.414, 0.110],
        // line 1 = street address (serif), line 2 = city (spaced)
        // swashy italic calligraphic serif (see "20 Lord Melborne St" ref)
        // IDML: Kevin-9 "20 Lord Melborne St" 49pt / "Markham" 24pt.
        addressType: { font: 'script', sizePt: 49, weight: 500, align: 'center', tracking: 0, italic: false },
        cityType: { font: 'script', sizePt: 24, weight: 500, align: 'center', tracking: 0.04, italic: false },
      },

      hero: {
        rect: [0.504, 0.134, 0.492, 0.505],
        // gold double keyline, ~5pt in source
        border: { widthPt: 5, token: 'goldLine', double: true, radiusPt: 4 },
      },

      // bed / bath / garage. Horizontal group, centred in the right half.
      // Each entry = icon glyph + value text. Any value blank -> that
      // entry is dropped and the rest re-centre (see modules/reflow).
      iconRow: {
        band: [0.503, 0.648, 0.493, 0.060],   // bounding band in the right half
        gapFrac: 0.028,                        // gap between entries
        iconSizeFrac: 0.030,                   // icon glyph box (of page width)
        valueType: { font: 'serif', sizePt: 25, weight: 400, token: 'gold' },
        entries: [
          { key: 'bedrooms', icon: 'bed' },
          { key: 'bathrooms', icon: 'bath' },
          { key: 'garage', icon: 'garage' },
        ],
      },

      // The agent block lives below the icon row, right half,
      // y ~0.73..0.97. Its internal layout is single/dual -- see modules.js.
      agentBandRect: [0.503, 0.726, 0.493, 0.251],
    },

    // ================================================================
    //  PAGE 2 -- inside spread. Identical across all 5 source files
    //  (4-of-5 consensus values; the older 3361 file differs slightly
    //  and is not used). Only the palette changes between themes.
    // ================================================================
    page2: {
      // gold filigree ornament centred above each panel (in the navy band
      // between the page top and the panel border)
      flourish: [
        { panel: 'L', rect: [0.150, 0.012, 0.200, 0.050] },
        { panel: 'R', rect: [0.650, 0.012, 0.200, 0.050] },
      ],
      // gold double keyline framing each panel's photo block
      panelBorder: [
        { panel: 'L', rect: [0.012, 0.072, 0.477, 0.914] },
        { panel: 'R', rect: [0.511, 0.072, 0.477, 0.914] },
      ],
      // 5 photo slots per panel: 1 big + 2x2 grid
      slots: [
        { id: 'p2L-hero', panel: 'L', rect: [0.019, 0.082, 0.463, 0.476] },
        { id: 'p2L-1', panel: 'L', rect: [0.019, 0.575, 0.226, 0.200] },
        { id: 'p2L-2', panel: 'L', rect: [0.255, 0.575, 0.226, 0.200] },
        { id: 'p2L-3', panel: 'L', rect: [0.019, 0.782, 0.226, 0.200] },
        { id: 'p2L-4', panel: 'L', rect: [0.255, 0.782, 0.226, 0.200] },

        { id: 'p2R-hero', panel: 'R', rect: [0.520, 0.081, 0.463, 0.476] },
        { id: 'p2R-1', panel: 'R', rect: [0.520, 0.573, 0.226, 0.200] },
        { id: 'p2R-2', panel: 'R', rect: [0.756, 0.573, 0.226, 0.200] },
        { id: 'p2R-3', panel: 'R', rect: [0.520, 0.781, 0.226, 0.200] },
        { id: 'p2R-4', panel: 'R', rect: [0.756, 0.781, 0.226, 0.200] },
      ],
    },
  };

  // dual-mode export (matches the rest of the codebase)
  if (typeof module !== 'undefined' && module.exports) module.exports = GEOMETRY;
  if (root) root.FSB_V2_GEOMETRY = GEOMETRY;
})(typeof window !== 'undefined' ? window : null);
