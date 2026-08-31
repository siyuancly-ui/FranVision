/*
 * app.js -- controller. Owns the in-memory project, coordinates the
 * library / editor / form / preview / export, and does debounced autosave.
 *
 * URL contract: ?p=<projectId>. No id -> create one and push it into the
 * URL, so the address bar is always a shareable link.
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var util = window.FSB.util;
  var el = util.el;
  var store = window.FSB.store;
  var render = window.FSB.render;
  var CROP = window.FSB_CROP;
  // fsb-v2: geometry replaces the old single template-config
  var GEO = window.FSB_V2_GEOMETRY;
  var PAGE_COUNT = GEO.page.count;          // 2
  var PAGE_WIDTH_PT = GEO.page.trimWidthPt; // 1224

  var app = {
    project: null,
    projectId: null,
    _listeners: {},
    _pageEls: {},
    _dirty: false,
    _saving: false,
    _scale: 0.7,
  };

  // ---- tiny event bus ------------------------------------------------
  app.on = function (evt, cb) { (app._listeners[evt] = app._listeners[evt] || []).push(cb); };
  app.emit = function (evt, payload) { (app._listeners[evt] || []).forEach(function (cb) { try { cb(payload); } catch (e) { console.error(e); } }); };

  // ---- helpers -----------------------------------------------------
  app.isReadOnly = function () { return !!(app.project && app.project.confirmed); };
  app.pageEl = function (n) { return app._pageEls[n]; };
  app.slotState = function (page, slotId) {
    return (app.project.pages['page' + page].slots[slotId]) ||
      (app.project.pages['page' + page].slots[slotId] = { photoId: null, positionX: 0, positionY: 0, scale: 1 });
  };
  app.slotsUsingPhoto = function (photoId) {
    if (!photoId || !app.project) return 0;
    var n = 0;
    ['page1', 'page2'].forEach(function (pk) {
      var slots = app.project.pages[pk].slots;
      Object.keys(slots).forEach(function (s) { if (slots[s] && slots[s].photoId === photoId) n++; });
    });
    return n;
  };

  // ---- mutations -------------------------------------------------
  app.setProject = function (project) {
    app.project = project;
    app.projectId = project.projectId;
    app._dirty = false;
    app.emit('project', project);
    app.emit('save-state');
    reflectConfirmed();
  };

  app.addPhoto = function (meta) {
    if (!app.project.photos.some(function (p) { return p.photoId === meta.photoId; })) {
      app.project.photos.push(meta);
    }
    app.emit('photos');
    scheduleSave(); // persist the new photo's metadata (binary is already stored)
  };

  app.patchInfo = function (group, key, value) {
    if (!app.project[group]) app.project[group] = {};
    app.project[group][key] = value;
    app.emit('dynamic');
    scheduleSave();
  };

  // top-level project fields (colorTheme, topPhotoStyle)
  app.patchTop = function (key, value) {
    app.project[key] = value;
    app.emit('dynamic');
    scheduleSave();
  };

  // agent-card image sizes (logo / headshot1 / headshot2 / qr) -- a
  // multiplier the user sets by dragging the box edge.
  app.mutateImageSize = function (key, mult) {
    if (!app.project.imageSizes) app.project.imageSizes = {};
    app.project.imageSizes[key] = Math.max(0.4, Math.min(2.5, mult));
    app.emit('dynamic');
    scheduleSave();
  };

  // Resolve once the project row exists (lazy creation). Photo uploads and
  // image fields need a real projectId before they can POST.
  app.ensureCreated = function () {
    if (app.projectId) return Promise.resolve(app.projectId);
    if (!app._createPromise) {
      app._createPromise = new Promise(function (resolve, reject) {
        (function attempt() {
          if (app.projectId) { app._createPromise = null; return resolve(app.projectId); }
          if (app._saving) { setTimeout(attempt, 120); return; }  // a save is already in flight
          app.save().then(function () {
            app._createPromise = null;
            if (app.projectId) resolve(app.projectId);
            else reject(new Error('could not create the project'));
          }, function (e) { app._createPromise = null; reject(e); });
        })();
      });
    }
    return app._createPromise;
  };

  app.assignPhotoToSlot = function (ref, photoId) {
    var st = app.slotState(ref.page, ref.slotId);
    st.photoId = photoId; st.positionX = 0; st.positionY = 0; st.scale = 1;
    render.updateSlot(app.pageEl(ref.page), app.project, ref.slotId);
    app.emit('slot', ref);
    scheduleSave();
  };

  app.clearSlot = function (ref) {
    var st = app.slotState(ref.page, ref.slotId);
    st.photoId = null; st.positionX = 0; st.positionY = 0; st.scale = 1;
    render.updateSlot(app.pageEl(ref.page), app.project, ref.slotId);
    app.emit('slot', ref);
    scheduleSave();
  };

  app.mutateSlot = function (ref, partial, opts) {
    opts = opts || {};
    var st = app.slotState(ref.page, ref.slotId);
    if ('positionX' in partial) st.positionX = partial.positionX;
    if ('positionY' in partial) st.positionY = partial.positionY;
    if ('scale' in partial) st.scale = partial.scale;
    var clamped = CROP.clampState(st);
    st.positionX = clamped.positionX; st.positionY = clamped.positionY; st.scale = clamped.scale;
    if (!opts.silentRender) render.updateSlot(app.pageEl(ref.page), app.project, ref.slotId);
    app.emit('slot', ref);
    scheduleSave();
  };

  app.swapSlots = function (a, b) {
    var sa = app.slotState(a.page, a.slotId);
    var sb = app.slotState(b.page, b.slotId);
    app.project.pages['page' + a.page].slots[a.slotId] = sb;
    app.project.pages['page' + b.page].slots[b.slotId] = sa;
    render.updateSlot(app.pageEl(a.page), app.project, a.slotId);
    render.updateSlot(app.pageEl(b.page), app.project, b.slotId);
    app.emit('slot', a); app.emit('slot', b);
    scheduleSave();
  };

  // ---- saving --------------------------------------------------
  var scheduleSave = util.debounce(function () { app.save(); }, 800);
  app._markDirty = function () { app._dirty = true; app.emit('save-state'); };
  var origSchedule = scheduleSave;
  scheduleSave = function () {
    app._markDirty();
    // Materialise the row on the very first change so photo uploads (which
    // need a projectId) and the shareable ?p= URL are available right away.
    if (!app.projectId && !app._saving) { app.save(); return; }
    origSchedule();
  };

  app.save = function () {
    if (!app.project || app._saving) return Promise.resolve();
    app._saving = true; app.emit('save-state');
    // Lazy creation: a bare-URL visit holds an in-memory blank project with
    // no id. The row is only written on the first real save (= first edit),
    // so "just looking" never leaves an orphan.
    var work;
    if (!app.projectId) {
      work = store.createProject(app.project).then(function (created) {
        app.projectId = created.projectId;
        app.project.projectId = created.projectId;
        app.project.createdAt = created.createdAt;
        setUrlProject(created.projectId);
        return created;
      });
    } else {
      // Pass the whole in-memory project; each store impl persists what it
      // needs (local server merges a patch; Supabase writes the full blob).
      work = store.updateProject(app.projectId, app.project);
    }
    return work.then(function (updated) {
      app.project.updatedAt = updated.updatedAt;
      app._saving = false; app._dirty = false; app.emit('save-state');
    }).catch(function (err) {
      app._saving = false; app.emit('save-state');
      util.toast('Save failed: ' + err.message, 'error');
    });
  };

  function updateTitle() {
    var a = app.project && app.project.propertyInfo && app.project.propertyInfo.address;
    document.title = (a ? a + ' — ' : '') + 'FranVision Feature Sheet Builder';
  }

  // ---- confirm ------------------------------------------------
  // Confirm = the agent's final sign-off: lock the design, then submit it
  // for printing (emails the finished sheet to the studio, when the submit
  // module is wired up).
  app.confirmDesign = function () {
    util.confirmDialog(
      [
        'Submit this design for printing?\nOnce submitted it is locked — you can still re-open it to make changes and submit again.',
        '确认将当前版本提交打印？\n提交后会锁定；之后仍可重新打开修改，并再次提交。',
      ],
      { okText: 'Confirm & Submit  确认提交', cancelText: 'Not yet  暂不' }
    ).then(function (ok) {
      if (!ok) return;
      app.setBusy('Submitting… 提交中…');
      return app.save()
        .then(function () {
          // Email + PDF handoff. No-op until FSB.submit is wired (needs the
          // Resend key + edge function); the lock/timestamp still happens.
          if (window.FSB.submit && window.FSB.submit.send) return window.FSB.submit.send(app);
          return null;
        })
        .then(function () { return store.confirmProject(app.projectId, true); })
        .then(function (updated) {
          app.setProject(updated);
          util.toast('Submitted for printing 已提交打印');
        })
        .catch(function (err) { util.toast('Submit failed 提交失败: ' + err.message, 'error'); })
        .then(function () { app.setBusy(null); });
    });
  };

  app.unconfirm = function () {
    util.confirmDialog(
      [
        'Re-open for editing? You will need to Confirm & Submit again to send the updated version.',
        '重新打开编辑？修改后需要再次「确认提交」才会发送新版本。',
      ],
      { okText: 'Re-open  重新打开', cancelText: 'Cancel  取消' }
    ).then(function (ok) {
      if (!ok) return;
      store.confirmProject(app.projectId, false)
        .then(function (updated) { app.setProject(updated); util.toast('Re-opened for editing 已解锁'); })
        .catch(function (err) { util.toast('Failed: ' + err.message, 'error'); });
    });
  };

  // ---- busy overlay --------------------------------------------
  app.setBusy = function (msg) {
    var o = document.getElementById('fsb-busy');
    if (!o) return;
    o.querySelector('.fsb-busy-msg').textContent = msg || '';
    o.classList.toggle('show', !!msg);
  };

  // ================================================================
  //  UI
  // ================================================================
  function buildChrome() {
    var rootApp = document.getElementById('fsb-app');
    rootApp.innerHTML = '';

    var topbar = el('header', { class: 'fsb-topbar' }, [
      el('div', { class: 'fsb-brand' }, [
        el('strong', { text: 'FranVision' }),
        el('span', { text: 'Feature Sheet Builder' }),
      ]),
      el('div', { class: 'fsb-topbar-mid' }, [
        el('span', { class: 'fsb-save-state', id: 'fsb-save-state', text: '—' }),
        el('span', { class: 'fsb-confirmed', id: 'fsb-confirmed-badge' }),
      ]),
      el('div', { class: 'fsb-topbar-actions' }, [
        // "All sheets" only in Franky's admin context; agents get no list.
        app.adminToken
          ? el('a', { class: 'fsb-btn fsb-btn--ghost', id: 'fsb-btn-allsheets',
              href: window.location.pathname + '?admin=' + encodeURIComponent(app.adminToken) +
                (/[?&]local=1\b/.test(window.location.search) ? '&local=1' : ''),
              text: '← All sheets 全部' })
          : null,
        el('button', { class: 'fsb-btn fsb-btn--ghost', id: 'fsb-toggle-form', text: 'Info' }),
        el('button', { class: 'fsb-btn', id: 'fsb-btn-preview', text: 'Preview 预览' }),
        el('button', { class: 'fsb-btn fsb-btn--save', id: 'fsb-btn-save', text: 'Save 保存' }),
        el('button', { class: 'fsb-btn fsb-btn--primary', id: 'fsb-btn-confirm', text: 'Confirm & Submit 确认提交' }),
      ]),
    ]);

    var body = el('div', { class: 'fsb-body' }, [
      el('aside', { class: 'fsb-panel fsb-panel--library', id: 'fsb-library' }),
      el('main', { class: 'fsb-center' }, [
        el('nav', { class: 'fsb-pagenav', id: 'fsb-pagenav' }),
        el('div', { class: 'fsb-stage-wrap' }, [el('div', { class: 'fsb-stage', id: 'fsb-stage' })]),
      ]),
      el('aside', { class: 'fsb-panel fsb-panel--form', id: 'fsb-form' }),
    ]);

    var busy = el('div', { class: 'fsb-busy', id: 'fsb-busy' }, [
      el('div', { class: 'fsb-busy-card' }, [el('div', { class: 'fsb-spinner' }), el('div', { class: 'fsb-busy-msg' })]),
    ]);
    var toasts = el('div', { id: 'fsb-toasts' });

    rootApp.appendChild(topbar);
    rootApp.appendChild(body);
    rootApp.appendChild(busy);
    rootApp.appendChild(toasts);

    document.getElementById('fsb-btn-preview').addEventListener('click', function () { window.FSB.preview.open(app); });
    document.getElementById('fsb-btn-save').addEventListener('click', function () { app.save().then(function () { util.toast('Saved 已保存'); }); });
    document.getElementById('fsb-btn-confirm').addEventListener('click', function () {
      if (app.isReadOnly()) app.unconfirm(); else app.confirmDesign();
    });
    document.getElementById('fsb-toggle-form').addEventListener('click', function () {
      document.getElementById('fsb-app').classList.toggle('fsb-form-open');
    });

  }

  function buildPageNav() {
    var nav = document.getElementById('fsb-pagenav');
    nav.innerHTML = '';
    for (var p = 1; p <= PAGE_COUNT; p++) {
      (function (pageNum) {
        nav.appendChild(el('button', {
          class: 'fsb-pagenav-btn', text: 'Page ' + pageNum,
          onclick: function () {
            var pe = app._pageEls[pageNum];
            if (pe) pe.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        }));
      })(p);
    }
    // Zoom control -- lets each agent size the working view to their screen,
    // which is the real fix for "looks different on Windows/Mac/mobile".
    nav.appendChild(el('span', { class: 'fsb-pagenav-sp' }));
    nav.appendChild(el('button', { class: 'fsb-zoom-btn', text: '−', title: 'Zoom out', onclick: function () { stepZoom(-1); } }));
    nav.appendChild(el('button', { class: 'fsb-zoom-btn fsb-zoom-fit', id: 'fsb-zoom-label', text: 'Fit', title: 'Fit to width', onclick: function () { app._userZoom = null; renderStage(); } }));
    nav.appendChild(el('button', { class: 'fsb-zoom-btn', text: '+', title: 'Zoom in', onclick: function () { stepZoom(1); } }));
  }

  function stepZoom(dir) {
    var cur = app._userZoom || app._scale || 0.6;
    app._userZoom = Math.max(0.3, Math.min(1.3, Math.round((cur + dir * 0.1) * 100) / 100));
    renderStage();
  }

  function computeScale() {
    var stage = document.getElementById('fsb-stage');
    var w = (stage.clientWidth || 700) - 8;
    var fit = Math.max(0.3, Math.min(w / PAGE_WIDTH_PT, 1.0));
    app._scale = app._userZoom ? app._userZoom : fit;
    var lbl = document.getElementById('fsb-zoom-label');
    if (lbl) lbl.textContent = app._userZoom ? (Math.round(app._userZoom * 100) + '%') : 'Fit';
  }

  function renderStage() {
    computeScale();
    var stage = document.getElementById('fsb-stage');
    stage.innerHTML = '';
    app._pageEls = {};
    for (var p = 1; p <= PAGE_COUNT; p++) {
      var wrap = el('div', { class: 'fsb-stage-page', id: 'fsb-stage-page-' + p });
      wrap.appendChild(el('div', { class: 'fsb-stage-page-label', text: 'Page ' + p }));
      var pageEl = render.renderPage(p, app.project, {
        scale: app._scale, interactive: true, placeholders: true,
      });
      app._pageEls[p] = pageEl;
      wrap.appendChild(pageEl);
      stage.appendChild(wrap);
    }
    // now in the DOM -> size the auto-fit text blocks
    if (render.fitTexts) [1, 2].forEach(function (p) { if (app._pageEls[p]) render.fitTexts(app._pageEls[p]); });
    stage.classList.toggle('fsb-stage--locked', app.isReadOnly());
  }

  function reflectSaveState() {
    var n = document.getElementById('fsb-save-state');
    if (!n) return;
    if (app._saving) { n.textContent = 'Saving…'; n.className = 'fsb-save-state is-saving'; }
    else if (app._dirty) { n.textContent = 'Unsaved changes'; n.className = 'fsb-save-state is-dirty'; }
    else { n.textContent = 'All changes saved'; n.className = 'fsb-save-state is-saved'; }
  }

  function reflectConfirmed() {
    var badge = document.getElementById('fsb-confirmed-badge');
    var btn = document.getElementById('fsb-btn-confirm');
    if (!badge || !btn) return;
    if (app.project && app.project.confirmed) {
      badge.textContent = 'SUBMITTED 已提交 · ' + util.formatDateTime(app.project.confirmedAt);
      badge.classList.add('show');
      btn.textContent = 'Re-open 重新打开';
      btn.classList.remove('fsb-btn--primary');
    } else {
      badge.classList.remove('show');
      btn.textContent = 'Confirm & Submit 确认提交';
      btn.classList.add('fsb-btn--primary');
    }
    document.getElementById('fsb-app').classList.toggle('is-confirmed', !!(app.project && app.project.confirmed));
  }

  // ---- wiring ------------------------------------------------
  function wireEvents() {
    app.on('save-state', reflectSaveState);
    app.on('dynamic', function () {
      [1, 2].forEach(function (p) { if (app._pageEls[p]) render.updateDynamic(app._pageEls[p], app.project); });
      updateTitle();
    });
    app.on('project', function () {
      renderStage();
      [1, 2].forEach(function (p) { if (app._pageEls[p]) render.updateDynamic(app._pageEls[p], app.project); });
      updateTitle();
    });

    var onResize = util.debounce(function () {
      renderStage();
    }, 200);
    window.addEventListener('resize', onResize);
  }

  // ---- boot -------------------------------------------------
  function setUrlProject(id) {
    var u = new URL(window.location.href);
    if (u.searchParams.get('p') !== id) {
      u.searchParams.set('p', id);
      window.history.replaceState({}, '', u.toString());
    }
  }

  function showFatal(msg, withCreate) {
    var rootApp = document.getElementById('fsb-app');
    rootApp.innerHTML = '';
    var card = el('div', { class: 'fsb-fatal' }, [
      el('h2', { text: 'Feature Sheet Builder' }),
      el('p', { text: msg }),
    ]);
    if (withCreate) {
      card.appendChild(el('button', {
        class: 'fsb-btn fsb-btn--primary', text: 'Create a new project',
        onclick: function () { window.location.search = ''; },
      }));
    }
    rootApp.appendChild(card);
  }

  function start() {
    var params = new URL(window.location.href).searchParams;
    var pid = params.get('p');
    app.adminToken = params.get('admin') || '';

    // Franky's admin view: ?admin=<token> with no ?p= -> the central list.
    if (app.adminToken && !pid) {
      window.FSB.admin.mount(document.getElementById('fsb-app'), app.adminToken);
      return;
    }

    buildChrome();
    buildPageNav();
    wireEvents();

    var stage = document.getElementById('fsb-stage');
    window.FSB.editor.attach(stage, app);

    var load = pid
      ? store.getProject(pid).catch(function (err) {
          if (/not found/i.test(err.message)) { showFatal('That project link could not be found.', true); throw err; }
          throw err;
        })
      // Lazy: no id -> in-memory blank project, no row written yet. The
      // first edit triggers save() which creates the row + sets ?p=.
      : Promise.resolve(Object.assign(
          window.FSB_V2.blankProject('navy'),
          { projectId: null, createdAt: null, updatedAt: null }));

    load.then(function (project) {
      app.setProject(project);
      // Let a remote photo source (e.g. Wix gallery) fetch + cache its list
      // before the first render. No-op for the upload source.
      var ps = window.FSB.photoSource;
      return Promise.resolve(ps.ready ? ps.ready(project) : null).then(function () { return project; });
    }).then(function (project) {
      window.FSB.library.mount(document.getElementById('fsb-library'), app);
      window.FSB.infoForm.mount(document.getElementById('fsb-form'), app);
      renderStage();
      reflectSaveState();
      reflectConfirmed();

      window.addEventListener('beforeunload', function (e) {
        if (app._dirty || app._saving) { e.preventDefault(); e.returnValue = ''; }
      });
    }).catch(function (err) {
      if (!/not found/i.test(err.message || '')) showFatal('Could not load: ' + (err.message || err), true);
      console.error(err);
    });
  }

  window.FSB.app = app;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
