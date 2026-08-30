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
    return which === 'serif' ? theme.fonts.serif.family : theme.fonts.sans.family;
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
      el('button', { 'data-action': 'change', title: 'Change photo 换图', text: '⇄' }),
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

  // ---- icon glyphs (simple line SVGs) ---------------------------
  var ICONS = {
    bed: '<svg viewBox="0 0 32 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4v13M2 17h28M30 17v-6a4 4 0 0 0-4-4H10v6M2 11h8"/><circle cx="7" cy="9" r="2.2"/></svg>',
    bath: '<svg viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 3v10M4 13h26v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM4 8h4a3 3 0 0 1 3-3"/><path d="M8 20l-1 2M24 20l1 2"/></svg>',
    garage: '<svg viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 22V9l13-6 13 6v13M7 22v-9h18v9M7 16h18M7 19h18"/></svg>',
  };

  function buildIconRow(info, pw, ph, scale, theme) {
    var box = el('div', { class: 'fsb-iconrow' });
    setBox(box, info.rect, pw, ph);
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.gap = (info.rect[2] * pw * 0.06) + 'px';
    box.style.color = tokenColor(theme, 'gold');
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

  function textLine(theme, scale, t, ty, wrap) {
    var p = el('div', { text: String(t) });
    ty = ty || {};
    p.style.fontFamily = famFor(theme, ty.font || 'sans');
    p.style.fontSize = ((ty.sizePt || 9) * scale) + 'px';
    p.style.fontWeight = ty.weight || 400;
    p.style.letterSpacing = ty.tracking ? ty.tracking + 'em' : 'normal';
    p.style.color = ty.token ? tokenColor(theme, ty.token) : tokenColor(theme, 'ink');
    p.style.lineHeight = 1.34;
    p.style.maxWidth = '100%';
    if (wrap) {
      p.style.whiteSpace = 'normal';
      p.style.wordBreak = 'break-word';
    } else {
      p.style.whiteSpace = 'nowrap';
      p.style.overflow = 'hidden';
      p.style.textOverflow = 'ellipsis';
    }
    return p;
  }

  // two side-by-side per-agent contact stacks (Tel / Email), for the
  // co-listing agent card centre column.
  function contactRow(project, theme, scale, pairs, ty) {
    var wrap = el('div');
    wrap.style.cssText = 'display:flex;gap:' + (10 * scale) + 'px;width:100%;justify-content:center;' +
      'margin-top:' + (3 * scale) + 'px;';
    pairs.forEach(function (pr) {
      var tel = val(project, pr.tel), email = val(project, pr.email);
      if (!tel && !email) return;
      var col = el('div');
      col.style.cssText = 'flex:1;min-width:0;text-align:center;';
      if (tel) col.appendChild(textLine(theme, scale, 'Tel: ' + formatPhone(tel), ty, false));
      if (email) col.appendChild(textLine(theme, scale, 'Email: ' + email, ty, true));
      wrap.appendChild(col);
    });
    return wrap.children.length ? wrap : null;
  }

  function formatPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return String(raw || '');
  }

  function buildAgent(project, info, pw, ph, scale, theme) {
    var box = el('div', { class: 'fsb-agent fsb-agent--' + info.variant });
    setBox(box, info.rect, pw, ph);
    var boxH = info.rect[3] * ph;
    var pad = Math.max(6, 12 * scale);
    box.style.cssText += ';display:flex;align-items:stretch;box-sizing:border-box;overflow:hidden;' +
      'gap:' + (info.rect[2] * pw * 0.025) + 'px;padding:' + pad + 'px;' +
      'color:' + tokenColor(theme, 'ink') + ';border:1px solid ' + tokenColor(theme, 'goldLine') +
      ';border-radius:' + (3 * scale) + 'px;';

    (info.spec.cols || []).forEach(function (col) {
      var c = el('div', { class: 'fsb-agent-col fsb-agent-col--' + col.kind });
      c.style.cssText = 'flex:' + col.wFrac + ' 1 0;min-width:0;display:flex;flex-direction:column;' +
        'justify-content:center;gap:' + (2 * scale) + 'px;' +
        ((info.spec.align === 'center' || col.align === 'center') ? 'align-items:center;text-align:center;' : '');

      if (col.kind === 'headshot') {
        var hpid = val(project, (col.ref || 'agentInfo') + '.headshotPhotoId');
        var hb = imgBox(theme, scale, hpid && fullUrl(project, hpid), 'Headshot',
          col.fullHeight ? boxH - pad * 2 : boxH * 0.66);
        hb.style.flex = '1 1 auto';
        c.appendChild(hb);
      } else if (col.kind === 'stack') {
        (col.lines || []).forEach(function (ln) {
          if (ln.spacer) {
            var sp = el('div'); sp.style.height = (ln.spacer * ph) + 'px'; c.appendChild(sp); return;
          }
          if (ln.img) {
            var pid = val(project, ln.img);
            var im = imgBox(theme, scale, pid && fullUrl(project, pid), ln.placeholder || '',
              (ln.hFrac || 0.3) * boxH);
            im.style.flex = '0 0 auto'; im.style.alignSelf = 'stretch';
            c.appendChild(im); return;
          }
          if (ln.qr) {
            var url = val(project, ln.qr);
            if (!url) return;
            var qpx = Math.max(22, Math.round(boxH * 0.20));
            var qb = el('div', { class: 'fsb-agent-qr' });
            qb.style.cssText = 'width:' + qpx + 'px;height:' + qpx + 'px;background:#fff;padding:' +
              (2 * scale) + 'px;box-sizing:border-box;flex:0 0 auto;margin-top:' + (3 * scale) + 'px;align-self:center;';
            if (window.FSB.qr) window.FSB.qr.render(qb, url, { size: qpx, dark: '#141414', light: '#ffffff' });
            c.appendChild(qb); return;
          }
          if (ln.contactRow) {
            var cr = contactRow(project, theme, scale, ln.contactRow, ln.type);
            if (cr) c.appendChild(cr);
            return;
          }
          var t = ln.text != null ? ln.text
            : ln.compose ? composeLine(project, ln.compose)
            : val(project, ln.field);
          if (t == null || String(t).trim() === '' || /^[\s|&]*$/.test(String(t))) return;
          c.appendChild(textLine(theme, scale, t, ln.type, ln.wrap));
        });
      }
      box.appendChild(c);
    });
    return box;
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
    var pw = TRIM_W * scale, ph = TRIM_H * scale;
    var spec = V2.compose(project);
    var theme = spec.theme;

    var page = el('div', { class: 'fsb-page fsb-page--v2', 'data-page': pageNum });
    page.style.cssText = 'position:relative;overflow:hidden;width:' + pw + 'px;height:' + ph + 'px;color:' +
      tokenColor(theme, 'ink') + ';';
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
      // LEFT column -- description (only in the stagger5 variant)
      var LD = spec.page1.left.desc;
      if (LD) {
        page.appendChild(buildText(LD.rect, pw, ph, scale, {
          family: famFor(theme, (LD.type && LD.type.font) || 'serif'),
          sizePt: (LD.type && LD.type.sizePt) || 16,
          leadingPt: (LD.type && LD.type.leadingPt) || 22,
          align: (LD.type && LD.type.align) || 'justify',
          color: tokenColor(theme, 'ink'),
          text: LD.value || (opts.placeholders ? '房源描述 Property description…' : ''),
          cls: 'fsb-text--desc',
        }));
      }

      // RIGHT column
      var R = spec.page1.right;
      var addr = buildText(R.address.rect, pw, ph, scale, {
        family: famFor(theme, 'serif'),
        sizePt: R.address.spec.addressType.sizePt,
        align: 'right', weight: 700, color: tokenColor(theme, 'ink'),
        vAlign: 'flex-start',
      });
      addr.textContent = '';
      addr.style.alignItems = 'stretch';
      var l1 = el('div', { text: R.address.value.address || (opts.placeholders ? '123 Example St' : '') });
      l1.style.textAlign = 'right';
      var l2 = el('div', { text: R.address.value.city || (opts.placeholders ? 'City' : '') });
      // city line is CENTRED under the (right-aligned) street address
      l2.style.cssText = 'width:100%;text-align:center;font-size:' + (R.address.spec.cityType.sizePt * scale) +
        'px;font-style:italic;letter-spacing:' + R.address.spec.cityType.tracking + 'em;';
      addr.appendChild(l1); addr.appendChild(l2);
      page.appendChild(addr);

      var hero = buildSlot(project, 'p1R-hero', R.hero.rect, pw, ph, interactive);
      var hbw = Math.max(2, R.hero.border.widthPt * scale);
      hero.style.border = hbw + 'px solid ' + tokenColor(theme, 'gold');
      hero.style.boxShadow = 'inset 0 0 0 ' + Math.max(1, hbw * 0.4) + 'px ' + tokenColor(theme, 'bg');
      hero.style.boxSizing = 'border-box';
      page.appendChild(hero);

      if (R.iconRow) page.appendChild(buildIconRow(R.iconRow, pw, ph, scale, theme));
      page.appendChild(buildAgent(project, R.agent, pw, ph, scale, theme));

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
      interactive: interactive, placeholders: !!opts.placeholders };
    return page;
  }

  function updateSlot(pageEl, project, slotId) {
    var m = pageEl && pageEl._fsb;
    var node = pageEl && pageEl.querySelector('.fsb-slot[data-slot-id="' + slotId + '"]');
    if (!node || !m) return;
    fillSlot(node, project, slotId, m.pw, m.ph, m.interactive);
  }

  function updateDynamic(pageEl, project) {
    // simplest correct approach: rebuild the page in place
    var m = pageEl && pageEl._fsb;
    if (!m) return;
    var fresh = renderPage(m.pageNum, project, {
      scale: m.scale, interactive: m.interactive, placeholders: m.placeholders,
    });
    pageEl.innerHTML = fresh.innerHTML;
    pageEl.style.cssText = fresh.style.cssText;
    pageEl._fsb = fresh._fsb;
  }

  window.FSB.render = { renderPage: renderPage, updateSlot: updateSlot, updateDynamic: updateDynamic };
})();
