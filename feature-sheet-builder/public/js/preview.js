/*
 * preview.js -- full-size, read-only preview of both pages.
 * Same renderer as the editor and PDF export, so it is an accurate proof
 * of the final Feature Sheet (photos, crops, property + agent info, layout).
 *
 * FSB.preview.open(app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var render = window.FSB.render;
  var T = window.FSB_TEMPLATE;

  function open(app) {
    var pageCount = T.page.count;
    var overlay = el('div', { class: 'fsb-modal' });
    var bar = el('div', { class: 'fsb-modal-bar' }, [
      el('span', { class: 'fsb-modal-title', text: 'Preview — final Feature Sheet' }),
      el('span', { class: 'fsb-modal-spacer' }),
      el('button', { class: 'fsb-btn fsb-btn--ghost', text: 'Close (Esc)', onclick: close }),
    ]);
    var scroll = el('div', { class: 'fsb-modal-scroll' });
    var pages = el('div', { class: 'fsb-modal-pages' });
    scroll.appendChild(pages);
    overlay.appendChild(bar);
    overlay.appendChild(scroll);
    document.body.appendChild(overlay);
    document.body.classList.add('fsb-modal-open');

    function draw() {
      pages.innerHTML = '';
      var avail = scroll.clientWidth - 48;
      var scale = Math.min(avail / T.page.widthPt, 1600 / T.page.widthPt);
      for (var p = 1; p <= pageCount; p++) {
        var wrap = el('div', { class: 'fsb-modal-page' });
        wrap.appendChild(el('div', { class: 'fsb-modal-page-label', text: 'Page ' + p }));
        wrap.appendChild(render.renderPage(p, app.project, { scale: scale, interactive: false, placeholders: false }));
        pages.appendChild(wrap);
      }
    }

    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      overlay.remove();
      document.body.classList.remove('fsb-modal-open');
    }
    var onResize = window.FSB.util.debounce(draw, 150);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    draw();
  }

  window.FSB.preview = { open: open };
})();
