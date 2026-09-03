/*
 * FranVision Feature Sheet Builder -- v2 colour themes
 * ===================================================
 *
 * A "template" the client picks at project creation = one of these
 * colour themes. All three share ./geometry.js and ./modules.js; only
 * the palette (and the page background treatment) changes.
 *
 * Values are sampled from the rendered original PDFs (press output),
 * so they are the real on-page colours, not naive CMYK conversions:
 *   - navy   : 3361 / 120   background #141825, vignette to #11141f
 *   - marble : Kevin-9      light marble texture, ~#F5F4F1, brass gold
 *   - burgundy: Michelle&Sue / Sue   oxblood #301417, vignette to #1c0708
 *
 * `bg.css` for navy / burgundy is a CSS approximation of the original
 * (velvet vignette / oxblood vignette). marble now uses the real Carrara
 * texture (`bg.css` = `url(...)` + a fallback colour); swap navy / burgundy
 * to real artwork the same way.
 *
 * The page-2 ornament is shared by all three themes: asset + geometry live
 * in template-render-v2.js (FLOURISH_URL) and geometry.js (page2.flourish),
 * recoloured per theme with the `gold` token via CSS mask.
 */
(function (root) {
  'use strict';

  var SERIF = '"Cormorant Garamond", "Libre Caslon Text", Georgia, "Songti SC", "Noto Serif SC", serif';
  var SANS = '"Source Sans 3", "Source Sans Pro", -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
  // the swashy calligraphic italic on the original cover ("20 Lord Melborne St")
  var SCRIPT = '"TeX Gyre Chorus", "Cormorant Garamond", "Libre Caslon Text", Georgia, "Songti SC", serif';

  var fonts = {
    serif: {
      family: SERIF,
      googleUrl: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&display=swap',
      approxOf: 'Bell MT (original cover / display serif)',
    },
    sans: {
      family: SANS,
      googleUrl: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,400;0,600;1,400&display=swap',
      approxOf: 'Myriad Pro (original body / sans)',
    },
    script: {
      family: SCRIPT,
      googleUrl: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500;1,600&display=swap',
      approxOf: 'Bell MT Italic swash (original property-address face)',
    },
  };

  function theme(id, name, tokens, bg) {
    return { id: id, name: name, fonts: fonts, tokens: tokens, bg: bg };
  }

  // Backgrounds are LINEAR gradients, matching the originals (IDML
  // Gradient stops): navy 120 = CMYK 98/89/50/44 -> 98/89/62/68;
  // burgundy M&S/Sue = CMYK 56/100/87/56 -> 56/100/87/90; marble = a
  // placed light-stone image, approximated. Endpoints tuned to the
  // sampled press-PDF colours.
  var THEMES = {
    navy: theme('navy', '藏蓝 · Navy', {
      bg: '#141b30',
      bgDeep: '#0d1220',
      ink: '#F4EFE6',
      inkMuted: '#cdbfa6',
      gold: '#D9B28D',
      goldDeep: '#c0925f',
      goldLine: '#a97c4f',
      goldSoft: '#E7D2BC',    // pale gold -- page-1 hero keyline only
      panelInk: '#F4EFE6',
      agentText: '#D9B28D',   // navy: agent name/contact = gold
    }, {
      asset: null,
      css: 'linear-gradient(157deg, #1a2340 0%, #131a30 42%, #0c1120 100%)',
    }),

    marble: theme('marble', '白大理石 · Marble', {
      bg: '#F4F2EC',
      bgDeep: '#E7E3D8',
      ink: '#26292F',
      inkMuted: '#5c6068',
      gold: '#9c7b33',         // deeper brass reads on light stone
      goldDeep: '#7c6128',
      goldLine: '#b39a56',
      goldSoft: '#C0A66E',    // pale gold -- page-1 hero keyline only
      panelInk: '#26292F',
      agentText: '#26292F',   // marble: everything is dark (LYF ref)
    }, {
      // Real Carrara texture from the Kevin-9 reference (5100x3300 = exactly
      // one page's aspect, so `cover` shows the whole slab with no crop).
      // Pale stone underneath as a fallback while it loads / if it 404s.
      asset: '/template-assets/fsb-v2/assets/marble.jpg',
      css: "#F4F2EC url('/template-assets/fsb-v2/assets/marble.jpg') center / cover no-repeat",
    }),

    burgundy: theme('burgundy', '酒红 · Burgundy', {
      bg: '#38151a',
      bgDeep: '#1a0708',
      ink: '#F4EFE6',
      inkMuted: '#d8c3ad',
      gold: '#D9B28D',
      goldDeep: '#c0925f',
      goldLine: '#a97c4f',
      goldSoft: '#E7D2BC',    // pale gold -- page-1 hero keyline only
      panelInk: '#F4EFE6',
      agentText: '#D9B28D',
    }, {
      asset: null,
      css: 'linear-gradient(157deg, #431a1f 0%, #331216 44%, #1c0809 100%)',
    }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = THEMES;
  if (root) root.FSB_V2_THEMES = THEMES;
})(typeof window !== 'undefined' ? window : null);
