/*
 * export-pdf.js -- the 2-page Feature Sheet PDF (admin export + studio submission).
 *
 * Pipeline:
 *   render each page's DOM at ~300 dpi -> html-to-image JPEG -> jsPDF page.
 *
 * Page geometry (fsb-v2):
 *   trim 1224 x 792 pt  (17 x 11 in landscape spread, folds at 8.5")
 *   NO bleed, NO crop / fold marks -- the PDF is exactly the trim box and
 *   the rasterised page is placed 1:1 over it. (A print-ready path with
 *   real bleed + vector marks + CMYK would replace renderPageToDataUrl.)
 *
 * Libraries (index.html): window.jspdf (jsPDF 2.5.1), window.htmlToImage.
 *
 * FSB.exportPdf.run(app)        -> build + let the user save it locally
 * FSB.exportPdf.buildBlob(app)  -> Promise<Blob>   (used by submit.js)
 * FSB.exportPdf.fileName(project)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var toast = window.FSB.util.toast;
  var render = window.FSB.render;

  var PT = 72;
  var TRIM_W = 1224, TRIM_H = 792;
  var DPI = 300;

  // raster the page DOM this much bigger than trim pt -> ~300 dpi in print
  var RENDER_SCALE = Math.ceil((DPI / PT) * 20) / 20;   // 4.2  (~302 dpi)

  function pageCount() {
    return (window.FSB_V2_GEOMETRY && window.FSB_V2_GEOMETRY.page && window.FSB_V2_GEOMETRY.page.count) || 2;
  }

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

  // -> Promise<dataURL>  (one rasterised page, trim proportions)
  function renderPageToDataUrl(pageNum, project) {
    var holder = el('div', { class: 'fsb-export-holder' });
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;margin:0;padding:0;background:#fff;';
    var pageEl = render.renderPage(pageNum, project, { scale: RENDER_SCALE, interactive: false, placeholders: false });
    holder.appendChild(pageEl);
    document.body.appendChild(holder);
    if (render.fitTexts) render.fitTexts(pageEl);   // description auto-fit, same as the editor

    var wPx = Math.round(TRIM_W * RENDER_SCALE);
    var hPx = Math.round(TRIM_H * RENDER_SCALE);

    return (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
      .then(function () { return waitImages(pageEl); })
      .then(function () { return new Promise(function (r) { setTimeout(r, 150); }); })
      .then(function () {
        return window.htmlToImage.toJpeg(pageEl, {
          width: wPx, height: hPx, pixelRatio: 1, quality: 0.92, backgroundColor: '#ffffff',
          style: { transform: 'none' },
        });
      })
      .then(function (url) { holder.remove(); return url; })
      .catch(function (err) { holder.remove(); throw err; });
  }

  function buildPdf(app) {
    if (!window.jspdf || !window.htmlToImage) {
      return Promise.reject(new Error('PDF libraries did not load (offline?)'));
    }
    var JsPDF = window.jspdf.jsPDF;
    var pdf = new JsPDF({ unit: 'pt', format: [TRIM_W, TRIM_H], orientation: 'landscape', compress: true });
    var n = pageCount();

    // job-linked sheets: pull the HDR original of every placed photo first (needs
    // the admin link) and render in print mode; always undo both afterwards.
    var ps = window.FSB.photoSource;
    var chain = Promise.resolve(ps.preparePrint ? ps.preparePrint(app.project, app.adminToken) : null)
      .then(function () { render.setPrintMode(true); });
    for (var p = 1; p <= n; p++) {
      (function (pageNum) {
        chain = chain
          .then(function () { return renderPageToDataUrl(pageNum, app.project); })
          .then(function (url) {
            if (pageNum > 1) pdf.addPage([TRIM_W, TRIM_H], 'landscape');
            pdf.addImage(url, 'JPEG', 0, 0, TRIM_W, TRIM_H, undefined, 'FAST');
          });
      })(p);
    }
    function done() { render.setPrintMode(false); if (ps.releasePrint) ps.releasePrint(); }
    return chain.then(function () { done(); return pdf; }, function (err) { done(); throw err; });
  }

  function buildBlob(app) {
    return buildPdf(app).then(function (pdf) { return pdf.output('blob'); });
  }

  function fileName(project) {
    var a = (project.propertyInfo && project.propertyInfo.address || '').trim();
    var base = a ? a.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() : 'Feature Sheet';
    return (a ? base + ' - ' : '') + 'Feature Sheet.pdf';
  }

  // Chrome only allows the save dialog within ~5s of the click, and building the PDF takes longer
  // (that made the first click fail). So open the dialog FIRST, inside the click, build while it
  // is open, then write into the chosen file. Resolves { write(blob), cancelled } or null (no picker).
  function openSaveTarget(name) {
    if (!window.showSaveFilePicker) return Promise.resolve(null);
    return window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    }).then(function (handle) { return { handle: handle }; }, function (err) {
      if (err && err.name === 'AbortError') return { cancelled: true };
      return null;   // picker unavailable here -> plain download instead
    });
  }

  function writeTarget(t, blob) {
    return t.handle.createWritable().then(function (w) {
      return w.write(blob).then(function () { return w.close(); });
    });
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function run(app) {
    var setBusy = window.FSB.app && window.FSB.app.setBusy;
    var name = fileName(app.project);
    return openSaveTarget(name).then(function (target) {
      if (target && target.cancelled) return 'cancelled';
      if (setBusy) setBusy('Building the PDF… 正在生成 PDF…');
      return buildPdf(app).then(function (pdf) {
        var blob = pdf.output('blob');
        if (target) return writeTarget(target, blob);
        download(blob, name);
      }).then(function () { return 'saved'; });
    }).then(function (how) {
      if (setBusy) setBusy(null);
      if (how === 'saved') toast('PDF exported 已导出');
    }).catch(function (err) {
      if (setBusy) setBusy(null);
      toast('Export failed 导出失败: ' + (err && err.message || err), 'error');
      throw err;
    });
  }

  window.FSB.exportPdf = { run: run, buildBlob: buildBlob, fileName: fileName };
})();
