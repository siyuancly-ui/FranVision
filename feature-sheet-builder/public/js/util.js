/* Small shared helpers. Attaches to window.FSB.util */
(function () {
  'use strict';
  window.FSB = window.FSB || {};

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(node.style, attrs[k]);
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  // dot-path getter: get(obj, 'agentInfo.name')
  function get(obj, pathStr) {
    return pathStr.split('.').reduce(function (o, k) {
      return (o == null) ? undefined : o[k];
    }, obj);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (_e) { return iso; }
  }

  function toast(msg, kind) {
    var host = document.getElementById('fsb-toasts');
    if (!host) return;
    var t = el('div', { class: 'fsb-toast ' + (kind || 'info'), text: msg });
    host.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, kind === 'error' ? 5000 : 2600);
  }

  // In-app confirm dialog. Native window.confirm() is avoided: it is
  // blocked/suppressed inside cross-origin iframes (the Wix embed target)
  // and it stalls browser automation.
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var okBtn = el('button', { class: 'fsb-btn fsb-btn--primary', text: opts.okText || 'OK' });
      var cancelBtn = el('button', { class: 'fsb-btn fsb-btn--ghost', text: opts.cancelText || 'Cancel' });
      var card = el('div', { class: 'fsb-confirm-card' }, [
        el('p', { class: 'fsb-confirm-msg', text: message }),
        el('div', { class: 'fsb-confirm-actions' }, [cancelBtn, okBtn]),
      ]);
      var overlay = el('div', { class: 'fsb-confirm-overlay' }, [card]);
      function done(v) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); }
      okBtn.addEventListener('click', function () { done(true); });
      cancelBtn.addEventListener('click', function () { done(false); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  window.FSB.util = {
    el: el, debounce: debounce, get: get, escapeHtml: escapeHtml,
    formatDateTime: formatDateTime, toast: toast, confirmDialog: confirmDialog,
  };
})();
