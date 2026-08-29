/*
 * export-pdf.js -- 2-page PDF at the template's exact point size.
 *
 * Pipeline (kept behind renderPageToImage so it can be swapped for a
 * vector / print-ready path later without touching callers):
 *   render page DOM at high scale -> html-to-image PNG -> jsPDF page.
 *
 * Libraries load from cdnjs in index.html: window.jspdf, window.htmlToImage.
 *
 * FSB.exportPdf.buildBlob(app)  -> Promise<Blob>   (used by submit.js)
 * FSB.exportPdf.fileName(project)
 * FSB.exportPdf.run(app)        -> save to disk (dev / debugging only)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var toast = window.FSB.util.toast;
  var render = window.FSB.render;
  var T = window.FSB_TEMPLATE;

  var EXPORT_PAGE_WIDTH_PX = 2480; // ~3x of on-screen; good quality, sane size

  function waitImages(node) {
    var imgs = [].slice.call(node.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise(function (res) {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      });
    }));
  }

  // -> Promise<{ dataUrl, wPx, hPx }>
  function renderPageToImage(pageNum, project) {
    var scale = EXPORT_PAGE_WIDTH_PX / T.page.widthPt;
    var holder = el('div', { class: 'fsb-export-holder' });
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;margin:0;padding:0;background:#fff;';
    var pageEl = render.renderPage(pageNum, project, { scale: scale, interactive: false, placeholders: false });
    holder.appendChild(pageEl);
    document.body.appendChild(holder);

    var wPx = Math.round(T.page.widthPt * scale);
    var hPx = Math.round(T.page.heightPt * scale);

    return (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
      .then(function () { return waitImages(pageEl); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 60); }); })
      .then(function () {
        return window.htmlToImage.toPng(pageEl, {
          width: wPx, height: hPx, pixelRatio: 1, cacheBust: true,
          style: { transform: 'none' },
        });
      })
      .then(function (dataUrl) {
        holder.remove();
        return { dataUrl: dataUrl, wPx: wPx, hPx: hPx };
      })
      .catch(function (err) { holder.remove(); throw err; });
  }

  function fileName(project) {
    var a = (project.propertyInfo && project.propertyInfo.address || '').trim();
    var base = a ? a.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() : 'Feature Sheet';
    return (a ? base + ' - ' : '') + 'Feature Sheet.pdf';
  }

  // -> Promise<jsPDF>
  function buildPdf(app) {
    if (!window.jspdf || !window.htmlToImage) {
      return Promise.reject(new Error('PDF libraries did not load (offline?)'));
    }
    var JsPDF = window.jspdf.jsPDF;
    var pdf = new JsPDF({ unit: 'pt', format: [T.page.widthPt, T.page.heightPt], orientation: 'landscape', compress: true });
    var pw = pdf.internal.pageSize.getWidth();
    var ph = pdf.internal.pageSize.getHeight();

    var chain = Promise.resolve();
    for (var p = 1; p <= T.page.count; p++) {
      (function (pageNum) {
        chain = chain.then(function () { return renderPageToImage(pageNum, app.project); })
          .then(function (out) {
            if (pageNum > 1) pdf.addPage([T.page.widthPt, T.page.heightPt], 'landscape');
            pdf.addImage(out.dataUrl, 'PNG', 0, 0, pw, ph, undefined, 'FAST');
          });
      })(p);
    }
    return chain.then(function () { return pdf; });
  }

  function buildBlob(app) {
    return buildPdf(app).then(function (pdf) { return pdf.output('blob'); });
  }

  function run(app) {
    var btnBusy = window.FSB.app && window.FSB.app.setBusy;
    if (btnBusy) btnBusy('Exporting PDF…');
    return buildPdf(app).then(function (pdf) {
      pdf.save(fileName(app.project));
      if (btnBusy) btnBusy(null);
      toast('PDF exported.');
    }).catch(function (err) {
      if (btnBusy) btnBusy(null);
      toast('Export failed: ' + (err && err.message || err), 'error');
      throw err;
    });
  }

  window.FSB.exportPdf = { run: run, buildBlob: buildBlob, fileName: fileName, renderPageToImage: renderPageToImage };
})();
