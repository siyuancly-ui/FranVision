/*
 * FranVision Feature Sheet Builder -- v2 registry / compositor
 * ==========================================================
 *
 * The single entry point the app talks to. Combines:
 *   geometry.js  (shared frame)  +  themes.js  (navy/marble/burgundy)
 *   +  modules.js  (conditional bands)  +  layout-engine.js  (reflow)
 * into a fully resolved render spec for a given project.
 *
 *   FSB_V2.list()               -> [{id,name}]  (the 3 selectable themes)
 *   FSB_V2.blankProject(theme)  -> project scaffold
 *   FSB_V2.slotIds(project)     -> ['p1L-1',...,'p2R-4']  (slots that exist now)
 *   FSB_V2.compose(project)     -> {
 *      theme, geometry,
 *      page1: { left:{bands,...}, right:{bands,...} },
 *      page2: { flourish, panelBorder, slots },
 *      flags: { leftVariant, agentVariant, iconRow }
 *   }
 */
(function (root) {
  'use strict';

  var G = root ? root.FSB_V2_GEOMETRY : require('./geometry.js');
  var THEMES = root ? root.FSB_V2_THEMES : require('./themes.js');
  var M = root ? root.FSB_V2_MODULES : require('./modules.js');
  var LAY = root ? root.FSB_V2_LAYOUT : require('./layout-engine.js');

  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function nonEmpty(v) { return v != null && String(v).trim() !== ''; }

  // ---- which modules apply -----------------------------------------
  function pickLeftVariant(project) {
    return nonEmpty(get(project, 'propertyInfo.description')) ? 'stagger5' : 'collage6';
  }
  function pickAgentVariant(project) {
    return nonEmpty(get(project, 'agentInfo2.name')) ? 'dual' : 'single';
  }
  function iconRowKeys(project) {
    return G.page1Right.iconRow.entries
      .filter(function (e) { return nonEmpty(get(project, 'propertyInfo.' + e.key)); })
      .map(function (e) { return e.key; });
  }

  // ---- slot enumeration ------------------------------------------
  function leftPhotos(project, variant) {
    var def = M.leftColumn[variant];
    if (def.photosPaired && get(project, 'topPhotoStyle') === 'paired') return def.photosPaired;
    return def.photos;
  }
  function leftSlotIds(project, variant) {
    var def = M.leftColumn[variant];
    if (def.explicit) return leftPhotos(project, variant).map(function (p) { return p.id; });
    return def.bands.reduce(function (acc, b) {
      if (b.kind === 'photos') b.slots.forEach(function (s) { acc.push(s.id); });
      return acc;
    }, []);
  }
  function slotIds(project) {
    var p2 = G.page2.slots.map(function (s) { return s.id; });
    return leftSlotIds(project, pickLeftVariant(project)).concat(['p1R-hero']).concat(p2);
  }

  // ---- compose ---------------------------------------------------
  function compose(project) {
    project = project || {};
    var theme = THEMES[project.colorTheme] || THEMES.navy;
    var leftVariant = pickLeftVariant(project);
    var agentVariant = pickAgentVariant(project);
    var iconKeys = iconRowKeys(project);

    // -- page 1 LEFT --
    var leftDef = M.leftColumn[leftVariant];
    var leftSolved, leftDesc = null;
    if (leftDef.explicit) {
      leftSolved = { bands: leftPhotos(project, leftVariant).map(function (p) {
        return { id: p.id, kind: 'photos', slots: [{ id: p.id, rect: p.rect }], rect: p.rect };
      }), overflow: 0 };
      if (leftDef.desc) {
        leftDesc = { rect: leftDef.desc.rect, type: leftDef.desc.type,
          field: 'propertyInfo.description',
          value: get(project, 'propertyInfo.description') || '' };
      }
    } else {
      leftSolved = LAY.solveColumn(leftDef.column, leftDef.bands,
        { slackToGaps: leftDef.slackToGaps !== false });
    }

    // -- page 1 RIGHT: address / hero fixed; then a "lower zone" that the
    //    optional icon row + the agent block share. The agent block just
    //    gets whatever height is left -> no overflow, reflows its content.
    var R = M.RIGHT;
    var pr = G.page1Right;
    var addrRect = pr.address.rect;
    var heroRect = pr.hero.rect;

    var GAP = 0.018;
    var COL_BOTTOM = 0.977;
    var lowerTop = heroRect[1] + heroRect[3] + 0.026;
    var iconH = 0.040;
    var iconRect = null, agentRect;
    if (iconKeys.length) {
      iconRect = [R.x, lowerTop, R.w, iconH];
      agentRect = [R.x, lowerTop + iconH + GAP, R.w, COL_BOTTOM - (lowerTop + iconH + GAP)];
    } else {
      agentRect = [R.x, lowerTop, R.w, COL_BOTTOM - lowerTop];
    }

    return {
      theme: theme,
      geometry: G,
      flags: { leftVariant: leftVariant, agentVariant: agentVariant, iconRow: iconKeys },
      page1: {
        left: { variant: leftVariant, column: leftDef.column, solved: leftSolved, desc: leftDesc },
        right: {
          address: { rect: addrRect, spec: pr.address, value: {
            address: get(project, 'propertyInfo.address') || '',
            city: get(project, 'propertyInfo.city') || '',
          } },
          hero: { rect: heroRect, border: pr.hero.border },
          iconRow: iconKeys.length ? {
            rect: iconRect, keys: iconKeys, spec: pr.iconRow,
            values: iconKeys.reduce(function (o, k) {
              o[k] = get(project, 'propertyInfo.' + k); return o;
            }, {}),
          } : null,
          agent: {
            variant: agentVariant,
            rect: agentRect,
            spec: M.agentBlock[agentVariant],
          },
        },
      },
      page2: {
        flourish: G.page2.flourish,
        panelBorder: G.page2.panelBorder,
        slots: G.page2.slots,
      },
    };
  }

  function blankProject(themeId) {
    return {
      templateSystem: 'fsb-v2',
      colorTheme: THEMES[themeId] ? themeId : 'navy',
      topPhotoStyle: 'wide', // wide | paired  (only when description present)
      propertyInfo: { address: '', city: '', description: '',
        bedrooms: '', bathrooms: '', garage: '', onlineTourUrl: '' },
      agentInfo: { name: '', credentials: '', cellPhone: '', email: '',
        brokerage: '', brokerageOffice: '', brokerageAddress: '',
        headshotPhotoId: null, brokerageLogoPhotoId: null },
      agentInfo2: null,
      photos: [],
      pages: { page1: { slots: {} }, page2: { slots: {} } },
      confirmed: false, confirmedAt: null,
    };
  }

  function list() {
    return Object.keys(THEMES).map(function (k) {
      return { id: k, name: THEMES[k].name };
    });
  }

  var API = { list: list, compose: compose, blankProject: blankProject, slotIds: slotIds };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.FSB_V2 = API;
})(typeof window !== 'undefined' ? window : null);
