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
  var T = window.FSB_TEMPLATE;

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
  };

  app.patchInfo = function (group, key, value) {
    app.project[group][key] = value;
    app.emit('dynamic');
    scheduleSave();
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
  scheduleSave = function () { app._markDirty(); origSchedule(); };

  app.save = function () {
    if (!app.project || app._saving) return Promise.resolve();
    app._saving = true; app.emit('save-state');
    var patch = {
      propertyInfo: app.project.propertyInfo,
      agentInfo: app.project.agentInfo,
      pages: app.project.pages,
    };
    return store.updateProject(app.projectId, patch).then(function (updated) {
      app.project.updatedAt = updated.updatedAt;
      app._saving = false; app._dirty = false; app.emit('save-state');
    }).catch(function (err) {
      app._saving = false; app.emit('save-state');
      util.toast('Save failed: ' + err.message, 'error');
    });
  };

  // ---- confirm ------------------------------------------------
  app.confirmDesign = function () {
    util.confirmDialog('Confirm this design? It will be locked — you can un-confirm later to keep editing.', { okText: 'Confirm Design' })
      .then(function (ok) {
        if (!ok) return;
        app.setBusy('Confirming…');
        return app.save().then(function () { return store.confirmProject(app.projectId, true); })
          .then(function (updated) { app.setProject(updated); util.toast('Design confirmed.'); })
          .catch(function (err) { util.toast('Confirm failed: ' + err.message, 'error'); })
          .then(function () { app.setBusy(null); });
      });
  };
  app.unconfirm = function () {
    store.confirmProject(app.projectId, false)
      .then(function (updated) { app.setProject(updated); util.toast('Un-confirmed — editing enabled.'); })
      .catch(function (err) { util.toast('Failed: ' + err.message, 'error'); });
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
        el('button', { class: 'fsb-btn fsb-btn--ghost', id: 'fsb-toggle-form', text: 'Info' }),
        el('button', { class: 'fsb-btn', id: 'fsb-btn-preview', text: 'Preview' }),
        el('button', { class: 'fsb-btn', id: 'fsb-btn-export', text: 'Export PDF' }),
        el('button', { class: 'fsb-btn fsb-btn--primary', id: 'fsb-btn-confirm', text: 'Confirm Design' }),
        el('button', { class: 'fsb-btn fsb-btn--save', id: 'fsb-btn-save', text: 'Save' }),
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
    document.getElementById('fsb-btn-export').addEventListener('click', function () { window.FSB.exportPdf.run(app); });
    document.getElementById('fsb-btn-save').addEventListener('click', function () { app.save().then(function () { util.toast('Saved.'); }); });
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
    for (var p = 1; p <= T.page.count; p++) {
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
  }

  function computeScale() {
    var stage = document.getElementById('fsb-stage');
    var w = stage.clientWidth || 700;
    app._scale = Math.max(0.35, Math.min(w / T.page.widthPt, 0.95));
  }

  function renderStage() {
    computeScale();
    var stage = document.getElementById('fsb-stage');
    stage.innerHTML = '';
    app._pageEls = {};
    for (var p = 1; p <= T.page.count; p++) {
      var wrap = el('div', { class: 'fsb-stage-page', id: 'fsb-stage-page-' + p });
      wrap.appendChild(el('div', { class: 'fsb-stage-page-label', text: 'Page ' + p }));
      var pageEl = render.renderPage(p, app.project, {
        scale: app._scale, interactive: true, placeholders: true,
      });
      app._pageEls[p] = pageEl;
      wrap.appendChild(pageEl);
      stage.appendChild(wrap);
    }
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
      badge.textContent = 'CONFIRMED · ' + util.formatDateTime(app.project.confirmedAt);
      badge.classList.add('show');
      btn.textContent = 'Un-confirm';
      btn.classList.remove('fsb-btn--primary');
    } else {
      badge.classList.remove('show');
      btn.textContent = 'Confirm Design';
      btn.classList.add('fsb-btn--primary');
    }
    document.getElementById('fsb-app').classList.toggle('is-confirmed', !!(app.project && app.project.confirmed));
  }

  // ---- wiring ------------------------------------------------
  function wireEvents() {
    app.on('save-state', reflectSaveState);
    app.on('dynamic', function () {
      [1, 2].forEach(function (p) { if (app._pageEls[p]) render.updateDynamic(app._pageEls[p], app.project); });
    });
    app.on('project', function () {
      renderStage();
      [1, 2].forEach(function (p) { if (app._pageEls[p]) render.updateDynamic(app._pageEls[p], app.project); });
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
    buildChrome();
    buildPageNav();
    wireEvents();

    var stage = document.getElementById('fsb-stage');
    window.FSB.editor.attach(stage, app);

    var params = new URL(window.location.href).searchParams;
    var pid = params.get('p');

    var load = pid
      ? store.getProject(pid).catch(function (err) {
          if (/not found/i.test(err.message)) { showFatal('That project link could not be found.', true); throw err; }
          throw err;
        })
      : store.createProject().then(function (project) { setUrlProject(project.projectId); return project; });

    load.then(function (project) {
      app.setProject(project);
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
