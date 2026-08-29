/*
 * photo-picker.js -- click a slot -> pick a photo from a modal grid.
 *
 * This is the primary way photos get into slots (dragging from the
 * library was removed to keep it simple). Reads the list through
 * FSB.photoSource, assigns through FSB.app.
 *
 * FSB.photoPicker.open(app, ref)   where ref = { page, slotId }
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var src = window.FSB.photoSource;

  function open(app, ref) {
    if (app.isReadOnly()) return;
    var project = app.project;
    var photos = src.list(project);
    var current = (project.pages['page' + ref.page].slots[ref.slotId] || {}).photoId || null;

    var grid = el('div', { class: 'fsb-picker-grid' });
    var overlay = el('div', { class: 'fsb-modal fsb-picker' });
    var bar = el('div', { class: 'fsb-modal-bar' }, [
      el('span', { class: 'fsb-modal-title', text: 'Choose a photo  ·  选择照片' }),
      el('span', { class: 'fsb-modal-spacer' }),
      current ? el('button', { class: 'fsb-btn fsb-btn--ghost', text: 'Clear slot 清空', onclick: function () { app.clearSlot(ref); close(); } }) : null,
      el('button', { class: 'fsb-btn fsb-btn--ghost', text: 'Cancel 取消', onclick: close }),
    ]);
    var body = el('div', { class: 'fsb-modal-scroll' }, [grid]);
    overlay.appendChild(bar);
    overlay.appendChild(body);

    if (!photos.length) {
      grid.appendChild(el('div', { class: 'fsb-picker-empty', text: 'No photos yet — upload some in the Photo Library on the left. 请先在左侧图库上传照片。' }));
    }

    photos.forEach(function (p) {
      var used = app.slotsUsingPhoto(p.id);
      var img = el('img', { loading: 'lazy', draggable: 'false', alt: p.filename });
      img.src = src.thumbUrl(project, p.id);
      var tile = el('div', {
        class: 'fsb-picker-tile' + (p.id === current ? ' is-current' : '') + (used ? ' is-used' : ''),
        title: p.filename,
        onclick: function () { app.assignPhotoToSlot(ref, p.id); close(); },
      }, [
        img,
        used ? el('span', { class: 'fsb-picker-badge', text: '×' + used }) : null,
        p.id === current ? el('span', { class: 'fsb-picker-cur', text: '✓' }) : null,
      ]);
      grid.appendChild(tile);
    });

    function onKey(e) { if (e.key === 'Escape') close(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('fsb-modal-open');
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.classList.add('fsb-modal-open');
  }

  window.FSB.photoPicker = { open: open };
})();
