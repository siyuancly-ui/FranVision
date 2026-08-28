/*
 * crop-math.js -- the geometry behind "photo always covers its slot".
 *
 * Runs in both Node (tests) and the browser (editor + preview + export),
 * so it stays a pure, dependency-free module.
 *
 * MODEL
 * -----
 * A slot is a fixed rectangle (slotW x slotH, in pixels at whatever
 * scale it is currently rendered). A photo has a natural size
 * (photoW x photoH). We first "cover"-fit the photo to the slot
 * (baseScale = max ratio, so the photo fully covers the slot with no
 * gaps). `scale` is an extra zoom multiplier the user controls,
 * constrained to >= 1 so the cover guarantee can never be broken.
 *
 * Pan is stored resolution-independently as `positionX` / `positionY`
 * in [-1, 1]:
 *   -1 => photo pushed so its far edge meets the slot's near edge
 *    0 => centred
 *   +1 => photo's near edge meets the slot's near edge
 * The actual pixel offset is derived from the current overflow, so the
 * same stored state reproduces the same framing at any render size --
 * which is what makes the editor preview and the PDF export match.
 *
 * Persisted per slot (matches project.json):
 *   { photoId, positionX, positionY, scale }
 */

(function (root) {
  'use strict';

  var MIN_SCALE = 1;
  var MAX_SCALE = 4;

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }

  /**
   * Given slot + photo sizes and a { scale, positionX, positionY } state,
   * return the concrete render box:
   *   { baseScale, displayW, displayH, offsetX, offsetY, overflowX, overflowY }
   * offsetX/offsetY are the photo's top-left relative to the slot's
   * top-left, in pixels (both <= 0; the photo overhangs on all needed sides).
   */
  function computeLayout(opts) {
    var slotW = opts.slotW, slotH = opts.slotH;
    var photoW = opts.photoW, photoH = opts.photoH;

    if (!(slotW > 0 && slotH > 0)) {
      return { baseScale: 1, displayW: 0, displayH: 0, offsetX: 0, offsetY: 0, overflowX: 0, overflowY: 0 };
    }
    // Missing/broken photo dimensions -> treat as exactly the slot.
    if (!(photoW > 0 && photoH > 0)) { photoW = slotW; photoH = slotH; }

    var scale = clamp(num(opts.scale, 1), MIN_SCALE, MAX_SCALE);
    var positionX = clamp(num(opts.positionX, 0), -1, 1);
    var positionY = clamp(num(opts.positionY, 0), -1, 1);

    var baseScale = Math.max(slotW / photoW, slotH / photoH);
    var displayW = photoW * baseScale * scale;
    var displayH = photoH * baseScale * scale;

    // Guard tiny negative overflow from float error.
    var overflowX = Math.max(0, displayW - slotW);
    var overflowY = Math.max(0, displayH - slotH);

    var offsetX = -overflowX / 2 + positionX * (overflowX / 2);
    var offsetY = -overflowY / 2 + positionY * (overflowY / 2);

    return {
      baseScale: baseScale,
      displayW: displayW,
      displayH: displayH,
      offsetX: offsetX,
      offsetY: offsetY,
      overflowX: overflowX,
      overflowY: overflowY,
    };
  }

  /** Normalise + clamp a stored state. Never returns out-of-range values. */
  function clampState(state) {
    state = state || {};
    return {
      photoId: state.photoId != null ? state.photoId : null,
      positionX: clamp(num(state.positionX, 0), -1, 1),
      positionY: clamp(num(state.positionY, 0), -1, 1),
      scale: clamp(num(state.scale, 1), MIN_SCALE, MAX_SCALE),
    };
  }

  /**
   * Apply a pixel drag (dxPx, dyPx measured in slot pixels) to a state.
   * Dragging right moves the photo right (reveals its left side), matching
   * a "grab the photo" interaction.
   */
  function panByPixels(state, opts, dxPx, dyPx) {
    var s = clampState(state);
    var L = computeLayout({
      slotW: opts.slotW, slotH: opts.slotH, photoW: opts.photoW, photoH: opts.photoH,
      scale: s.scale, positionX: s.positionX, positionY: s.positionY,
    });
    var dPosX = L.overflowX > 0 ? (dxPx / (L.overflowX / 2)) : 0;
    var dPosY = L.overflowY > 0 ? (dyPx / (L.overflowY / 2)) : 0;
    s.positionX = clamp(s.positionX + dPosX, -1, 1);
    s.positionY = clamp(s.positionY + dPosY, -1, 1);
    return s;
  }

  /**
   * Zoom by `factor` (e.g. 1.1 in, 0.9 out) keeping the image point under
   * (focusX, focusY) -- given in slot pixels -- visually stationary.
   * Omit the focus to zoom about the slot centre.
   */
  function zoomAt(state, opts, factor, focusX, focusY) {
    var s = clampState(state);
    var slotW = opts.slotW, slotH = opts.slotH;
    if (focusX == null) focusX = slotW / 2;
    if (focusY == null) focusY = slotH / 2;

    var before = computeLayout({
      slotW: slotW, slotH: slotH, photoW: opts.photoW, photoH: opts.photoH,
      scale: s.scale, positionX: s.positionX, positionY: s.positionY,
    });

    var newScale = clamp(s.scale * factor, MIN_SCALE, MAX_SCALE);
    if (newScale === s.scale) return s;

    // Image-space fraction currently under the focus point.
    var imgFx = before.displayW > 0 ? (focusX - before.offsetX) / before.displayW : 0.5;
    var imgFy = before.displayH > 0 ? (focusY - before.offsetY) / before.displayH : 0.5;

    s.scale = newScale;

    var after = computeLayout({
      slotW: slotW, slotH: slotH, photoW: opts.photoW, photoH: opts.photoH,
      scale: s.scale, positionX: 0, positionY: 0,
    });

    // Desired offset so the same image fraction sits under the focus again.
    var wantOffsetX = focusX - imgFx * after.displayW;
    var wantOffsetY = focusY - imgFy * after.displayH;

    // Convert the desired offset back to normalised position, then clamp.
    s.positionX = after.overflowX > 0
      ? clamp((wantOffsetX + after.overflowX / 2) / (after.overflowX / 2), -1, 1)
      : 0;
    s.positionY = after.overflowY > 0
      ? clamp((wantOffsetY + after.overflowY / 2) / (after.overflowY / 2), -1, 1)
      : 0;
    return s;
  }

  /**
   * Verify the photo fully covers the slot for a given state -- used by
   * tests and as a cheap runtime assertion. Returns true when there is
   * no visible gap on any edge (allowing 0.5px float slack).
   */
  function covers(state, opts) {
    var s = clampState(state);
    var L = computeLayout({
      slotW: opts.slotW, slotH: opts.slotH, photoW: opts.photoW, photoH: opts.photoH,
      scale: s.scale, positionX: s.positionX, positionY: s.positionY,
    });
    var slack = 0.5;
    var leftOk = L.offsetX <= slack;
    var topOk = L.offsetY <= slack;
    var rightOk = (L.offsetX + L.displayW) >= (opts.slotW - slack);
    var bottomOk = (L.offsetY + L.displayH) >= (opts.slotH - slack);
    return leftOk && topOk && rightOk && bottomOk;
  }

  var api = {
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    clamp: clamp,
    computeLayout: computeLayout,
    clampState: clampState,
    panByPixels: panByPixels,
    zoomAt: zoomAt,
    covers: covers,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FSB_CROP = api;
})(typeof window !== 'undefined' ? window : null);
