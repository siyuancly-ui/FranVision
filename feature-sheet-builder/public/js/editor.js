/*
 * editor.js -- drag/drop into slots + in-slot pan & zoom.
 *
 * Wires interaction onto the nodes template-render.js builds. All state
 * changes go through FSB.app (which persists + re-renders). The photo is
 * kept covering its slot at all times by crop-math.js.
 *
 * FSB.editor.attach(stageEl, app)
 */
(function () {
  'use strict';
  window.FSB = window.FSB || {};
  var CROP = window.FSB_CROP;

  var MIME_PHOTO = 'application/x-fsb-photo';
  var MIME_SLOT = 'application/x-fsb-slot';

  function slotDims(slotEl) {
    return { w: slotEl.clientWidth, h: slotEl.clientHeight };
  }

  function photoDims(app, photoId) {
    // via the photo-source seam, not app.project.photos directly.
    var m = window.FSB.photoSource.getMeta(app.project, photoId);
    return { w: m ? m.width : 0, h: m ? m.height : 0 };
  }

  function applyImg(slotEl, dims, pdims, state) {
    var img = slotEl.querySelector('.fsb-slot-img');
    if (!img) return;
    var L = CROP.computeLayout({
      slotW: dims.w, slotH: dims.h, photoW: pdims.w, photoH: pdims.h,
      scale: state.scale, positionX: state.positionX, positionY: state.positionY,
    });
    img.style.width = L.displayW + 'px';
    img.style.height = L.displayH + 'px';
    img.style.left = L.offsetX + 'px';
    img.style.top = L.offsetY + 'px';
  }

  function slotRef(slotEl) {
    return { page: parseInt(slotEl.getAttribute('data-page'), 10), slotId: slotEl.getAttribute('data-slot-id') };
  }
  function stateOf(app, ref) {
    return app.project.pages['page' + ref.page].slots[ref.slotId] || { photoId: null, positionX: 0, positionY: 0, scale: 1 };
  }

  function attach(stage, app) {
    // ---- drag & drop -------------------------------------------------
    // Clear transient drag classes from every slot. Needed because a
    // move/swap rebuilds the slot's contents, so by the time `dragend`
    // fires its target node is detached and per-target cleanup would miss.
    function clearDragState() {
      var nodes = stage.querySelectorAll('.fsb-slot--dragging, .fsb-slot--drop');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].classList.remove('fsb-slot--dragging', 'fsb-slot--drop');
      }
    }

    stage.addEventListener('dragstart', function (e) {
      var handle = e.target.closest('.fsb-slot-move');
      if (!handle || app.isReadOnly()) { if (handle) e.preventDefault(); return; }
      var slotEl = handle.closest('.fsb-slot');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(MIME_SLOT, JSON.stringify(slotRef(slotEl)));
      var img = slotEl.querySelector('.fsb-slot-img');
      if (img) { try { e.dataTransfer.setDragImage(img, 20, 20); } catch (_e) {} }
      slotEl.classList.add('fsb-slot--dragging');
    });
    stage.addEventListener('dragend', clearDragState);

    // A slot accepts either a dragged library thumbnail (MIME_PHOTO) or
    // another slot (MIME_SLOT, via the Move handle). Clicking a slot also
    // opens the picker -- see the click / pan handlers below.
    stage.addEventListener('dragover', function (e) {
      var slotEl = e.target.closest('.fsb-slot');
      if (!slotEl || app.isReadOnly()) return;
      var t = e.dataTransfer.types || [];
      var isSlot = [].indexOf.call(t, MIME_SLOT) >= 0;
      var isPhoto = [].indexOf.call(t, MIME_PHOTO) >= 0;
      if (!isSlot && !isPhoto) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isSlot ? 'move' : 'copy';
      slotEl.classList.add('fsb-slot--drop');
    });
    stage.addEventListener('dragleave', function (e) {
      var slotEl = e.target.closest('.fsb-slot');
      if (slotEl && !slotEl.contains(e.relatedTarget)) slotEl.classList.remove('fsb-slot--drop');
    });
    stage.addEventListener('drop', function (e) {
      var slotEl = e.target.closest('.fsb-slot');
      if (!slotEl || app.isReadOnly()) return;
      e.preventDefault();
      slotEl.classList.remove('fsb-slot--drop');
      var target = slotRef(slotEl);
      var slotData = e.dataTransfer.getData(MIME_SLOT);
      if (slotData) {
        var s = JSON.parse(slotData);
        if (!(s.page === target.page && s.slotId === target.slotId)) app.swapSlots(s, target);
      } else {
        var photoId = e.dataTransfer.getData(MIME_PHOTO);
        if (photoId) app.assignPhotoToSlot(target, photoId);
      }
      clearDragState(); // in case the re-render swallows the dragend
    });

    // ---- click a slot -> photo picker ----------------------------
    // Empty slot: handled here. Filled slot: handled in endPan() so a
    // real pan-drag doesn't also trigger it. Either way, a plain click
    // anywhere on the slot opens the picker; drag pans.
    stage.addEventListener('click', function (e) {
      if (app.isReadOnly()) return;
      if (e.target.closest('.fsb-slot-tools') || e.target.closest('.fsb-slot-move')) return;
      var emptySlot = e.target.closest('.fsb-slot--empty');
      if (emptySlot) window.FSB.photoPicker.open(app, slotRef(emptySlot));
    });

    // ---- toolbar buttons ------------------------------------------
    stage.addEventListener('click', function (e) {
      var btn = e.target.closest('.fsb-slot-tools button[data-action]');
      if (!btn || app.isReadOnly()) return;
      var slotEl = btn.closest('.fsb-slot');
      var ref = slotRef(slotEl);
      var action = btn.getAttribute('data-action');
      if (action === 'change') return; // handled above
      if (action === 'clear') { app.clearSlot(ref); return; }
      if (action === 'reset') { app.mutateSlot(ref, { positionX: 0, positionY: 0, scale: 1 }); return; }
      if (action === 'zoom-in' || action === 'zoom-out') {
        var st = CROP.clampState(stateOf(app, ref));
        var dims = slotDims(slotEl), pd = photoDims(app, st.photoId);
        var next = CROP.zoomAt({ photoId: st.photoId, scale: st.scale, positionX: st.positionX, positionY: st.positionY },
          { slotW: dims.w, slotH: dims.h, photoW: pd.w, photoH: pd.h },
          action === 'zoom-in' ? 1.15 : 1 / 1.15);
        app.mutateSlot(ref, next);
      }
    });

    // ---- wheel / pinch zoom -----------------------------------
    // Plain wheel = let the page scroll (Mac trackpad users kept snagging
    // photos while scrolling). Zoom only on trackpad pinch (which arrives
    // as a ctrlKey wheel event) or an explicit Ctrl/Cmd + wheel.
    stage.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      var slotEl = e.target.closest('.fsb-slot--filled');
      if (!slotEl || app.isReadOnly()) return;
      e.preventDefault();
      var ref = slotRef(slotEl);
      var st = CROP.clampState(stateOf(app, ref));
      var dims = slotDims(slotEl), pd = photoDims(app, st.photoId);
      var rect = slotEl.getBoundingClientRect();
      var next = CROP.zoomAt(
        { photoId: st.photoId, scale: st.scale, positionX: st.positionX, positionY: st.positionY },
        { slotW: dims.w, slotH: dims.h, photoW: pd.w, photoH: pd.h },
        e.deltaY < 0 ? 1.12 : 1 / 1.12,
        e.clientX - rect.left, e.clientY - rect.top
      );
      applyImg(slotEl, dims, pd, next);
      app.mutateSlot(ref, next, { silentRender: true });
    }, { passive: false });

    // ---- pointer pan ------------------------------------------
    var pan = null;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || app.isReadOnly()) return;
      if (e.target.closest('.fsb-slot-tools') || e.target.closest('.fsb-slot-move')) return;
      var slotEl = e.target.closest('.fsb-slot--filled');
      if (!slotEl) return;
      var ref = slotRef(slotEl);
      var st = CROP.clampState(stateOf(app, ref));
      var dims = slotDims(slotEl), pd = photoDims(app, st.photoId);
      pan = {
        slotEl: slotEl, ref: ref, dims: dims, pd: pd,
        lastX: e.clientX, lastY: e.clientY,
        state: { photoId: st.photoId, scale: st.scale, positionX: st.positionX, positionY: st.positionY },
        moved: false,
      };
      slotEl.classList.add('fsb-slot--panning');
      slotEl.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pan) return;
      var dx = e.clientX - pan.lastX, dy = e.clientY - pan.lastY;
      pan.lastX = e.clientX; pan.lastY = e.clientY;
      pan.dist = (pan.dist || 0) + Math.abs(dx) + Math.abs(dy);
      if (pan.dist > 4) pan.moved = true;           // past this it's a drag, not a click
      pan.state = CROP.panByPixels(pan.state,
        { slotW: pan.dims.w, slotH: pan.dims.h, photoW: pan.pd.w, photoH: pan.pd.h }, dx, dy);
      applyImg(pan.slotEl, pan.dims, pan.pd, pan.state);
    });
    function endPan(e) {
      if (!pan) return;
      var p = pan; pan = null;
      p.slotEl.classList.remove('fsb-slot--panning');
      try { p.slotEl.releasePointerCapture(e.pointerId); } catch (_e) {}
      if (p.moved) {
        app.mutateSlot(p.ref, p.state, { silentRender: true });
      } else if (window.FSB.photoPicker) {
        window.FSB.photoPicker.open(app, p.ref);   // a click, not a drag -> swap the photo
      }
    }
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);
  }

  window.FSB.editor = { attach: attach, MIME_PHOTO: MIME_PHOTO, MIME_SLOT: MIME_SLOT };
})();
