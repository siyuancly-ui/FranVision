/*
 * info-form.js -- the only thing the client types (fsb-v2).
 *
 * Field schema is defined here (no template-config dependency). Values
 * write to project.propertyInfo / project.agentInfo / project.agentInfo2
 * and the top-level project (colorTheme, topPhotoStyle). Layout is chosen
 * from these values by templates/fsb-v2/registry.js -- the user never
 * touches position, font or size.
 *
 * FSB.infoForm.mount(rootEl, app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var el = window.FSB.util.el;
  var debounce = window.FSB.util.debounce;
  var toast = window.FSB.util.toast;
  var src = window.FSB.photoSource;
  var THEMES = window.FSB_V2_THEMES;

  // Agent 1: personal fields + the shared brokerage block.
  var AGENT1_FIELDS = [
    { key: 'name', label: 'Name 姓名' },
    { key: 'credentials', label: 'Title / credentials 职务' },
    { key: 'cellPhone', label: 'Phone 电话' },
    { key: 'email', label: 'Email 邮箱' },
    { key: 'headshotPhotoId', label: 'Headshot 头像', type: 'image' },
    { key: 'brokerage', label: 'Brokerage 经纪公司' },
    { key: 'brokerageOffice', label: 'Brokerage office phone 公司电话', hint: '可留空;填了显示在公司地址上方' },
    { key: 'brokerageAddress', label: 'Brokerage address 公司地址' },
    { key: 'brokerageLogoPhotoId', label: 'Brokerage logo 公司 Logo', type: 'image' },
  ];
  // Agent 2 (co-listing): same brokerage, so personal fields only.
  var AGENT2_FIELDS = [
    { key: 'name', label: 'Name 姓名' },
    { key: 'credentials', label: 'Title / credentials 职务' },
    { key: 'cellPhone', label: 'Phone 电话' },
    { key: 'email', label: 'Email 邮箱' },
    { key: 'headshotPhotoId', label: 'Headshot 头像', type: 'image' },
  ];

  var SCHEMA = {
    layout: {
      title: 'Template 模板',
      top: true,
      fields: [
        { key: 'colorTheme', label: 'Colour theme 主题色', type: 'select',
          options: Object.keys(THEMES).map(function (k) { return { v: k, t: THEMES[k].name }; }) },
      ],
    },
    propertyInfo: {
      title: 'Property 房源信息',
      fields: [
        { key: 'address', label: 'Street address 街道地址', required: true },
        { key: 'city', label: 'City 城市', required: true },
        { key: 'description', label: 'Description 房源描述', type: 'textarea', rows: 7,
          hint: '留空 = 用 6 图拼贴版式；填写 = 用带描述版式' },
        { key: 'bedrooms', label: 'Bedrooms 卧室', hint: '如 4+1，留空则隐藏该图标' },
        { key: 'bathrooms', label: 'Bathrooms 卫生间' },
        { key: 'garage', label: 'Garage / parking 车库' },
        { key: 'onlineTourUrl', label: 'Online tour URL 看房链接', hint: '用于生成二维码' },
      ],
    },
    agentInfo: { title: 'Agent 经纪', fields: AGENT1_FIELDS },
    agentInfo2: { title: 'Second agent 第二经纪 (co-listing，可选)', fields: AGENT2_FIELDS, optionalGroup: true },
  };

  function mount(root, app) {
    root.innerHTML = '';
    var inputs = {};

    Object.keys(SCHEMA).forEach(function (groupKey) {
      var g = SCHEMA[groupKey];
      var sec = el('div', { class: 'fsb-form-sec' }, [el('h3', { text: g.title })]);
      if (g.optionalGroup) {
        var hint = el('p', { class: 'fsb-form-hint', text: '填了姓名即切换为双经纪版式。' });
        sec.appendChild(hint);
      }
      g.fields.forEach(function (f) {
        var id = 'f-' + groupKey + '-' + f.key;
        var row = el('div', { class: 'fsb-form-row' });
        row.appendChild(el('label', { for: id, text: f.label + (f.required ? ' *' : '') }));

        if (f.type === 'image') {
          row.appendChild(buildImageField(groupKey, f, id, app, inputs));
        } else if (f.type === 'select') {
          var sel = el('select', { id: id });
          f.options.forEach(function (o) { sel.appendChild(el('option', { value: o.v, text: o.t })); });
          sel.value = readVal(app, groupKey, g.top, f.key) || f.options[0].v;
          sel.addEventListener('change', function () { writeVal(app, groupKey, g.top, f.key, sel.value); });
          inputs[groupKey + '.' + f.key] = sel;
          row.appendChild(sel);
        } else {
          var input = f.type === 'textarea'
            ? el('textarea', { id: id, rows: f.rows || 4 })
            : el('input', { id: id, type: 'text' });
          input.value = readVal(app, groupKey, g.top, f.key) || '';
          var commit = debounce(function () { writeVal(app, groupKey, g.top, f.key, input.value); }, 220);
          input.addEventListener('input', commit);
          inputs[groupKey + '.' + f.key] = input;
          row.appendChild(input);
        }
        if (f.hint) row.appendChild(el('span', { class: 'fsb-form-hint', text: f.hint }));
        sec.appendChild(row);
      });
      root.appendChild(sec);
    });

    function buildImageField(groupKey, f, id, app, inputs) {
      var wrap = el('div', { class: 'fsb-img-field' });
      var preview = el('div', { class: 'fsb-img-prev' });
      var fileInput = el('input', { id: id, type: 'file', accept: 'image/jpeg,image/png', style: { display: 'none' } });
      var pick = el('button', { class: 'fsb-btn fsb-btn--sm', type: 'button', text: 'Choose… 选择' });
      var clear = el('button', { class: 'fsb-btn fsb-btn--sm fsb-btn--ghost', type: 'button', text: 'Clear 清除' });
      pick.addEventListener('click', function () { fileInput.click(); });
      clear.addEventListener('click', function () {
        var pid = (app.project[groupKey] || {})[f.key];
        var meta = pid && (app.project.photos || []).filter(function (p) { return p.photoId === pid; })[0];
        // if it was uploaded here (role tag) and nothing else uses it, drop the file too
        if (meta && meta.role && src.remove && !app.slotsUsingPhoto(pid)) {
          src.remove(app.projectId, pid).then(function (updated) { app.setProject(updated); })
            .catch(function () { writeVal(app, groupKey, false, f.key, null); renderPrev(); });
          return;
        }
        writeVal(app, groupKey, false, f.key, null); renderPrev();
      });
      fileInput.addEventListener('change', function () {
        var file = fileInput.files[0]; fileInput.value = '';
        if (!file) return;
        if (app.isReadOnly()) { toast('Project is confirmed.', 'error'); return; }
        preview.classList.add('is-loading');
        var role = f.key.indexOf('logo') > -1 ? 'logo' : 'headshot';
        (app.ensureCreated ? app.ensureCreated() : Promise.resolve())
          .then(function () { return src.upload(app.projectId, file, role); })
          .then(function (meta) {
          app.addPhoto(meta);
          writeVal(app, groupKey, false, f.key, meta.photoId);
          renderPrev();
        }).catch(function (err) { toast('Upload failed: ' + err.message, 'error'); })
          .then(function () { preview.classList.remove('is-loading'); });
      });
      function renderPrev() {
        var grp = app.project[groupKey] || {};
        var pid = grp[f.key];
        preview.innerHTML = '';
        if (pid) preview.appendChild(el('img', { alt: '', src: src.fullUrl(app.project, pid) }));
        else preview.appendChild(el('span', { class: 'fsb-img-empty', text: f.key.indexOf('logo') > -1 ? 'Logo' : 'Headshot' }));
      }
      wrap._renderPrev = renderPrev;
      inputs[groupKey + '.' + f.key] = wrap;
      wrap.appendChild(fileInput);        // must be IN the DOM for the picker + change event
      wrap.appendChild(preview);
      if (src.supportsUpload && src.supportsUpload()) wrap.appendChild(pick);
      wrap.appendChild(clear);
      renderPrev();
      return wrap;
    }

    function repopulate() {
      Object.keys(inputs).forEach(function (path) {
        var parts = path.split('.'), groupKey = parts[0], key = parts[1];
        var g = SCHEMA[groupKey];
        var node = inputs[path];
        if (node._renderPrev) { node._renderPrev(); return; }
        var val = readVal(app, groupKey, g && g.top, key);
        if (node.tagName === 'SELECT') { if (val) node.value = val; }
        else if (node.value !== (val || '')) node.value = val || '';
      });
    }
    app.on('project', repopulate);
  }

  // ---- value access -------------------------------------------------
  function readVal(app, groupKey, isTop, key) {
    if (isTop) return app.project[key];
    var grp = app.project[groupKey];
    return grp ? grp[key] : '';
  }
  function writeVal(app, groupKey, isTop, key, value) {
    if (isTop) { app.patchTop(key, value); return; }
    if (groupKey === 'agentInfo2' && !app.project.agentInfo2) {
      app.project.agentInfo2 = {};
    }
    app.patchInfo(groupKey, key, value);
  }

  window.FSB.infoForm = { mount: mount };
})();
