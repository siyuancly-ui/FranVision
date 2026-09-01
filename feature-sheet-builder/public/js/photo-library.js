/*
 * photo-library.js -- batch upload + scrollable thumbnail grid + drag source.
 *
 * Reads/writes photos through FSB.photoSource (v1 = project uploads).
 * Thumbnails are draggable with MIME `application/x-fsb-photo` = photoId,
 * which editor.js drops into slots.
 *
 * FSB.library.mount(rootEl, app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var toast = window.FSB.util.toast;
  var src = window.FSB.photoSource;
  var MIME_PHOTO = 'application/x-fsb-photo';

  var ACCEPT = ['image/jpeg', 'image/jpg', 'image/png'];
  var MAX_CONCURRENT = 3;

  function mount(root, app) {
    root.innerHTML = '';
    // The library adapts to the photo source: an upload source shows the
    // upload button + dropzone + per-photo delete; a read-only source
    // (e.g. a Wix gallery) shows just the scrollable grid.
    var canUpload = !!(src.supportsUpload && src.supportsUpload());

    var head = el('div', { class: 'fsb-lib-head' }, [
      el('div', { class: 'fsb-lib-title' }, [
        el('span', { text: 'Photo Library' }),
        el('span', { class: 'fsb-lib-count', id: 'fsb-lib-count', text: '0' }),
      ]),
    ]);
    if (canUpload) {
      var label = el('label', { class: 'fsb-btn fsb-btn--primary fsb-upload-btn' }, [document.createTextNode('Upload photos 上传照片')]);
      var input = el('input', { type: 'file', accept: 'image/jpeg,image/png', multiple: 'multiple', style: { display: 'none' } });
      input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
      label.appendChild(input);
      head.appendChild(label);
      head.appendChild(el('div', { class: 'fsb-lib-drop', text: 'or drop JPG / PNG here' }));
    }
    var grid = el('div', { class: 'fsb-lib-grid', id: 'fsb-lib-grid' });
    root.appendChild(head);
    root.appendChild(grid);

    // ---- drag files onto the library (upload sources only) ----------
    if (canUpload) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        root.addEventListener(ev, function (e) {
          if (!e.dataTransfer || [].indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
          e.preventDefault();
          root.classList.add('fsb-lib--dragging');
        });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        root.addEventListener(ev, function (e) {
          if (ev === 'drop') {
            e.preventDefault();
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
          }
          if (ev === 'drop' || !root.contains(e.relatedTarget)) root.classList.remove('fsb-lib--dragging');
        });
      });
    }

    // ---- upload queue ---------------------------------------------
    var queue = [];
    var active = 0;

    function handleFiles(fileList) {
      if (app.isReadOnly()) { toast('This project is confirmed. Un-confirm to add photos.', 'error'); return; }
      var files = [].slice.call(fileList).filter(function (f) {
        return ACCEPT.indexOf((f.type || '').toLowerCase()) >= 0 || /\.(jpe?g|png)$/i.test(f.name || '');
      });
      if (!files.length) { toast('No JPG/PNG files found.', 'error'); return; }
      files.forEach(function (f) {
        var tile = el('div', { class: 'fsb-thumb fsb-thumb--uploading' }, [
          el('div', { class: 'fsb-thumb-spin' }),
          el('div', { class: 'fsb-thumb-name', text: f.name || 'photo' }),
        ]);
        grid.insertBefore(tile, grid.firstChild);
        queue.push({ file: f, tile: tile });
      });
      pump();
    }

    function pump() {
      while (active < MAX_CONCURRENT && queue.length) {
        var job = queue.shift();
        active++;
        (function (job) {
          (app.ensureCreated ? app.ensureCreated() : Promise.resolve())
            .then(function () { return src.upload(app.projectId, job.file); })
            .then(function (meta) {
            app.addPhoto(meta);
            job.tile.remove();
          }).catch(function (err) {
            job.tile.classList.remove('fsb-thumb--uploading');
            job.tile.classList.add('fsb-thumb--error');
            job.tile.title = String(err && err.message || err);
            toast('Upload failed: ' + (job.file.name || ''), 'error');
          }).then(function () {
            active--;
            pump();
            if (!active && !queue.length) render();
          });
        })(job);
      }
    }

    // ---- grid render --------------------------------------------
    function render() {
      var project = app.project;
      var photos = src.list(project);
      document.getElementById('fsb-lib-count').textContent = String(photos.length);

      // keep any still-uploading tiles, replace the rest
      [].slice.call(grid.querySelectorAll('.fsb-thumb:not(.fsb-thumb--uploading):not(.fsb-thumb--error)'))
        .forEach(function (n) { n.remove(); });

      photos.forEach(function (p) {
        var used = app.slotsUsingPhoto(p.id);
        var img = el('img', { class: 'fsb-thumb-img', draggable: 'false', loading: 'lazy', alt: p.filename });
        img.src = src.thumbUrl(project, p.id);
        // Drag a thumbnail onto a slot to place / replace its photo
        // (editor.js handles the drop); clicking a slot also opens the picker.
        var tile = el('div', {
          class: 'fsb-thumb' + (used ? ' fsb-thumb--used' : ''),
          draggable: 'true', title: p.filename + (used ? ('  ·  used ×' + used) : ''), 'data-photo-id': p.id,
        }, [
          img,
          used ? el('span', { class: 'fsb-thumb-badge', text: '×' + used }) : null,
          canUpload ? el('button', { class: 'fsb-thumb-del', 'data-del': p.id, title: 'Delete photo', text: '✕' }) : null,
        ]);
        tile.addEventListener('dragstart', function (e) {
          if (app.isReadOnly()) { e.preventDefault(); return; }
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData(MIME_PHOTO, p.id);
          try { e.dataTransfer.setDragImage(img, 30, 30); } catch (_e) {}
          tile.classList.add('fsb-thumb--drag');
        });
        tile.addEventListener('dragend', function () { tile.classList.remove('fsb-thumb--drag'); });
        grid.appendChild(tile);
      });
    }

    grid.addEventListener('click', function (e) {
      var del = e.target.closest('.fsb-thumb-del');
      if (!del) return;
      if (app.isReadOnly()) { toast('Project is confirmed.', 'error'); return; }
      var pid = del.getAttribute('data-del');
      var used = app.slotsUsingPhoto(pid);
      var msg = used ? ('Delete this photo? It is used in ' + used + ' slot(s), which will be cleared.') : 'Delete this photo?';
      window.FSB.util.confirmDialog(msg, { okText: 'Delete' }).then(function (ok) {
        if (!ok) return;
        src.remove(app.projectId, pid).then(function (updated) {
          app.setProject(updated);
          toast('Photo deleted.');
        }).catch(function (err) { toast('Delete failed: ' + err.message, 'error'); });
      });
    });

    app.on('photos', render);
    app.on('project', render);
    app.on('slot', render); // usage badges
    render();
  }

  window.FSB.library = { mount: mount };
})();
