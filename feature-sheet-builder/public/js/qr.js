/*
 * qr.js -- render a QR code for the "Online Tour URL" into a box.
 * Uses qrcodejs (loaded from cdnjs in index.html) which emits both a
 * <canvas> and a data-URI <img>, so html-to-image / PDF export capture it
 * cleanly. Degrades to a labelled placeholder if the lib is unavailable.
 *
 * window.FSB.qr.render(boxEl, url, { dark, light })
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};

  function render(box, url, opts) {
    opts = opts || {};
    box.innerHTML = '';
    var size = Math.max(64, Math.round(Math.min(box.clientWidth, box.clientHeight) || 128));

    if (typeof window.QRCode === 'function') {
      try {
        // eslint-disable-next-line no-new
        new window.QRCode(box, {
          text: String(url),
          width: size,
          height: size,
          colorDark: opts.dark || '#111111',
          colorLight: opts.light || '#ffffff',
          correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 0,
        });
        // Make whatever it produced fill the box.
        var kid = box.querySelector('img') || box.querySelector('canvas');
        if (kid) { kid.style.width = '100%'; kid.style.height = '100%'; kid.style.display = 'block'; }
        return;
      } catch (_e) { /* fall through */ }
    }

    var ph = document.createElement('div');
    ph.className = 'fsb-qr-ph';
    ph.textContent = 'QR';
    box.appendChild(ph);
  }

  window.FSB.qr = { render: render };
})();
