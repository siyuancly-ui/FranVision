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
 * `bg.css` is a CSS approximation of the original (navy velvet vignette /
 * marble / oxblood vignette). Swap for a real texture PNG later by
 * setting `bg.asset`.
 */
(function (root) {
  'use strict';

  var SERIF = '"Libre Caslon Text", "Libre Caslon", Georgia, "Songti SC", "Noto Serif SC", serif';
  var SANS = '"Source Sans 3", "Source Sans Pro", -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';

  var fonts = {
    serif: {
      family: SERIF,
      googleUrl: 'https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&display=swap',
      approxOf: 'Bell MT (original cover / display serif)',
    },
    sans: {
      family: SANS,
      googleUrl: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,400;0,600;1,400&display=swap',
      approxOf: 'Myriad Pro (original body / sans)',
    },
  };

  function theme(id, name, tokens, bg) {
    return { id: id, name: name, fonts: fonts, tokens: tokens, bg: bg };
  }

  var THEMES = {
    navy: theme('navy', '藏蓝 · Navy', {
      bg: '#141825',
      bgDeep: '#11141f',
      ink: '#F4EFE6',          // warm off-white body/headings
      inkMuted: '#cdbfa6',
      gold: '#D9B28D',         // champagne accent (hero keyline, values)
      goldDeep: '#c0925f',
      goldLine: '#a97c4f',    // hairline gold
      panelInk: '#F4EFE6',
    }, {
      asset: null,
      css: 'radial-gradient(120% 90% at 28% 32%, #1b2133 0%, #141825 46%, #11131d 100%)',
    }),

    marble: theme('marble', '白大理石 · Marble', {
      bg: '#F5F4F1',
      bgDeep: '#ECEAE3',
      ink: '#262A30',
      inkMuted: '#5c6068',
      gold: '#B69A3E',         // brass gold reads better on light marble
      goldDeep: '#8f7a2f',
      goldLine: '#b9a45a',
      panelInk: '#262A30',
    }, {
      asset: null,
      css: 'linear-gradient(135deg, #FAF9F6 0%, #F1EFE9 45%, #E7E4DB 100%)',
    }),

    burgundy: theme('burgundy', '酒红 · Burgundy', {
      bg: '#301417',
      bgDeep: '#1c0708',
      ink: '#F4EFE6',
      inkMuted: '#d8c3ad',
      gold: '#D9B28D',
      goldDeep: '#c0925f',
      goldLine: '#a97c4f',
      panelInk: '#F4EFE6',
    }, {
      asset: null,
      css: 'radial-gradient(120% 90% at 30% 34%, #3d1a1e 0%, #301417 44%, #1d0809 100%)',
    }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = THEMES;
  if (root) root.FSB_V2_THEMES = THEMES;
})(typeof window !== 'undefined' ? window : null);
