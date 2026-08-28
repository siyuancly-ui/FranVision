/*
 * FranVision Feature Sheet Builder -- template definition: "jason-fs-v1"
 * =====================================================================
 *
 * This file is the SINGLE SOURCE OF TRUTH for the template geometry:
 * page size, photo-slot rectangles, text-field positions/typography,
 * and the fixed design overlays. Project content (the chosen photos,
 * the crop of each, the typed property/agent info) lives separately in
 * project.json and only references this template by `id`.
 *
 * To add a second/third Feature Sheet later: drop a new folder
 * templates/<id>/template-config.js exporting the same shape, and
 * register it in templates/registry.js.
 *
 * COORDINATES
 * -----------
 * Every `rect` is [x, y, w, h] as a fraction (0..1) of the FULL PAGE
 * (the whole landscape spread), origin top-left. The renderer converts
 * to pixels with:  px = fraction * renderedPageSizePx
 * Font sizes are in points; the renderer scales them by
 * (renderedPageWidthPx / page.widthPt).
 *
 * FIDELITY NOTE (v1): rectangles below are measured from the supplied
 * `Jason FS.pdf` rendered at 4970x3234. They are close but NOT
 * guaranteed pixel-perfect -- see NOTES.md. When Franny provides the
 * original design file these numbers get tightened; nothing else
 * changes.
 */

(function (root) {
  'use strict';

  var TEMPLATE = {
    id: 'jason-fs-v1',
    name: 'Jason Gao / Smart Sold -- 2-page Feature Sheet',

    // Landscape spread = two 8.5x11 portrait panels + 0.125" bleed.
    page: {
      widthPt: 1242.57,
      heightPt: 808.866,
      bleedPt: 9,
      aspect: 1242.57 / 808.866,
      count: 2, // page1, page2
    },

    // ---- Typography -----------------------------------------------------
    // `approxOf` documents that these are the nearest free Google Fonts,
    // pending the real design file. Swap `family` + `googleUrl` here only.
    fonts: {
      display: {
        family: '"Chivo Mono", "Roboto Mono", ui-monospace, monospace',
        googleUrl:
          'https://fonts.googleapis.com/css2?family=Chivo+Mono:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap',
        approxOf: 'PDF cover face (address / chevron name / italic phone / SMART SOLD REALTY)',
      },
      body: {
        family: '"PT Sans", "Source Sans 3", -apple-system, Segoe UI, Roboto, sans-serif',
        googleUrl:
          'https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400&display=swap',
        approxOf: 'PDF back-cover body face (description + contact block)',
      },
    },

    // ---- Palette ------------------------------------------------------
    colors: {
      navy: '#152a63',
      navyDeep: '#0e1a44',
      ink: '#ffffff',
      inkMuted: '#c7d2e6',
      metalText: '#3f4756',
    },

    // ---- Backgrounds (v1: CSS-recreated; can be swapped for a real PNG
    //      by setting `asset` to a file in ./assets/) ------------------
    backgrounds: {
      page1: { asset: null },
      page2: { asset: null },
    },

    // ---- Fixed design overlays -------------------------------------------
    // `kind` tells the renderer how to paint it. `rect` is page-fraction.
    overlays: [
      // Page 1 -- back cover
      { id: 'p1L-collage-border', page: 1, kind: 'frame', rect: [0.0325, 0.050, 0.4445, 0.552],
        style: { border: 2, color: '#e9eef7', double: true } },
      { id: 'p1L-metal-plate', page: 1, kind: 'metal', rect: [0.004, 0.847, 0.492, 0.16],
        style: { radius: 18, roundedCorners: 'top' } },

      // Page 1 -- front cover
      { id: 'p1R-cover-divider', page: 1, kind: 'hairline', rect: [0.5, 0.197, 0.5, 0.0015],
        style: { color: 'rgba(255,255,255,0.25)' } },
      { id: 'p1R-chevron', page: 1, kind: 'metal', rect: [0.5, 0.672, 0.5, 0.246],
        style: { clip: 'polygon(0 0, 100% 0, 100% 52%, 50% 100%, 0 52%)' } },
      { id: 'p1R-logo-plate', page: 1, kind: 'plate', rect: [0.8975, 0.7805, 0.0605, 0.089],
        style: { color: '#ffffff', radius: 12 } },

      // Page 2 -- interior collages
      { id: 'p2L-frame', page: 2, kind: 'frame', rect: [0.0345, 0.054, 0.4415, 0.892],
        style: { border: 2, color: '#eef2fa', double: true } },
      { id: 'p2R-frame', page: 2, kind: 'frame', rect: [0.5245, 0.054, 0.4415, 0.892],
        style: { border: 2, color: '#eef2fa', double: true } },
    ],

    // ---- Photo slots (16) ---------------------------------------------
    // id convention: p<page><L|R>-<n>. `label` is shown as the empty-slot hint.
    photoSlots: [
      // Page 1 -- back-cover amenity collage (5)
      { id: 'p1L-1', page: 1, rect: [0.0395, 0.0585, 0.2085, 0.239], label: 'Amenity 1' },
      { id: 'p1L-2', page: 1, rect: [0.2590, 0.0585, 0.2100, 0.239], label: 'Amenity 2' },
      { id: 'p1L-3', page: 1, rect: [0.0395, 0.3040, 0.1390, 0.157], label: 'Amenity 3' },
      { id: 'p1L-4', page: 1, rect: [0.0395, 0.4670, 0.1390, 0.132], label: 'Amenity 4' },
      { id: 'p1L-5', page: 1, rect: [0.1850, 0.3040, 0.2840, 0.295], label: 'Amenity 5 (large)' },
      // Page 1 -- front-cover hero (1)
      { id: 'p1R-hero', page: 1, rect: [0.5050, 0.2055, 0.4780, 0.4670], label: 'Cover hero photo' },
      // Page 2 -- left collage (5)
      { id: 'p2L-1', page: 2, rect: [0.0430, 0.0630, 0.4240, 0.4320], label: 'Interior 1 (large)' },
      { id: 'p2L-2', page: 2, rect: [0.0430, 0.5050, 0.2090, 0.2300], label: 'Interior 2' },
      { id: 'p2L-3', page: 2, rect: [0.2580, 0.5050, 0.2090, 0.2300], label: 'Interior 3' },
      { id: 'p2L-4', page: 2, rect: [0.0430, 0.7440, 0.2090, 0.1930], label: 'Interior 4' },
      { id: 'p2L-5', page: 2, rect: [0.2580, 0.7440, 0.2090, 0.1930], label: 'Interior 5' },
      // Page 2 -- right collage (5)
      { id: 'p2R-1', page: 2, rect: [0.5330, 0.0630, 0.4240, 0.4320], label: 'Interior 6 (large)' },
      { id: 'p2R-2', page: 2, rect: [0.5330, 0.5050, 0.2090, 0.2300], label: 'Interior 7' },
      { id: 'p2R-3', page: 2, rect: [0.7480, 0.5050, 0.2090, 0.2300], label: 'Interior 8' },
      { id: 'p2R-4', page: 2, rect: [0.5330, 0.7440, 0.2090, 0.1930], label: 'Interior 9' },
      { id: 'p2R-5', page: 2, rect: [0.7480, 0.7440, 0.2090, 0.1930], label: 'Interior 10' },
    ],

    // ---- Circular agent headshot (page 1 front cover) -----------------
    // Defined by centre + diameter (page-width fraction) so it stays a
    // true circle regardless of page aspect. Replaceable per project.
    headshotSlot: {
      id: 'p1R-headshot',
      page: 1,
      center: [0.5810, 0.7970],
      diameter: 0.0820,
      ring: { color: '#dfe6f2', width: 3 },
      defaultAsset: 'assets/agent-headshot.png',
      bindPhotoId: 'agentInfo.headshotPhotoId',
    },

    // ---- Brokerage logo (page 1 front cover) -------------------------
    logoSlot: {
      id: 'p1R-logo',
      page: 1,
      rect: [0.9010, 0.7840, 0.0535, 0.0815],
      fit: 'contain',
      defaultAsset: 'assets/brokerage-logo.png',
      bindPhotoId: 'agentInfo.brokerageLogoPhotoId',
    },

    // ---- QR code (page 1 back cover) ---------------------------------
    // Generated live from the "Online Tour URL" field; not a stored asset.
    qrBlock: {
      id: 'p1L-qr',
      page: 1,
      rect: [0.3760, 0.8500, 0.0720, 0.1000],
      source: 'agentInfo.onlineTourUrl',
      caption: 'ONLINE TOUR',
      captionRect: [0.3690, 0.9560, 0.0900, 0.026],
      dark: '#111111',
      light: '#ffffff',
    },

    // ---- Text fields --------------------------------------------------
    // `bind` = dot-path into project. `bindLines` = multi-line block
    // assembled from several fields (empty parts skipped).
    textFields: [
      {
        id: 'address', page: 1, rect: [0.5080, 0.045, 0.484, 0.105],
        font: 'display', sizePt: 33, lineHeightPt: 37, weight: 400,
        align: 'center', color: '#ffffff', letterSpacing: '0.02em',
        transform: 'none', maxLines: 2, bind: 'propertyInfo.address',
        placeholder: '906-1000 Portage Pkwy',
      },
      {
        id: 'city', page: 1, rect: [0.5080, 0.156, 0.484, 0.045],
        font: 'display', sizePt: 14, lineHeightPt: 18, weight: 400,
        align: 'center', color: '#ffffff', letterSpacing: '0.34em',
        transform: 'none', maxLines: 1, bind: 'propertyInfo.city',
        placeholder: 'Vaughan',
      },
      {
        id: 'description', page: 1, rect: [0.0330, 0.630, 0.446, 0.208],
        font: 'body', sizePt: 10.5, lineHeightPt: 15.5, weight: 400,
        align: 'left', color: '#ffffff', letterSpacing: '0',
        transform: 'capitalize', maxLines: 11, bind: 'propertyInfo.description',
        placeholder: 'Experience modern urban living in this bright and functional condo...',
      },
      {
        id: 'agentName-cover', page: 1, rect: [0.6180, 0.734, 0.300, 0.050],
        font: 'display', sizePt: 23, lineHeightPt: 26, weight: 400,
        align: 'center', color: '#ffffff', letterSpacing: '0.10em',
        transform: 'none', maxLines: 1, bind: 'agentInfo.name',
        textShadow: '0 1px 0 rgba(255,255,255,0.35), 0 -1px 1px rgba(0,0,0,0.35)',
        placeholder: 'Jason Gao, CCIM',
      },
      {
        id: 'credentials-cover', page: 1, rect: [0.6180, 0.787, 0.300, 0.030],
        font: 'display', sizePt: 10, lineHeightPt: 13, weight: 400,
        align: 'center', color: '#e7ecf6', letterSpacing: '0.14em',
        transform: 'none', maxLines: 1, bind: 'agentInfo.credentials',
        placeholder: 'BROKER/FRI/CLHMS/CNHS',
      },
      {
        id: 'phone-cover', page: 1, rect: [0.6180, 0.828, 0.300, 0.048],
        font: 'display', sizePt: 21, lineHeightPt: 24, weight: 400, italic: true,
        align: 'center', color: '#eef2fa', letterSpacing: '0.02em',
        transform: 'none', maxLines: 1, bind: 'agentInfo.cellPhone', format: 'phone',
        placeholder: '416-877-6268',
      },
      {
        id: 'footer-text', page: 1, rect: [0.600, 0.950, 0.380, 0.034],
        font: 'display', sizePt: 13, lineHeightPt: 16, weight: 400,
        align: 'center', color: '#c7d2e6', letterSpacing: '0.38em',
        transform: 'uppercase', maxLines: 1,
        bind: 'agentInfo.brokerage', placeholder: 'SMART SOLD REALTY',
      },
      {
        id: 'agentName-back', page: 1, rect: [0.0580, 0.856, 0.320, 0.040],
        font: 'display', sizePt: 19, lineHeightPt: 22, weight: 400,
        align: 'left', color: '#f4f6fb', letterSpacing: '0.03em',
        transform: 'uppercase', maxLines: 1, bind: 'agentInfo.name',
        placeholder: 'JASON GAO, CCIM',
      },
      {
        id: 'contact-block', page: 1, rect: [0.0580, 0.900, 0.300, 0.098],
        font: 'body', sizePt: 10.5, lineHeightPt: 14.5, weight: 400,
        align: 'left', color: '#eef1f6', letterSpacing: '0',
        transform: 'none',
        // Each line: non-empty parts joined by `sep`. `label` prefixes the
        // value; it is NOT a separator, so a missing earlier field can't
        // push a later one out of left alignment.
        bindLines: [
          { parts: [{ f: 'agentInfo.credentials' }] },
          { sep: '   ', parts: [
            { f: 'agentInfo.busPhone', label: 'Bus: ', fmt: 'phone' },
            { f: 'agentInfo.cellPhone', label: 'Cell: ', fmt: 'phone' },
          ] },
          { sep: '   ', parts: [{ f: 'agentInfo.email' }, { f: 'agentInfo.website' }] },
          { parts: [{ f: 'agentInfo.brokerageAddress' }] },
        ],
        placeholder: 'BROKER/FRI/CLHMS/CNHS\nBus: 647-564-4990   Cell: 416-877-6268\nname@example.com   https://evergreenrealty.ca/\n275 Renfrew Dr., Unit 106 Markham',
      },
    ],

    // ---- The editable form (drives `textFields` above) ---------------
    // group -> ordered field list. `key` is the leaf under propertyInfo /
    // agentInfo in project.json.
    form: {
      propertyInfo: [
        { key: 'address', label: 'Property Address', type: 'text', required: true },
        { key: 'city', label: 'City', type: 'text' },
        { key: 'description', label: 'Property Description', type: 'textarea', rows: 6 },
      ],
      agentInfo: [
        { key: 'name', label: 'Agent Name', type: 'text', required: true },
        { key: 'credentials', label: 'Credentials / Title', type: 'text' },
        { key: 'busPhone', label: 'Phone (Bus)', type: 'text', hint: 'Any format — the sheet prints it as 000-000-0000' },
        { key: 'cellPhone', label: 'Cell Phone', type: 'text', hint: 'Any format — the sheet prints it as 000-000-0000' },
        { key: 'email', label: 'Email', type: 'text' },
        { key: 'brokerage', label: 'Brokerage', type: 'text' },
        { key: 'brokerageAddress', label: 'Brokerage Address', type: 'text' },
        { key: 'website', label: 'Website', type: 'text' },
        { key: 'onlineTourUrl', label: 'Online Tour URL', type: 'text' },
        { key: 'headshotPhotoId', label: 'Agent Headshot', type: 'image' },
        { key: 'brokerageLogoPhotoId', label: 'Brokerage Logo', type: 'image' },
      ],
    },
  };

  // Blank project scaffold for this template (used by the server on create
  // and by the client as a fallback). Slot map is pre-seeded empty.
  TEMPLATE.blankProject = function blankProject() {
    var slots1 = {}, slots2 = {};
    TEMPLATE.photoSlots.forEach(function (s) {
      (s.page === 1 ? slots1 : slots2)[s.id] = { photoId: null, positionX: 0, positionY: 0, scale: 1 };
    });
    return {
      templateId: TEMPLATE.id,
      propertyInfo: { address: '', city: '', description: '' },
      agentInfo: {
        name: '', credentials: '', busPhone: '', cellPhone: '', email: '',
        brokerage: '', brokerageAddress: '', website: '', onlineTourUrl: '',
        headshotPhotoId: null, brokerageLogoPhotoId: null,
      },
      photos: [],
      pages: { page1: { slots: slots1 }, page2: { slots: slots2 } },
      confirmed: false,
      confirmedAt: null,
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TEMPLATE;
  if (root) root.FSB_TEMPLATE = TEMPLATE;
})(typeof window !== 'undefined' ? window : null);
