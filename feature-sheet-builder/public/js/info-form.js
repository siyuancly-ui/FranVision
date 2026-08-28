/*
 * info-form.js -- the only thing the client types.
 *
 * Fields are declared in template-config.js (T.form). Values write back to
 * project.propertyInfo / project.agentInfo; the template pulls font, size,
 * position and alignment from the config -- the user never touches layout.
 *
 * FSB.infoForm.mount(rootEl, app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var debounce = window.FSB.util.debounce;
  var toast = window.FSB.util.toast;
  var T = window.FSB_TEMPLATE;
  var src = window.FSB.photoSource;

  function mount(root, app) {
    root.innerHTML = '';
    var groups = [
      { key: 'propertyInfo', title: 'Property Information', fields: T.form.propertyInfo },
      { key: 'agentInfo', title: 'Agent Information', fields: T.form.agentInfo },
    ];
    var inputs = {}; // "group.key" -> element

    groups.forEach(function (g) {
      var sec = el('div', { class: 'fsb-form-sec' }, [el('h3', { text: g.title })]);
      g.fields.forEach(function (f) {
        var id = 'f-' + g.key + '-' + f.key;
        var row = el('div', { class: 'fsb-form-row' });
        row.appendChild(el('label', { for: id, text: f.label + (f.required ? ' *' : '') }));

        if (f.type === 'image') {
          row.appendChild(buildImageField(g.key, f, id, app));
        } else {
          var input = f.type === 'textarea'
            ? el('textarea', { id: id, rows: f.rows || 4 })
            : el('input', { id: id, type: 'text' });
          input.value = (app.project[g.key] && app.project[g.key][f.key]) || '';
          var commit = debounce(function () { app.patchInfo(g.key, f.key, input.value); }, 200);
          input.addEventListener('input', commit);
          inputs[g.key + '.' + f.key] = input;
          row.appendChild(input);
          if (f.hint) row.appendChild(el('span', { class: 'fsb-form-hint', text: f.hint }));
        }
        sec.appendChild(row);
      });
      root.appendChild(sec);
    });

    function buildImageField(groupKey, f, id, app) {
      var wrap = el('div', { class: 'fsb-img-field' });
      var preview = el('div', { class: 'fsb-img-prev' });
      var fileInput = el('input', { id: id, type: 'file', accept: 'image/jpeg,image/png', style: { display: 'none' } });
      var pick = el('button', { class: 'fsb-btn fsb-btn--sm', type: 'button', text: 'Choose…' });
      var clear = el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--ghost', type: 'button', text: 'Use default' });
      pick.addEventListener('click', function () { fileInput.click(); });
      clear.addEventListener('click', function () { app.patchInfo(groupKey, f.key, null); renderPrev(); });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files[0]; fileInput.value = '';
        if (!file) return;
        if (app.isReadOnly()) { toast('Project is confirmed.', 'error'); return; }
        preview.classList.add('is-loading');
        src.upload(app.projectId, file).then(function (meta) {
          app.addPhoto(meta);
          app.patchInfo(groupKey, f.key, meta.photoId);
          renderPrev();
        }).catch(function (err) { toast('Upload failed: ' + err.message, 'error'); })
          .then(function () { preview.classList.remove('is-loading'); });
      });
      function renderPrev() {
        var pid = app.project[groupKey][f.key];
        preview.innerHTML = '';
        var img = el('img', { alt: '' });
        img.src = pid ? src.fullUrl(app.project, pid)
          : ('/template-assets/' + app.project.templateId + '/' +
             (f.key === 'headshotPhotoId' ? T.headshotSlot.defaultAsset : T.logoSlot.defaultAsset));
        preview.appendChild(img);
      }
      wrap._renderPrev = renderPrev;
      inputs[groupKey + '.' + f.key] = wrap;
      wrap.appendChild(preview);
      // "Choose..." only when the photo source accepts uploads.
      if (src.supportsUpload && src.supportsUpload()) wrap.appendChild(pick);
      wrap.appendChild(clear);
      renderPrev();
      return wrap;
    }

    function repopulate() {
      Object.keys(inputs).forEach(function (path) {
        var parts = path.split('.');
        var val = app.project[parts[0]] ? app.project[parts[0]][parts[1]] : '';
        var node = inputs[path];
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
          if (node.value !== (val || '')) node.value = val || '';
        } else if (node._renderPrev) {
          node._renderPrev();
        }
      });
    }
    app.on('project', repopulate);
  }

  window.FSB.infoForm = { mount: mount };
})();
