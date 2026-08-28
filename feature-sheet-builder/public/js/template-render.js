/*
 * template-render.js -- turns (template-config + project) into DOM.
 *
 * This is the single geometry gate: the editor stage, the full preview,
 * and the PDF export all render through here, so what the client frames
 * is exactly what prints. Nothing here mutates the project or knows about
 * user interaction -- editor.js wires events onto the nodes this builds.
 *
 * window.FSB.render:
 *   renderPage(pageNum, project, opts) -> HTMLElement  (.fsb-page)
 *   updateSlot(pageEl, project, slotId)
 *   updateDynamic(pageEl, project)     -- refresh texts + headshot + logo + QR
 *
 * opts: { scale (px per pt, required), interactive (bool), placeholders (bool) }
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var T = window.FSB_TEMPLATE;
  var CROP = window.FSB_CROP;
  var el = window.FSB.util.el;
  var get = window.FSB.util.get;

  var METAL_BG =
    'repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, rgba(0,0,0,0.04) 1px 2px),' +
    'linear-gradient(180deg,#7f838a 0%,#c9ccd1 12%,#aeb2b8 30%,#dee1e5 50%,#a7abb1 70%,#c4c7cc 88%,#7c808700 100%),' +
    'linear-gradient(180deg,#8b8f96,#8b8f96)';

  function assetUrl(project, rel) {
    return '/template-assets/' + (project.templateId || T.id) + '/' + rel;
  }

  // Photo pixel size for crop-math -- always via the photo-source seam,
  // never project.photos directly (a Wix gallery source keeps its own list).
  function photoMeta(project, photoId) {
    return window.FSB.photoSource.getMeta(project, photoId);
  }

  function fullUrl(project, photoId) {
    return window.FSB.photoSource.fullUrl(project, photoId);
  }

  // ---- geometry ----------------------------------------------------------
  function pxRect(rect, pw, ph) {
    return { left: rect[0] * pw, top: rect[1] * ph, width: rect[2] * pw, height: rect[3] * ph };
  }
  function applyRect(node, rect, pw, ph) {
    var r = pxRect(rect, pw, ph);
    node.style.left = r.left + 'px';
    node.style.top = r.top + 'px';
    node.style.width = r.width + 'px';
    node.style.height = r.height + 'px';
  }

  // ---- overlays --------------------------------------------------------
  function buildOverlay(o, pw, ph) {
    var node = el('div', { class: 'fsb-overlay fsb-overlay--' + o.kind, 'data-overlay': o.id });
    applyRect(node, o.rect, pw, ph);
    var s = o.style || {};
    if (o.kind === 'frame') {
      node.style.background = s.fill || '#ffffff';
      if (s.border) {
        node.style.boxShadow = 'inset 0 0 0 ' + (s.border) + 'px ' + (s.color || '#fff') +
          (s.double ? (', inset 0 0 0 ' + (s.border + 3) + 'px ' + (s.color || '#fff')) : '');
      }
    } else if (o.kind === 'metal') {
      node.style.background = METAL_BG;
      node.style.backgroundBlendMode = 'overlay, normal, normal';
      if (s.clip) node.style.clipPath = s.clip;
      if (s.radius) {
        node.style.borderRadius = s.roundedCorners === 'top'
          ? (s.radius + 'px ' + s.radius + 'px 0 0') : (s.radius + 'px');
      }
      node.style.boxShadow = '0 1px 3px rgba(0,0,0,0.35)';
    } else if (o.kind === 'plate') {
      node.style.background = s.color || '#fff';
      if (s.radius) node.style.borderRadius = s.radius + 'px';
      node.style.boxShadow = '0 1px 4px rgba(0,0,0,0.25)';
    } else if (o.kind === 'hairline') {
      node.style.background = s.color || 'rgba(255,255,255,0.25)';
    }
    return node;
  }

  // ---- text fields ---------------------------------------------------
  // North-American phone -> dashed groups. Non-digits are stripped, so the
  // client can type "4165551234", "416 555 1234", "(416) 555-1234", etc.
  function formatPhone(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var d = s.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    if (d.length === 7) return d.slice(0, 3) + '-' + d.slice(3);
    return s; // leave anything unexpected untouched
  }
  function applyFmt(v, fmt) { return fmt === 'phone' ? formatPhone(v) : String(v); }

  function textContentFor(field, project, placeholders) {
    if (field.static != null) return { text: field.static, isPlaceholder: false };
    if (field.bindLines) {
      var lines = field.bindLines.map(function (line) {
        var parts = line.parts || line; // tolerate the older array shape
        var sep = line.sep != null ? line.sep : '';
        return parts.map(function (p) {
          var v = get(project, p.f);
          if (v == null || v === '') return null;
          return (p.label || p.prefix || '') + applyFmt(v, p.fmt);
        }).filter(function (x) { return x != null; }).join(sep);
      }).filter(function (l) { return l !== ''; });
      if (lines.length) return { text: lines.join('\n'), isPlaceholder: false };
      return { text: placeholders ? (field.placeholder || '') : '', isPlaceholder: true };
    }
    var val = get(project, field.bind);
    if (val != null && val !== '') return { text: applyFmt(val, field.format), isPlaceholder: false };
    return { text: placeholders ? (field.placeholder || '') : '', isPlaceholder: true };
  }

  function styleText(node, field, scale) {
    var font = T.fonts[field.font] || T.fonts.body;
    node.style.fontFamily = font.family;
    node.style.fontSize = (field.sizePt * scale) + 'px';
    node.style.lineHeight = (field.lineHeightPt * scale) + 'px';
    node.style.letterSpacing = field.letterSpacing || '0';
    node.style.textAlign = field.align || 'left';
    node.style.color = field.color || '#fff';
    node.style.fontWeight = field.weight || 400;
    node.style.fontStyle = field.italic ? 'italic' : 'normal';
    node.style.textTransform = field.transform || 'none';
    node.style.whiteSpace = 'pre-wrap';
    node.style.overflow = 'hidden';
    if (field.textShadow) node.style.textShadow = field.textShadow;
    if (field.maxLines) {
      node.style.display = '-webkit-box';
      node.style.webkitBoxOrient = 'vertical';
      node.style.WebkitLineClamp = String(field.maxLines);
    }
  }

  function buildText(field, project, pw, ph, scale, placeholders) {
    var node = el('div', { class: 'fsb-text', 'data-field': field.id });
    applyRect(node, field.rect, pw, ph);
    styleText(node, field, scale);
    var c = textContentFor(field, project, placeholders);
    node.textContent = c.text;
    node.classList.toggle('fsb-text--placeholder', c.isPlaceholder);
    return node;
  }

  // ---- photo slot ---------------------------------------------------
  function slotImg(project, slot, state, pw, ph) {
    var r = pxRect(slot.rect, pw, ph);
    var meta = photoMeta(project, state.photoId);
    var img = el('img', { class: 'fsb-slot-img', draggable: 'false', alt: '' });
    img.src = fullUrl(project, state.photoId);
    var layout = CROP.computeLayout({
      slotW: r.width, slotH: r.height,
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
    // Move handle -- own pill, top-left, obvious target for slot<->slot drag.
    frag.appendChild(el('div', { class: 'fsb-slot-move', 'data-action': 'drag', draggable: 'true',
      title: 'Drag onto another slot to move / swap this photo' }, [
      el('span', { class: 'fsb-slot-move-grip', text: '⠿' }),
      el('span', { class: 'fsb-slot-move-txt', text: 'Move' }),
    ]));
    // Crop + remove controls, top-right.
    frag.appendChild(el('div', { class: 'fsb-slot-tools' }, [
      el('button', { 'data-action': 'zoom-out', title: 'Zoom out', text: '−' }),
      el('button', { 'data-action': 'zoom-in', title: 'Zoom in', text: '+' }),
      el('button', { 'data-action': 'reset', title: 'Reset framing', text: '↺' }),
      el('button', { 'data-action': 'clear', title: 'Remove photo', text: '✕' }),
    ]));
    return frag;
  }

  function fillSlot(node, project, slot, pw, ph, interactive) {
    var state = get(project, 'pages.page' + slot.page + '.slots.' + slot.id) || { photoId: null, scale: 1, positionX: 0, positionY: 0 };
    node.innerHTML = '';
    // Any rebuild clears transient drag styling (opacity/highlight) so a
    // move/swap can't leave a slot looking dimmed.
    node.classList.remove('fsb-slot--dragging', 'fsb-slot--drop', 'fsb-slot--panning');
    // Only render a photo the source actually knows about; an unknown id
    // (deleted, or a remote list not loaded yet) shows as an empty slot.
    if (state.photoId && photoMeta(project, state.photoId) != null) {
      node.classList.add('fsb-slot--filled');
      node.classList.remove('fsb-slot--empty');
      node.appendChild(slotImg(project, slot, state, pw, ph));
      if (interactive) node.appendChild(slotToolbar());
    } else {
      node.classList.remove('fsb-slot--filled');
      node.classList.add('fsb-slot--empty');
      // Hint only in the editor; preview + PDF show an empty slot as just
      // the template frame showing through.
      if (interactive) {
        node.appendChild(el('div', { class: 'fsb-slot-hint' }, [
          el('div', { class: 'fsb-slot-hint-ico', text: '⬆' }),
          el('div', { class: 'fsb-slot-hint-label', text: slot.label || 'Photo' }),
        ]));
      }
    }
  }

  function buildSlot(project, slot, pw, ph, interactive) {
    var node = el('div', {
      class: 'fsb-slot' + (interactive ? ' fsb-slot--interactive' : ''),
      'data-slot-id': slot.id, 'data-page': slot.page,
    });
    applyRect(node, slot.rect, pw, ph);
    fillSlot(node, project, slot, pw, ph, interactive);
    return node;
  }

  // ---- headshot / logo / qr ---------------------------------------
  function buildHeadshot(project, pw, ph) {
    var h = T.headshotSlot;
    var d = h.diameter * pw;
    var node = el('div', { class: 'fsb-headshot', 'data-el': h.id });
    node.style.left = (h.center[0] * pw - d / 2) + 'px';
    node.style.top = (h.center[1] * ph - d / 2) + 'px';
    node.style.width = d + 'px';
    node.style.height = d + 'px';
    node.style.borderWidth = (h.ring.width) + 'px';
    node.style.borderColor = h.ring.color;
    var pid = get(project, h.bindPhotoId);
    var img = el('img', { class: 'fsb-cover-img', draggable: 'false', alt: '' });
    img.src = pid ? fullUrl(project, pid) : assetUrl(project, h.defaultAsset);
    node.appendChild(img);
    return node;
  }

  function buildLogo(project, pw, ph) {
    var l = T.logoSlot;
    var node = el('div', { class: 'fsb-logo', 'data-el': l.id });
    applyRect(node, l.rect, pw, ph);
    var pid = get(project, l.bindPhotoId);
    var img = el('img', { draggable: 'false', alt: '' });
    img.style.objectFit = l.fit || 'contain';
    img.src = pid ? fullUrl(project, pid) : assetUrl(project, l.defaultAsset);
    node.appendChild(img);
    return node;
  }

  function buildQr(project, pw, ph, scale) {
    var q = T.qrBlock;
    var wrap = el('div', { class: 'fsb-qr-wrap', 'data-el': q.id });
    var box = el('div', { class: 'fsb-qr' });
    applyRect(box, q.rect, pw, ph);
    wrap.appendChild(box);
    var cap = el('div', { class: 'fsb-qr-cap', text: q.caption });
    applyRect(cap, q.captionRect, pw, ph);
    cap.style.fontFamily = T.fonts.body.family;
    cap.style.fontSize = (11 * scale) + 'px';
    cap.style.letterSpacing = '0.06em';
    wrap.appendChild(cap);
    paintQr(box, get(project, q.source), q);
    return wrap;
  }

  function paintQr(box, url, q) {
    box.innerHTML = '';
    if (!url) { box.classList.add('fsb-qr--empty'); return; }
    box.classList.remove('fsb-qr--empty');
    window.FSB.qr.render(box, url, { dark: q.dark, light: q.light });
  }

  // ---- page assembly ----------------------------------------------
  function renderPage(pageNum, project, opts) {
    var scale = opts.scale;
    var pw = T.page.widthPt * scale;
    var ph = T.page.heightPt * scale;
    var interactive = !!opts.interactive;
    var placeholders = !!opts.placeholders;

    var page = el('div', { class: 'fsb-page', 'data-page': pageNum });
    page.style.width = pw + 'px';
    page.style.height = ph + 'px';

    // overlays for this page
    T.overlays.filter(function (o) { return o.page === pageNum; })
      .forEach(function (o) { page.appendChild(buildOverlay(o, pw, ph)); });

    // photo slots
    T.photoSlots.filter(function (s) { return s.page === pageNum; })
      .forEach(function (s) { page.appendChild(buildSlot(project, s, pw, ph, interactive)); });

    // headshot / logo / qr (page 1 only in this template)
    if (T.headshotSlot.page === pageNum) page.appendChild(buildHeadshot(project, pw, ph));
    if (T.logoSlot.page === pageNum) page.appendChild(buildLogo(project, pw, ph));
    if (T.qrBlock.page === pageNum) page.appendChild(buildQr(project, pw, ph, scale));

    // text fields on top
    T.textFields.filter(function (f) { return f.page === pageNum; })
      .forEach(function (f) { page.appendChild(buildText(f, project, pw, ph, scale, placeholders)); });

    page._fsb = { pageNum: pageNum, scale: scale, pw: pw, ph: ph, interactive: interactive, placeholders: placeholders };
    return page;
  }

  function updateSlot(pageEl, project, slotId) {
    var m = pageEl._fsb;
    var node = pageEl.querySelector('.fsb-slot[data-slot-id="' + slotId + '"]');
    if (!node || !m) return;
    var slot = T.photoSlots.filter(function (s) { return s.id === slotId; })[0];
    if (slot) fillSlot(node, project, slot, m.pw, m.ph, m.interactive);
  }

  function updateDynamic(pageEl, project) {
    var m = pageEl._fsb;
    if (!m) return;
    // texts
    T.textFields.filter(function (f) { return f.page === m.pageNum; }).forEach(function (f) {
      var node = pageEl.querySelector('.fsb-text[data-field="' + f.id + '"]');
      if (!node) return;
      var c = textContentFor(f, project, m.placeholders);
      node.textContent = c.text;
      node.classList.toggle('fsb-text--placeholder', c.isPlaceholder);
    });
    // headshot + logo
    if (T.headshotSlot.page === m.pageNum) {
      var hpid = get(project, T.headshotSlot.bindPhotoId);
      var himg = pageEl.querySelector('.fsb-headshot img');
      if (himg) himg.src = hpid ? fullUrl(project, hpid) : assetUrl(project, T.headshotSlot.defaultAsset);
    }
    if (T.logoSlot.page === m.pageNum) {
      var lpid = get(project, T.logoSlot.bindPhotoId);
      var limg = pageEl.querySelector('.fsb-logo img');
      if (limg) limg.src = lpid ? fullUrl(project, lpid) : assetUrl(project, T.logoSlot.defaultAsset);
    }
    // qr
    if (T.qrBlock.page === m.pageNum) {
      var box = pageEl.querySelector('.fsb-qr');
      if (box) paintQr(box, get(project, T.qrBlock.source), T.qrBlock);
    }
  }

  window.FSB.render = {
    PAGE: T.page,
    renderPage: renderPage,
    updateSlot: updateSlot,
    updateDynamic: updateDynamic,
  };
})();
