/*
 * template-render-v2.js -- renderer for the fsb-v2 template system.
 *
 * Same public interface as template-render.js so editor.js / app.js keep
 * working:  window.FSB.render = { renderPage, updateSlot, updateDynamic }
 *
 * Driven entirely by FSB_V2.compose(project) (templates/fsb-v2/registry.js).
 * Geometry is fractions of the 1224x792pt trim; this multiplies by the
 * rendered page size in px. Points scale by (pageWpx / 1224).
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var util = window.FSB.util;
  var el = util.el;
  var V2 = window.FSB_V2;
  var G = window.FSB_V2_GEOMETRY;

  var TRIM_W = 1224, TRIM_H = 792;

  function px(rect, pw, ph) {
    return { left: rect[0] * pw, top: rect[1] * ph, width: rect[2] * pw, height: rect[3] * ph };
  }
  function setBox(node, rect, pw, ph) {
    var b = px(rect, pw, ph);
    node.style.position = 'absolute';
    node.style.left = b.left + 'px'; node.style.top = b.top + 'px';
    node.style.width = b.width + 'px'; node.style.height = b.height + 'px';
  }
  function photoSource() { return window.FSB.photoSource; }
  function fullUrl(project, id) {
    var ps = photoSource();
    return ps && id ? ps.fullUrl(project, id) : '';
  }
  function famFor(theme, which) {
    if (which === 'script') return (theme.fonts.script || theme.fonts.serif).family;
    if (which === 'sans') return theme.fonts.sans.family;
    return theme.fonts.serif.family;
  }
  function tokenColor(theme, name) {
    return (theme.tokens && theme.tokens[name]) || name || 'inherit';
  }

  // ---- photo slot (editor-compatible DOM, matches template-render.js) ----
  var CROP = window.FSB_CROP;

  function slotState(project, id) {
    var pg = id.indexOf('p2') === 0 ? 'page2' : 'page1';
    var s = project.pages[pg].slots[id];
    if (!s) { s = { photoId: null, positionX: 0, positionY: 0, scale: 1 }; project.pages[pg].slots[id] = s; }
    return s;
  }
  function pageKeyOf(id) { return id.indexOf('p2') === 0 ? 2 : 1; }

  function photoMeta(project, id) {
    var ps = photoSource();
    return ps && ps.getMeta && id ? ps.getMeta(project, id) : null;
  }

  function buildSlot(project, id, rect, pw, ph, interactive) {
    var wrap = el('div', { class: 'fsb-slot', 'data-slot-id': id, 'data-page': pageKeyOf(id) });
    setBox(wrap, rect, pw, ph);
    wrap._rectPx = px(rect, pw, ph);
    fillSlot(wrap, project, id, pw, ph, interactive);
    return wrap;
  }

  function slotImg(project, id, state, rectPx) {
    var meta = photoMeta(project, state.photoId);
    var img = el('img', { class: 'fsb-slot-img', draggable: 'false', alt: '' });
    img.src = fullUrl(project, state.photoId);
    var layout = CROP.computeLayout({
      slotW: rectPx.width, slotH: rectPx.height,
      photoW: meta ? meta.width : 0, photoH: meta ? meta.height : 0,
      scale: state.scale, positionX: state.positionX, positionY: state.positionY,
    });
    img.style.width = layout.displayW + 'px';
    img.style.height = layout.displayH + 'px';
    img.style.left = layout.offsetX + 'px';
    img.style.top = layout.offsetY + 'px';
    return img;
  }

  function slotToolbar() {
    var frag = document.createDocumentFragment();
    frag.appendChild(el('div', { class: 'fsb-slot-move', 'data-action': 'drag', draggable: 'true',
      title: 'Drag onto another slot to move / swap this photo' }, [
      el('span', { class: 'fsb-slot-move-grip', text: '⠿' }),
      el('span', { class: 'fsb-slot-move-txt', text: 'Move' }),
    ]));
    frag.appendChild(el('div', { class: 'fsb-slot-tools' }, [
      // no "change" button -- clicking the photo opens the picker (editor.js)
      el('button', { 'data-action': 'zoom-out', title: 'Zoom out', text: '−' }),
      el('button', { 'data-action': 'zoom-in', title: 'Zoom in', text: '+' }),
      el('button', { 'data-action': 'reset', title: 'Reset framing', text: '↺' }),
      el('button', { 'data-action': 'clear', title: 'Remove photo', text: '✕' }),
    ]));
    return frag;
  }

  function fillSlot(wrap, project, id, pw, ph, interactive) {
    var state = slotState(project, id);
    var rectPx = wrap._rectPx || { width: wrap.offsetWidth, height: wrap.offsetHeight };
    wrap.innerHTML = '';
    wrap.classList.remove('fsb-slot--dragging', 'fsb-slot--drop', 'fsb-slot--panning');
    if (state.photoId && photoMeta(project, state.photoId) != null) {
      wrap.classList.add('fsb-slot--filled');
      wrap.classList.remove('fsb-slot--empty');
      wrap.appendChild(slotImg(project, id, state, rectPx));
      if (interactive) wrap.appendChild(slotToolbar());
    } else {
      wrap.classList.remove('fsb-slot--filled');
      wrap.classList.add('fsb-slot--empty');
      if (interactive) {
        wrap.appendChild(el('div', { class: 'fsb-slot-hint' }, [
          el('div', { class: 'fsb-slot-hint-ico', text: '＋' }),
          el('div', { class: 'fsb-slot-hint-label', text: 'Click to add a photo\n点击选择照片' }),
        ]));
      }
    }
  }

  // ---- text -------------------------------------------------------
  function buildText(rect, pw, ph, scale, opts) {
    var node = el('div', { class: 'fsb-text' + (opts.cls ? ' ' + opts.cls : '') });
    setBox(node, rect, pw, ph);
    node.style.display = 'flex';
    node.style.flexDirection = 'column';
    node.style.justifyContent = opts.vAlign || 'flex-start';
    node.style.alignItems = opts.align === 'center' ? 'center'
      : opts.align === 'right' ? 'flex-end' : 'flex-start';
    node.style.textAlign = opts.align || 'left';
    node.style.fontFamily = opts.family;
    node.style.fontSize = (opts.sizePt * scale) + 'px';
    node.style.lineHeight = opts.leadingPt ? (opts.leadingPt * scale) + 'px' : 1.3;
    node.style.fontWeight = opts.weight || 400;
    node.style.fontStyle = opts.italic ? 'italic' : 'normal';
    node.style.letterSpacing = opts.tracking ? opts.tracking + 'em' : 'normal';
    node.style.color = opts.color || 'inherit';
    node.style.whiteSpace = 'pre-wrap';
    node.style.overflow = 'hidden';
    if (opts.text != null) node.textContent = opts.text;
    return node;
  }

  // ---- icon glyphs: bed / bath / garage outlines lifted from the Sue
  // template IDML (frames u20b / u1e0 / u20d), normalised to ~38 units.
  var ICO = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  var ICONS = {
    bed: '<svg viewBox="-2 -2 42 33.2" ' + ICO + '><path d="M36.41 13.02 C36.41 13.02 36.41 4.29 36.41 4.29 C36.41 1.92 34.64 0 32.46 0 C32.46 0 5.55 0 5.55 0 C3.36 0 1.59 1.92 1.59 4.29 C1.59 4.29 1.59 13.02 1.59 13.02 C0.66 13.38 0 14.33 0 15.45 C0 15.45 0 24.9 0 24.9 C0 25.12 0.09 25.34 0.23 25.51 C0.38 25.67 0.58 25.75 0.8 25.75 C0.8 25.75 3.17 25.75 3.17 25.75 C3.17 25.75 3.17 28.33 3.17 28.33 C3.17 28.56 3.25 28.78 3.4 28.94 C3.55 29.1 3.75 29.19 3.96 29.19 C3.96 29.19 8.71 29.19 8.71 29.19 C8.92 29.19 9.12 29.1 9.27 28.94 C9.42 28.78 9.5 28.56 9.5 28.33 C9.5 28.33 9.5 25.75 9.5 25.75 C9.5 25.75 28.5 25.75 28.5 25.75 C28.5 25.75 28.5 28.33 28.5 28.33 C28.5 28.56 28.59 28.78 28.73 28.94 C28.88 29.1 29.08 29.19 29.29 29.19 C29.29 29.19 34.04 29.19 34.04 29.19 C34.25 29.19 34.45 29.1 34.6 28.94 C34.75 28.78 34.84 28.56 34.84 28.33 C34.84 28.33 34.84 25.75 34.84 25.75 C34.84 25.75 37.21 25.75 37.21 25.75 C37.42 25.75 37.62 25.67 37.77 25.51 C37.91 25.34 38 25.12 38 24.9 C38 24.9 38 15.45 38 15.45 C38 14.33 37.34 13.38 36.41 13.02 Z M3.17 4.29 C3.17 2.87 4.23 1.72 5.55 1.72 C5.55 1.72 32.46 1.72 32.46 1.72 C33.77 1.72 34.84 2.87 34.84 4.29 C34.84 4.29 34.84 12.88 34.84 12.88 C34.84 12.88 32.03 12.88 32.03 12.88 C32.6 11.82 32.6 10.5 32.03 9.45 C31.47 8.38 30.42 7.73 29.29 7.73 C29.29 7.73 21.37 7.73 21.37 7.73 C20.47 7.73 19.6 8.15 19 8.89 C18.4 8.15 17.53 7.73 16.62 7.73 C16.62 7.73 8.71 7.73 8.71 7.73 C7.58 7.73 6.53 8.38 5.97 9.45 C5.4 10.5 5.4 11.82 5.97 12.88 C5.97 12.88 3.17 12.88 3.17 12.88 C3.17 12.88 3.17 4.29 3.17 4.29 Z M30.66 12.02 C30.38 12.55 29.86 12.88 29.29 12.88 C29.29 12.88 21.37 12.88 21.37 12.88 C20.81 12.88 20.29 12.55 20 12.02 C19.72 11.49 19.72 10.83 20 10.3 C20.29 9.77 20.81 9.45 21.37 9.45 C21.37 9.45 29.29 9.45 29.29 9.45 C29.86 9.45 30.38 9.77 30.66 10.3 C30.94 10.83 30.94 11.49 30.66 12.02 Z M18 12.02 C17.71 12.55 17.19 12.88 16.62 12.88 C16.62 12.88 8.71 12.88 8.71 12.88 C8.14 12.88 7.62 12.55 7.34 12.02 C7.06 11.49 7.06 10.83 7.34 10.3 C7.62 9.77 8.14 9.45 8.71 9.45 C8.71 9.45 16.62 9.45 16.62 9.45 C17.19 9.45 17.71 9.77 18 10.3 C18.28 10.83 18.28 11.49 18 12.02 Z M7.92 27.47 C7.92 27.47 4.75 27.47 4.75 27.47 C4.75 27.47 4.75 25.75 4.75 25.75 C4.75 25.75 7.92 25.75 7.92 25.75 C7.92 25.75 7.92 27.47 7.92 27.47 Z M33.25 27.47 C33.25 27.47 30.09 27.47 30.09 27.47 C30.09 27.47 30.09 25.75 30.09 25.75 C30.09 25.75 33.25 25.75 33.25 25.75 C33.25 25.75 33.25 27.47 33.25 27.47 Z M36.41 24.04 C36.41 24.04 1.59 24.04 1.59 24.04 C1.59 24.04 1.59 21.47 1.59 21.47 C1.59 21.47 36.41 21.47 36.41 21.47 C36.41 21.47 36.41 24.04 36.41 24.04 Z M36.41 19.75 C36.41 19.75 1.59 19.75 1.59 19.75 C1.59 19.75 1.59 15.45 1.59 15.45 C1.59 15.23 1.67 15.01 1.81 14.84 C1.96 14.68 2.17 14.6 2.37 14.6 C2.37 14.6 35.62 14.6 35.62 14.6 C35.83 14.6 36.04 14.68 36.19 14.84 C36.33 15.01 36.41 15.23 36.41 15.45 C36.41 15.45 36.41 19.75 36.41 19.75 Z M32.33 4.92 C33.36 4.92 33.36 3.18 32.33 3.18 C31.3 3.18 31.3 4.92 32.33 4.92 C32.33 4.92 32.33 4.92 32.33 4.92 Z"/></svg>',
    bath: '<svg viewBox="-2 -2 42 41.8" ' + ICO + '><path d="M3.62 23.5 C3.62 23.5 3.62 28.03 3.62 28.03 C3.62 30.52 5.64 32.55 8.14 32.55 C8.14 32.55 29.86 32.55 29.86 32.55 C32.36 32.55 34.38 30.52 34.38 28.03 C34.38 28.03 34.38 23.5 34.38 23.5 C34.38 23.5 3.62 23.5 3.62 23.5 Z M19.96 6.31 C20.44 2.52 23.78 -0.24 27.6 0 C31.41 0.24 34.38 3.4 34.38 7.22 C34.38 7.22 34.38 21.69 34.38 21.69 C34.38 21.69 37.1 21.69 37.1 21.69 C37.59 21.69 38 22.1 38 22.6 C38 23.1 37.59 23.5 37.1 23.5 C37.1 23.5 36.19 23.5 36.19 23.5 C36.19 23.5 36.19 28.03 36.19 28.03 C36.19 31.19 33.85 33.87 30.72 34.3 C30.72 34.3 32.39 36.53 32.39 36.53 C32.69 36.93 32.61 37.5 32.21 37.8 C31.81 38.1 31.24 38.02 30.94 37.62 C30.94 37.62 28.5 34.36 28.5 34.36 C28.5 34.36 9.5 34.36 9.5 34.36 C9.5 34.36 7.06 37.62 7.06 37.62 C6.76 38.02 6.19 38.1 5.79 37.8 C5.39 37.5 5.31 36.93 5.61 36.53 C5.61 36.53 7.28 34.3 7.28 34.3 C4.15 33.87 1.81 31.19 1.81 28.03 C1.81 28.03 1.81 23.5 1.81 23.5 C1.81 23.5 0.9 23.5 0.9 23.5 C0.41 23.5 0 23.1 0 22.6 C0 22.1 0.41 21.69 0.9 21.69 C0.9 21.69 32.57 21.69 32.57 21.69 C32.57 21.69 32.57 7.22 32.57 7.22 C32.57 4.39 30.41 2.04 27.6 1.8 C24.78 1.57 22.26 3.53 21.79 6.31 C21.79 6.31 25.33 6.31 25.33 6.31 C25.83 6.31 26.24 6.72 26.24 7.22 C26.24 7.72 25.83 8.12 25.33 8.12 C25.33 8.12 16.29 8.12 16.29 8.12 C15.79 8.12 15.38 7.72 15.38 7.22 C15.38 6.72 15.79 6.31 16.29 6.31 C16.29 6.31 19.96 6.31 19.96 6.31 Z"/></svg>',
    garage: '<svg viewBox="-2 -2 42 37" ' + ICO + '><path d="M11.41 32.21 C11.41 32.21 4.67 32.21 4.67 32.21 C4.23 32.21 3.87 31.86 3.87 31.42 C3.87 31.42 3.87 12.84 3.87 12.84 C3.87 12.84 0.76 12.84 0.76 12.84 C0.42 12.84 0.11 12.61 0 12.28 C-0.11 11.96 0.01 11.6 0.3 11.39 C0.3 11.39 16.29 0.03 16.29 0.03 C16.56 -0.16 16.91 -0.17 17.18 0 C17.18 0 33.47 10.02 33.47 10.02 C33.84 10.25 33.96 10.74 33.73 11.12 C33.49 11.49 33 11.61 32.62 11.37 C32.62 11.37 16.79 1.63 16.79 1.63 C16.79 1.63 3.26 11.24 3.26 11.24 C3.26 11.24 4.67 11.24 4.67 11.24 C5.12 11.24 5.48 11.6 5.48 12.04 C5.48 12.04 5.48 30.62 5.48 30.62 C5.48 30.62 11.41 30.62 11.41 30.62 C11.85 30.62 12.21 30.98 12.21 31.42 C12.21 31.86 11.85 32.21 11.41 32.21 Z M34.29 30.61 C34.29 30.61 15.35 30.61 15.35 30.61 C13.3 30.61 11.64 28.96 11.64 26.93 C11.64 26.93 11.64 24.07 11.64 24.07 C11.64 22.04 13.3 20.39 15.35 20.39 C15.35 20.39 34.29 20.39 34.29 20.39 C36.33 20.39 38 22.04 38 24.07 C38 24.07 38 26.93 38 26.93 C38 28.96 36.33 30.61 34.29 30.61 Z M15.35 21.98 C14.19 21.98 13.24 22.92 13.24 24.07 C13.24 24.07 13.24 26.93 13.24 26.93 C13.24 28.08 14.19 29.02 15.35 29.02 C15.35 29.02 34.29 29.02 34.29 29.02 C35.45 29.02 36.39 28.08 36.39 26.93 C36.39 26.93 36.39 24.07 36.39 24.07 C36.39 22.92 35.45 21.98 34.29 21.98 C34.29 21.98 15.35 21.98 15.35 21.98 Z M34.26 21.98 C33.95 21.98 33.65 21.8 33.52 21.5 C33.52 21.5 30.82 15.26 30.82 15.26 C30.82 15.26 18.92 15.26 18.92 15.26 C18.92 15.26 16.21 21.5 16.21 21.5 C16.04 21.9 15.57 22.09 15.16 21.92 C14.75 21.74 14.56 21.27 14.74 20.87 C14.74 20.87 17.65 14.15 17.65 14.15 C17.78 13.86 18.07 13.67 18.39 13.67 C18.39 13.67 31.34 13.67 31.34 13.67 C31.67 13.67 31.96 13.86 32.08 14.15 C32.08 14.15 34.99 20.87 34.99 20.87 C35.17 21.27 34.98 21.74 34.57 21.92 C34.47 21.96 34.36 21.98 34.26 21.98 Z M18.74 26.3 C18.74 26.3 16.59 26.3 16.59 26.3 C16.15 26.3 15.79 25.94 15.79 25.5 C15.79 25.06 16.15 24.7 16.59 24.7 C16.59 24.7 18.74 24.7 18.74 24.7 C19.18 24.7 19.54 25.06 19.54 25.5 C19.54 25.94 19.18 26.3 18.74 26.3 Z M33.04 26.3 C33.04 26.3 30.9 26.3 30.9 26.3 C30.46 26.3 30.1 25.94 30.1 25.5 C30.1 25.06 30.46 24.7 30.9 24.7 C30.9 24.7 33.04 24.7 33.04 24.7 C33.49 24.7 33.85 25.06 33.85 25.5 C33.85 25.94 33.49 26.3 33.04 26.3 Z M17.67 33.01 C17.22 33.01 16.86 32.66 16.86 32.22 C16.86 32.22 16.86 30.28 16.86 30.28 C16.86 29.84 17.22 29.48 17.67 29.48 C18.11 29.48 18.47 29.84 18.47 30.28 C18.47 30.28 18.47 32.22 18.47 32.22 C18.47 32.66 18.11 33.01 17.67 33.01 Z M31.97 33.01 C31.53 33.01 31.17 32.66 31.17 32.22 C31.17 32.22 31.17 30.28 31.17 30.28 C31.17 29.84 31.53 29.48 31.97 29.48 C32.42 29.48 32.78 29.84 32.78 30.28 C32.78 30.28 32.78 32.22 32.78 32.22 C32.78 32.66 32.42 33.01 31.97 33.01 Z"/></svg>',
  };

  function buildIconRow(info, pw, ph, scale, theme) {
    var box = el('div', { class: 'fsb-iconrow' });
    setBox(box, info.rect, pw, ph);
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.gap = (info.rect[2] * pw * 0.06) + 'px';
    box.style.color = tokenColor(theme, 'gold');
    box.style.fontVariantNumeric = 'lining-nums tabular-nums';
    var iconPx = Math.min(info.rect[3] * ph * 0.82, info.rect[2] * pw * info.spec.iconSizeFrac / 0.03 * 0.03);
    iconPx = info.rect[3] * ph * 0.78;
    info.keys.forEach(function (k) {
      var g = el('span', { class: 'fsb-icon-entry' });
      g.style.cssText = 'display:flex;align-items:center;gap:' + (6 * scale) + 'px';
      var ic = el('span', { class: 'fsb-icon' });
      ic.style.cssText = 'display:inline-flex;width:' + (iconPx * 1.4) + 'px;height:' + iconPx + 'px';
      ic.innerHTML = ICONS[({ bedrooms: 'bed', bathrooms: 'bath', garage: 'garage' })[k]] || '';
      var v = el('span', { text: String(info.values[k] == null ? '' : info.values[k]) });
      v.style.cssText = 'font-family:' + famFor(theme, 'serif') + ';font-size:' +
        (info.spec.valueType.sizePt * scale) + 'px;';
      g.appendChild(ic); g.appendChild(v);
      box.appendChild(g);
    });
    return box;
  }

  // ---- agent block ---------------------------------------------
  function val(project, path) {
    if (!path) return '';
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, project) || '';
  }
  function composeLine(project, parts) {
    return parts.map(function (p) {
      if (/^[a-z]+\./i.test(p) || /^(agentInfo|propertyInfo)/.test(p)) return val(project, p);
      return p;
    }).join('');
  }

  function imgBox(theme, scale, url, label, minH) {
    var im = el('div', { class: 'fsb-agent-img' });
    im.style.cssText = 'flex:1 1 auto;min-height:' + minH + 'px;display:flex;align-items:center;' +
      'justify-content:center;background:center/contain no-repeat;border-radius:2px;' +
      'font-size:' + (8 * scale) + 'px;color:' + tokenColor(theme, 'inkMuted') + ';';
    if (url) { im.style.backgroundImage = 'url(' + url + ')'; im.style.background += ',' + tokenColor(theme, 'bgDeep'); }
    else { im.style.border = '1px dashed ' + tokenColor(theme, 'goldLine'); im.textContent = label; }
    return im;
  }

  var TXT = window.FSB_V2_TEXT || {};
  var formatPhone = TXT.formatPhone;

  function textLine(theme, scale, t, ty, mode) {
    var p = el('div', { text: String(t) });
    ty = ty || {};
    p.style.fontFamily = famFor(theme, ty.font || 'sans');
    p.style.fontSize = ((ty.sizePt || 9) * scale) + 'px';
    p.style.fontWeight = ty.weight || 400;
    p.style.letterSpacing = ty.tracking ? ty.tracking + 'em' : 'normal';
    p.style.color = ty.token ? tokenColor(theme, ty.token) : tokenColor(theme, 'ink');
    p.style.lineHeight = 1.34;
    p.style.maxWidth = '100%';
    if (mode === 'wrap') {
      p.style.whiteSpace = 'normal'; p.style.wordBreak = 'break-word';
    } else if (mode === 'nowrap') {
      p.style.whiteSpace = 'nowrap';                 // never break; may overflow the col slightly
    } else {
      p.style.whiteSpace = 'nowrap'; p.style.overflow = 'hidden'; p.style.textOverflow = 'ellipsis';
    }
    return p;
  }

  function imgBox(theme, scale, url, label, fit) {
    var im = el('div', { class: 'fsb-agent-img' });
    im.style.cssText = 'flex:1 1 auto;align-self:stretch;width:100%;height:100%;display:flex;' +
      'align-items:center;justify-content:center;border-radius:2px;position:relative;overflow:hidden;' +
      'font-size:' + (8 * scale) + 'px;color:' + tokenColor(theme, 'inkMuted') + ';';
    if (url) {
      im.style.backgroundImage = 'url("' + url + '")';
      im.style.backgroundPosition = 'center';
      im.style.backgroundSize = fit || 'cover';   // headshots fill; logos pass 'contain'
      im.style.backgroundRepeat = 'no-repeat';
    } else {
      im.style.border = '1px dashed ' + tokenColor(theme, 'goldLine');
      im.textContent = label;
    }
    return im;
  }

  function boxOffset(project, key) {
    var o = project.boxOffsets && project.boxOffsets[key];
    return o ? { dx: o.dx || 0, dy: o.dy || 0 } : { dx: 0, dy: 0 };
  }
  function boxSize(project, key) {
    var s = project.boxSizes && project.boxSizes[key];
    return (typeof s === 'number' && s > 0) ? s : 1;
  }

  var splitAddress = TXT.splitAddress;   // -> templates/fsb-v2/text-util.js

  function fillStack(cont, project, theme, scale, box) {
    (box.lines || []).forEach(function (ln) {
      if (ln.spacer) { var sp = el('div'); sp.style.height = (ln.spacer * 100) + '%'; sp.style.maxHeight = '14px'; cont.appendChild(sp); return; }
      var raw = ln.text != null ? ln.text
        : ln.compose ? composeLine(project, ln.compose)
        : val(project, ln.field);
      raw = raw == null ? '' : String(raw);
      if (raw.trim() === '' || /^[\s|&]*$/.test(raw)) return;
      if (ln.fmt === 'phone') raw = formatPhone(raw);
      if (ln.splitAddr) {
        splitAddress(raw).forEach(function (part) {
          var an = textLine(theme, scale, part, ln.type, 'nowrap');
          an.setAttribute('data-fit-shrink', '1');
          an.setAttribute('data-fit-shrink-base', String(((ln.type && ln.type.sizePt) || 9) * scale));
          cont.appendChild(an);
        });
        return;
      }
      var mode = ln.nowrap ? 'nowrap' : ln.wrap ? 'wrap' : undefined;
      var node = textLine(theme, scale, (ln.label || '') + raw, ln.type, mode);
      if (ln.fitShrink) {
        node.setAttribute('data-fit-shrink', '1');
        node.setAttribute('data-fit-shrink-base', String(((ln.type && ln.type.sizePt) || 9) * scale));
      }
      cont.appendChild(node);
    });
  }

  function buildAgent(project, info, pw, ph, scale, theme, interactive, admin) {
    var card = el('div', { class: 'fsb-agent fsb-agent--' + info.variant });
    setBox(card, info.rect, pw, ph);
    card.style.cssText += ';box-sizing:border-box;overflow:hidden;color:' + tokenColor(theme, 'ink') +
      ';border:1px solid ' + tokenColor(theme, 'goldLine') + ';border-radius:' + (3 * scale) + 'px;' +
      'font-variant-numeric:lining-nums tabular-nums;';   // even, aligned phone/postal digits
    if (admin) card.classList.add('fsb-agent--admin');

    var bandW = info.rect[2] * pw, bandH = info.rect[3] * ph;

    (info.spec.boxes || []).forEach(function (b) {
      var off = boxOffset(project, b.key), sz = boxSize(project, b.key);
      var r = b.rect;
      var w = r[2] * bandW * sz, h = r[3] * bandH * sz;
      // b.aspect (height / width) locks the box shape regardless of the
      // band height -- headshots stay a true 3:2 portrait (h = 1.5 * w).
      // An aspect-locked box is centred vertically in the band (the rect
      // no longer dictates its height, so top-anchoring would float it).
      var topFrac = r[1];
      if (b.aspect) { h = w * b.aspect; topFrac = (bandH - h) / 2 / bandH; }
      var bx = el('div', { class: 'fsb-agent-box fsb-agent-box--' + b.kind, 'data-box-key': b.key });
      // stack + QR boxes don't clip -- the rect is a positioning anchor,
      // text (and the "ONLINE TOUR" caption) can spill a little. Only the
      // image / headshot boxes clip.
      bx.style.cssText = 'position:absolute;box-sizing:border-box;display:flex;flex-direction:column;' +
        'justify-content:center;gap:' + (2.5 * scale) + 'px;' +
        'overflow:' + (b.kind === 'stack' || b.kind === 'qr' ? 'visible' : 'hidden') + ';' +
        'left:' + ((r[0] + off.dx) * bandW) + 'px;top:' + ((topFrac + off.dy) * bandH) + 'px;' +
        'width:' + w + 'px;height:' + h + 'px;' +
        (b.align === 'left' ? 'align-items:flex-start;text-align:left;'
          : b.align === 'right' ? 'align-items:flex-end;text-align:right;'
          : 'align-items:center;text-align:center;');

      if (b.kind === 'headshot') {
        var hpid = val(project, (b.ref || 'agentInfo') + '.headshotPhotoId');
        bx.appendChild(imgBox(theme, scale, hpid && fullUrl(project, hpid), 'Headshot', 'cover'));
      } else if (b.kind === 'image') {
        var pid = val(project, b.img);
        bx.appendChild(imgBox(theme, scale, pid && fullUrl(project, pid), b.placeholder || '', 'contain'));
      } else if (b.kind === 'qr') {
        var url = val(project, b.qr);
        if (url) {
          var qpx = Math.max(20, Math.round(Math.min(w, h * 0.8) * sz));
          var qb = el('div', { class: 'fsb-agent-qr' });
          qb.style.cssText = 'width:' + qpx + 'px;height:' + qpx + 'px;background:#fff;padding:' +
            (2 * scale) + 'px;box-sizing:border-box;flex:0 0 auto;align-self:center;position:relative;';
          if (window.FSB.qr) window.FSB.qr.render(qb, url, { size: qpx, dark: '#141414', light: '#ffffff' });
          bx.appendChild(qb);
          if (b.caption) {
            var cap = textLine(theme, scale * (0.9 + 0.1 * sz), b.caption,
              b.captionType || { font: 'serif', sizePt: 9, tracking: 0.1, token: 'ink' }, 'nowrap');
            cap.style.marginTop = (3 * scale) + 'px';
            bx.appendChild(cap);
          }
        }
      } else { // stack -- scale the type with the box
        fillStack(bx, project, theme, scale * sz, b);
      }

      if (admin && interactive) {
        addBoxDrag(bx, project, b.key, bandW, bandH, [r[0], topFrac, r[2], r[3]]);
        var baseH = b.aspect ? (r[2] * bandW * b.aspect) : (r[3] * bandH);
        addBoxResize(bx, project, b.key, r[2] * bandW, baseH);
      }
      card.appendChild(bx);
    });
    return card;
  }

  // ---- Franky (admin): drag a box to move it, double-click to reset --
  function addBoxDrag(bx, project, key, bandW, bandH, baseRect) {
    if (!window.FSB.app || !window.FSB.app.mutateBoxOffset) return;
    bx.classList.add('fsb-agent-box--draggable');
    bx.title = '拖动移动 · 双击复位';
    bx.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.fsb-box-resize')) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, o0 = boxOffset(project, key);
      try { bx.setPointerCapture(e.pointerId); } catch (_e) {}
      bx.classList.add('is-dragging');
      function move(ev) {
        bx.style.left = ((baseRect[0] + o0.dx + (ev.clientX - sx) / bandW) * bandW) + 'px';
        bx.style.top = ((baseRect[1] + o0.dy + (ev.clientY - sy) / bandH) * bandH) + 'px';
      }
      function up(ev) {
        bx.removeEventListener('pointermove', move);
        bx.removeEventListener('pointerup', up);
        bx.classList.remove('is-dragging');
        var dxp = ev.clientX - sx, dyp = ev.clientY - sy;
        if (Math.abs(dxp) < 4 && Math.abs(dyp) < 4) {
          // no movement -> a click. Two within 350ms = reset. (We must NOT
          // re-render on the first click or renderStage would replace this
          // element before the second click lands.)
          var now = Date.now();
          if (bx._clickT && now - bx._clickT < 350) {
            bx._clickT = 0;
            if (window.FSB.app.resetBox) window.FSB.app.resetBox(key);
          } else {
            bx._clickT = now;
          }
          return;
        }
        window.FSB.app.mutateBoxOffset(key, o0.dx + dxp / bandW, o0.dy + dyp / bandH);
      }
      bx.addEventListener('pointermove', move);
      bx.addEventListener('pointerup', up);
    });
  }

  // ---- Franky (admin): corner grip to scale a box (0.4-2.5x) -------
  function addBoxResize(bx, project, key, baseW, baseH) {
    if (!window.FSB.app || !window.FSB.app.mutateBoxSize) return;
    var grip = el('div', { class: 'fsb-box-resize', title: '拖动缩放' });
    bx.appendChild(grip);
    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      var sx = e.clientX, sy = e.clientY, s0 = boxSize(project, key);
      var w0 = baseW * s0, h0 = baseH * s0;
      try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
      function clampF(ev) {
        var fw = (w0 + (ev.clientX - sx)) / w0, fh = (h0 + (ev.clientY - sy)) / h0;
        return Math.max(0.4, Math.min(2.5, s0 * Math.max(fw, fh)));
      }
      function move(ev) {
        var f = clampF(ev);
        bx.style.width = (baseW * f) + 'px';
        bx.style.height = (baseH * f) + 'px';
      }
      function up(ev) {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        window.FSB.app.mutateBoxSize(key, clampF(ev));
      }
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  // ---- flourish (page 2): the exact original filigree, extracted from
  //      the InDesign source to templates/fsb-v2/assets/flourish.svg and
  //      recoloured per theme via CSS mask.
  var FLOURISH_URL = '/shared/v2/assets/flourish.svg';
  function styleFlourish(node, color) {
    node.style.cssText += ';background-color:' + color +
      ';-webkit-mask:url(' + FLOURISH_URL + ') center/contain no-repeat' +
      ';mask:url(' + FLOURISH_URL + ') center/contain no-repeat;';
  }

  // ================================================================
  //  renderPage
  // ================================================================
  function renderPage(pageNum, project, opts) {
    opts = opts || {};
    var scale = opts.scale || 0.6;
    var interactive = !!opts.interactive;
    var admin = !!opts.admin;
    var pw = TRIM_W * scale, ph = TRIM_H * scale;
    var spec = V2.compose(project);
    var theme = spec.theme;

    var page = el('div', { class: 'fsb-page fsb-page--v2', 'data-page': pageNum });
    // Cormorant Garamond ships old-style figures; force lining figures so
    // digits (phone numbers, postal codes, bed/bath counts) are all
    // cap-height and even.
    page.style.cssText = 'position:relative;overflow:hidden;width:' + pw + 'px;height:' + ph + 'px;color:' +
      tokenColor(theme, 'ink') + ';font-variant-numeric:lining-nums;';
    page.style.background = theme.bg.css || tokenColor(theme, 'bg');

    if (pageNum === 1) {
      // LEFT column -- photo slots
      spec.page1.left.solved.bands.forEach(function (band) {
        if (band.kind === 'photos') {
          band.slots.forEach(function (s) {
            page.appendChild(buildSlot(project, s.id, s.rect, pw, ph, interactive));
          });
        }
      });
      // LEFT column -- description (only in the stagger5 variant).
      // Auto-fits: font size grows/shrinks (10–20pt) so the copy fills the
      // box height, whatever its length. fitTexts() does the sizing once
      // the node has layout.
      var LD = spec.page1.left.desc;
      if (LD) {
        var descEl = buildText(LD.rect, pw, ph, scale, {
          family: famFor(theme, (LD.type && LD.type.font) || 'serif'),
          sizePt: (LD.type && LD.type.sizePt) || 15,
          leadingPt: (LD.type && LD.type.leadingPt) || 21,
          align: (LD.type && LD.type.align) || 'justify',
          color: tokenColor(theme, 'ink'),
          text: LD.value || (opts.placeholders ? '房源描述 Property description…' : ''),
          cls: 'fsb-text--desc',
        });
        descEl.style.justifyContent = 'flex-start';
        descEl.setAttribute('data-fit', '1');
        descEl.setAttribute('data-fit-min', '10');
        descEl.setAttribute('data-fit-max', '20');
        descEl.setAttribute('data-fit-scale', String(scale));
        descEl.setAttribute('data-fit-lead', '1.4');
        page.appendChild(descEl);
      }

      // RIGHT column
      var R = spec.page1.right;
      var aT = R.address.spec.addressType, cT = R.address.spec.cityType;
      var aAlign = aT.align || 'center';
      var addr = buildText(R.address.rect, pw, ph, scale, {
        family: famFor(theme, aT.font || 'script'),
        sizePt: aT.sizePt, align: aAlign, weight: aT.weight || 500,
        italic: !!aT.italic, color: tokenColor(theme, 'ink'), vAlign: 'flex-start',
      });
      addr.textContent = '';
      addr.style.alignItems = 'stretch';
      addr.style.overflow = 'visible';   // never clip the city's descenders
      var l1 = el('div', { text: R.address.value.address || (opts.placeholders ? '123 Example St' : '') });
      l1.style.cssText = 'width:100%;text-align:' + aAlign + ';line-height:1.05;font-style:' +
        (aT.italic ? 'italic' : 'normal') + ';';
      var l2 = el('div', { text: R.address.value.city || (opts.placeholders ? 'City' : '') });
      l2.style.cssText = 'width:100%;text-align:' + (cT.align || 'center') + ';line-height:1.15;font-family:' +
        famFor(theme, cT.font || 'script') + ';font-size:' + (cT.sizePt * scale) + 'px;font-weight:' +
        (cT.weight || 500) + ';font-style:' + (cT.italic ? 'italic' : 'normal') +
        ';letter-spacing:' + (cT.tracking || 0) + 'em;';
      addr.appendChild(l1); addr.appendChild(l2);
      page.appendChild(addr);

      var hero = buildSlot(project, 'p1R-hero', R.hero.rect, pw, ph, interactive);
      var hbw = Math.max(2, R.hero.border.widthPt * scale);
      hero.style.border = hbw + 'px solid ' + tokenColor(theme, 'gold');
      hero.style.boxShadow = 'inset 0 0 0 ' + Math.max(1, hbw * 0.4) + 'px ' + tokenColor(theme, 'bg');
      hero.style.boxSizing = 'border-box';
      page.appendChild(hero);

      if (R.iconRow) page.appendChild(buildIconRow(R.iconRow, pw, ph, scale, theme));
      page.appendChild(buildAgent(project, R.agent, pw, ph, scale, theme, interactive, admin));

    } else {
      // PAGE 2
      var g2 = spec.page2;
      g2.flourish.forEach(function (fl) {
        var f = el('div', { class: 'fsb-flourish' });
        setBox(f, fl.rect, pw, ph);
        styleFlourish(f, tokenColor(theme, 'gold'));
        page.appendChild(f);
      });
      g2.panelBorder.forEach(function (pb) {
        var b = el('div', { class: 'fsb-panel-border' });
        setBox(b, pb.rect, pw, ph);
        b.style.cssText += ';border:' + (1.5 * scale) + 'px double ' + tokenColor(theme, 'goldLine') +
          ';box-sizing:border-box;pointer-events:none;';
        page.appendChild(b);
      });
      g2.slots.forEach(function (s) {
        page.appendChild(buildSlot(project, s.id, s.rect, pw, ph, interactive));
      });
    }

    page._fsb = { pageNum: pageNum, scale: scale, pw: pw, ph: ph,
      interactive: interactive, admin: admin, placeholders: !!opts.placeholders };
    return page;
  }

  function updateSlot(pageEl, project, slotId) {
    var m = pageEl && pageEl._fsb;
    var node = pageEl && pageEl.querySelector('.fsb-slot[data-slot-id="' + slotId + '"]');
    if (!node || !m) return;
    fillSlot(node, project, slotId, m.pw, m.ph, m.interactive);
  }

  function updateDynamic(pageEl, project) {
    var m = pageEl && pageEl._fsb;
    if (!m) return;
    var fresh = renderPage(m.pageNum, project, {
      scale: m.scale, interactive: m.interactive, admin: m.admin, placeholders: m.placeholders,
    });
    // MOVE the real DOM nodes across (don't go via innerHTML -- that
    // serialises the QR <canvas> to an empty element).
    while (pageEl.firstChild) pageEl.removeChild(pageEl.firstChild);
    while (fresh.firstChild) pageEl.appendChild(fresh.firstChild);
    pageEl.style.cssText = fresh.style.cssText;
    pageEl._fsb = fresh._fsb;
    fitTexts(pageEl);
  }

  // ---- auto-fit: size + leading so a text block fills its box evenly ----
  function fitTexts(pageEl) {
    var nodes = pageEl.querySelectorAll('[data-fit]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var maxPt = parseFloat(n.getAttribute('data-fit-max')) || 20;
      var minPt = parseFloat(n.getAttribute('data-fit-min')) || 9;
      var scale = parseFloat(n.getAttribute('data-fit-scale')) || 1;
      var lead = parseFloat(n.getAttribute('data-fit-lead')) || 1.4; // baseline leading / size
      var boxH = n.clientHeight;
      if (!boxH || !n.textContent.trim()) continue;

      // 1. largest font size that still fits at the baseline leading
      var lo = minPt, hi = maxPt, best = minPt;
      for (var k = 0; k < 14; k++) {
        var mid = (lo + hi) / 2;
        n.style.fontSize = (mid * scale) + 'px';
        n.style.lineHeight = (mid * scale * lead) + 'px';
        if (n.scrollHeight <= boxH + 1) { best = mid; lo = mid; } else { hi = mid; }
      }
      n.style.fontSize = (best * scale) + 'px';

      // 2. if the copy is short, open the leading up (to ~1.9x) so the
      //    lines spread and fill the remaining height evenly.
      var leadLo = lead, leadHi = 1.95, bestLead = lead;
      for (var j = 0; j < 12; j++) {
        var lm = (leadLo + leadHi) / 2;
        n.style.lineHeight = (best * scale * lm) + 'px';
        if (n.scrollHeight <= boxH + 1) { bestLead = lm; leadLo = lm; } else { leadHi = lm; }
      }
      n.style.lineHeight = (best * scale * bestLead) + 'px';
    }

    // email line: never wrap, never clip -- shrink the font (down to ~55%)
    // until the whole address fits on one line.
    var shr = pageEl.querySelectorAll('[data-fit-shrink]');
    for (var s = 0; s < shr.length; s++) {
      var e = shr[s];
      var base = parseFloat(e.getAttribute('data-fit-shrink-base')) || 12;
      if (!e.clientWidth || !e.textContent.trim()) continue;
      var size = base, floor = base * 0.5, guard = 0;
      e.style.fontSize = size + 'px';
      while (e.scrollWidth > e.clientWidth + 1 && size > floor && guard++ < 40) {
        size = Math.max(floor, size - base * 0.03);
        e.style.fontSize = size + 'px';
      }
    }
  }

  window.FSB.render = {
    renderPage: renderPage, updateSlot: updateSlot, updateDynamic: updateDynamic, fitTexts: fitTexts,
  };
})();
