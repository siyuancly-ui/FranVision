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

  // ---- photo slot (editor-compatible DOM) --------------------------
  function slotState(project, id) {
    var pg = id.indexOf('p2') === 0 ? 'page2' : 'page1';
    var s = project.pages[pg].slots[id];
    if (!s) { s = { photoId: null, positionX: 0, positionY: 0, scale: 1 }; project.pages[pg].slots[id] = s; }
    return s;
  }
  function pageKeyOf(id) { return id.indexOf('p2') === 0 ? 2 : 1; }

  function buildSlot(project, id, rect, pw, ph, interactive) {
    var wrap = el('div', { class: 'fsb-slot', 'data-slot-id': id, 'data-page': pageKeyOf(id) });
    setBox(wrap, rect, pw, ph);
    fillSlot(wrap, project, id, pw, ph, interactive);
    return wrap;
  }

  function fillSlot(wrap, project, id, pw, ph, interactive) {
    wrap.classList.remove('fsb-slot--dragging', 'fsb-slot--drop', 'fsb-slot--panning');
    var st = slotState(project, id);
    wrap.innerHTML = '';
    if (st.photoId) {
      wrap.classList.remove('fsb-slot--empty');
      var img = el('img', { class: 'fsb-slot-img', src: fullUrl(project, st.photoId), alt: '' });
      var CROP = window.FSB_CROP;
      if (CROP && CROP.applyToImg) CROP.applyToImg(img, st, wrap, project, id);
      else img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
      wrap.appendChild(img);
      if (interactive) {
        wrap.appendChild(el('div', { class: 'fsb-slot-tools' }, [
          el('button', { type: 'button', 'data-action': 'change', title: '换图', text: '⇄' }),
          el('button', { type: 'button', 'data-action': 'clear', title: '清空', text: '×' }),
          el('span', { class: 'fsb-slot-move', 'data-action': 'move', title: '移动', text: '⠢' }),
        ]));
      }
    } else {
      wrap.classList.add('fsb-slot--empty');
      wrap.appendChild(el('div', { class: 'fsb-slot-hint', text: 'Click to add a photo\n点击选择照片' }));
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

  function buildAgent(project, info, pw, ph, scale, theme) {
    var box = el('div', { class: 'fsb-agent fsb-agent--' + info.variant });
    setBox(box, info.rect, pw, ph);
    box.style.display = 'flex';
    box.style.alignItems = 'stretch';
    box.style.gap = (info.rect[2] * pw * 0.02) + 'px';
    box.style.color = tokenColor(theme, 'ink');
    box.style.border = '1px solid ' + tokenColor(theme, 'goldLine');
    box.style.borderRadius = (4 * scale) + 'px';
    box.style.padding = (10 * scale) + 'px';
    box.style.boxSizing = 'border-box';

    (info.spec.cols || []).forEach(function (col) {
      var c = el('div', { class: 'fsb-agent-col fsb-agent-col--' + col.kind });
      c.style.flex = col.wFrac;
      c.style.display = 'flex';
      c.style.flexDirection = 'column';
      c.style.justifyContent = 'center';
      if (info.spec.align === 'center' || col.align === 'center') c.style.alignItems = 'center';
      if (col.kind === 'logo' || col.kind === 'headshot') {
        var pid = col.kind === 'logo'
          ? val(project, 'agentInfo.brokerageLogoPhotoId')
          : val(project, (col.ref || 'agentInfo') + '.headshotPhotoId');
        var im = el('div', { class: 'fsb-agent-img' });
        im.style.cssText = 'flex:1;background:#0002 center/contain no-repeat;border-radius:2px;min-height:' +
          (info.rect[3] * ph * 0.5) + 'px;';
        if (pid) im.style.backgroundImage = 'url(' + fullUrl(project, pid) + ')';
        else im.appendChild(el('span', { class: 'fsb-agent-imghint',
          text: col.kind === 'logo' ? 'Logo' : 'Headshot' }));
        im.querySelector && (im.style.display = 'flex');
        im.style.alignItems = 'center'; im.style.justifyContent = 'center';
        im.style.color = tokenColor(theme, 'inkMuted');
        im.style.fontSize = (9 * scale) + 'px';
        c.appendChild(im);
      } else if (col.kind === 'stack') {
        (col.lines || []).forEach(function (ln) {
          var t = ln.text != null ? ln.text
            : ln.compose ? composeLine(project, ln.compose)
            : val(project, ln.field);
          if (t == null || String(t).trim() === '') return;
          var p = el('div', { text: String(t) });
          var ty = ln.type || {};
          p.style.fontFamily = famFor(theme, ty.font || 'sans');
          p.style.fontSize = ((ty.sizePt || 9) * scale) + 'px';
          p.style.fontWeight = ty.weight || 400;
          p.style.letterSpacing = ty.tracking ? ty.tracking + 'em' : 'normal';
          p.style.color = ty.token ? tokenColor(theme, ty.token) : 'inherit';
          p.style.lineHeight = 1.32;
          c.appendChild(p);
        });
        if (col.logoBelow) {
          var lb = el('div', { class: 'fsb-agent-logo-below', text: 'Logo' });
          lb.style.cssText = 'margin-top:' + (6 * scale) + 'px;height:' + (info.rect[3] * ph * 0.28) +
            'px;background:#0002 center/contain no-repeat;display:flex;align-items:center;justify-content:center;font-size:' +
            (9 * scale) + 'px;color:' + tokenColor(theme, 'inkMuted') + ';';
          var lpid = val(project, 'agentInfo.brokerageLogoPhotoId');
          if (lpid) { lb.style.backgroundImage = 'url(' + fullUrl(project, lpid) + ')'; lb.textContent = ''; }
          c.appendChild(lb);
        }
      }
      box.appendChild(c);
    });
    return box;
  }

  // ---- flourish + panel border (page 2) -----------------------
  function flourishSvg(color) {
    return '<svg viewBox="0 0 200 60" fill="' + color + '"><path d="M100 8c6 0 11 5 14 12 3-5 8-8 14-8-4 3-6 8-6 13 5-2 10-1 14 2-5 0-9 3-11 8 6 1 11 5 13 11-6-4-13-5-19-2 2 5 1 11-3 15 1-6-1-12-5-16-4 4-6 10-5 16-4-4-5-10-3-15-6-3-13-2-19 2 2-6 7-10 13-11-2-5-6-8-11-8 4-3 9-4 14-2 0-5-2-10-6-13 6 0 11 3 14 8 3-7 8-12 14-12z"/><path d="M40 34h40M120 34h40" stroke="' + color + '" stroke-width="2"/><circle cx="30" cy="34" r="3"/><circle cx="170" cy="34" r="3"/></svg>';
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
      // LEFT column
      spec.page1.left.solved.bands.forEach(function (band) {
        if (band.kind === 'photos') {
          band.slots.forEach(function (s) {
            page.appendChild(buildSlot(project, s.id, s.rect, pw, ph, interactive));
          });
        } else if (band.kind === 'text') {
          page.appendChild(buildText(band.rect, pw, ph, scale, {
            family: famFor(theme, (band.type && band.type.font) || 'serif'),
            sizePt: (band.type && band.type.sizePt) || 15,
            leadingPt: (band.type && band.type.leadingPt) || 20,
            align: (band.type && band.type.align) || 'left',
            color: tokenColor(theme, 'ink'),
            text: val(project, band.field) ||
              (opts.placeholders ? '房源描述 Property description…' : ''),
            cls: 'fsb-text--desc',
          }));
        }
      });

      // RIGHT column
      var R = spec.page1.right;
      var addr = buildText(R.address.rect, pw, ph, scale, {
        family: famFor(theme, 'serif'),
        sizePt: R.address.spec.addressType.sizePt,
        align: 'right', weight: 700, color: tokenColor(theme, 'ink'),
        vAlign: 'flex-start',
      });
      addr.textContent = '';
      var l1 = el('div', { text: R.address.value.address || (opts.placeholders ? '123 Example St' : '') });
      var l2 = el('div', { text: R.address.value.city || (opts.placeholders ? 'City' : '') });
      l2.style.cssText = 'font-size:' + (R.address.spec.cityType.sizePt * scale) + 'px;font-style:italic;letter-spacing:' +
        R.address.spec.cityType.tracking + 'em;';
      addr.appendChild(l1); addr.appendChild(l2);
      page.appendChild(addr);

      var hero = buildSlot(project, 'p1R-hero', R.hero.rect, pw, ph, interactive);
      hero.style.border = (R.hero.border.widthPt * scale) + 'px solid ' + tokenColor(theme, 'gold');
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
        f.innerHTML = flourishSvg(tokenColor(theme, 'gold'));
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
