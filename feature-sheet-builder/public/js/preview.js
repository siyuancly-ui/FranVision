/*
 * preview.js -- read-only proof of the final Feature Sheet.
 * Same renderer as the editor, at MEDIUM resolution and with a diagonal
 * watermark: enough to check photos / crops / text / layout, deliberately
 * not good enough to screenshot and print. The clean high-res output only
 * goes to the studio via Confirm & Submit.
 *
 * FSB.preview.open(app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var render = window.FSB.render;
  var T = window.FSB_TEMPLATE;

  // Cap the rendered page width -> ~medium res (well below print quality).
  var MAX_PREVIEW_PAGE_PX = 900;

  function open(app) {
    var pageCount = T.page.count;
    var overlay = el('div', { class: 'fsb-modal' });
    var bar = el('div', { class: 'fsb-modal-bar' }, [
      el('span', { class: 'fsb-modal-title', text: 'Preview 预览 — proof only, not for print / 仅供核对，不可用于打印' }),
      el('span', { class: 'fsb-modal-spacer' }),
      el('button', { class: 'fsb-btn fsb-btn--ghost', text: 'Close 关闭 (Esc)', onclick: close }),
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
      var scale = Math.min(avail / T.page.widthPt, MAX_PREVIEW_PAGE_PX / T.page.widthPt);
      for (var p = 1; p <= pageCount; p++) {
        var wrap = el('div', { class: 'fsb-modal-page' });
        wrap.appendChild(el('div', { class: 'fsb-modal-page-label', text: 'Page ' + p }));
        var pageEl = render.renderPage(p, app.project, { scale: scale, interactive: false, placeholders: false });
        pageEl.appendChild(el('div', { class: 'fsb-preview-wm' })); // watermark overlay (CSS)
        wrap.appendChild(pageEl);
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
