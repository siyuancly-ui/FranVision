/*
 * FranVision Feature Sheet Builder -- v2 layout engine
 * ===================================================
 *
 * Solves a vertical STACK of bands inside a column and returns absolute
 * page-fraction rects. This is what lets a page reflow when the agent
 * leaves the description or the bed/bath/garage row blank, WITHOUT ever
 * changing a photo's aspect ratio -- only text bands grow and only the
 * gaps between bands stretch.
 *
 *   solveColumn(column, bands, opts) -> {
 *     bands: [ { id, kind, rect:[x,y,w,h], slots?:[{id,rect}] , type? } ],
 *     overflow: <frac, >0 if content did not fit>
 *   }
 *
 * Units: x / w are fractions of TRIM WIDTH; y / h are fractions of TRIM
 * HEIGHT. A photo row's height is derived from its slot width and target
 * aspect via PAGE_ASPECT so squares stay square.
 *
 * band input shape (see templates/fsb-v2/modules.js):
 *   { id, kind:'photos', slots:[{id,wFrac,aspect}], gapAfter, growWeight:0 }
 *   { id, kind:'text',  field, minHFrac, growWeight, type }
 *   { id, kind:'fixed', hFrac, gapAfter }          // opaque block (e.g. address, hero)
 */
(function (root) {
  'use strict';

  var PAGE_ASPECT = 1224 / 792; // 1.54545...

  function rowHeightFrac(slots) {
    // all slots in a row share the tallest required height
    var h = 0;
    for (var i = 0; i < slots.length; i++) {
      var hf = slots[i].wFrac * PAGE_ASPECT / (slots[i].aspect || 1);
      if (hf > h) h = hf;
    }
    return h;
  }

  function placeRow(column, slots, y, hFrac) {
    // spread slots left->right across the full column width; derive the
    // inter-slot gap from the leftover after summing slot widths.
    var sumW = 0;
    for (var i = 0; i < slots.length; i++) sumW += slots[i].wFrac;
    var gap = slots.length > 1 ? (column.w - sumW) / (slots.length - 1) : 0;
    var x = column.x, out = [];
    for (var j = 0; j < slots.length; j++) {
      out.push({ id: slots[j].id, rect: [x, y, slots[j].wFrac, hFrac] });
      x += slots[j].wFrac + gap;
    }
    return out;
  }

  function solveColumn(column, bands, opts) {
    opts = opts || {};
    var colH = column.bottom - column.top;

    // 1. natural heights + gaps
    var nat = bands.map(function (b) {
      var h;
      if (b.kind === 'photos') h = rowHeightFrac(b.slots);
      else if (b.kind === 'text') h = b.minHFrac || 0.05;
      else h = b.hFrac || 0.05; // 'fixed'
      return { band: b, h: h, gapAfter: b.gapAfter || 0 };
    });

    var sumH = 0, sumGap = 0, growTotal = 0;
    nat.forEach(function (n, i) {
      sumH += n.h;
      if (i < nat.length - 1) sumGap += n.gapAfter;
      if (n.band.kind === 'text') growTotal += (n.band.growWeight || 0);
    });

    var slack = colH - sumH - sumGap;
    var overflow = slack < 0 ? -slack : 0;

    if (slack > 0) {
      if (growTotal > 0) {
        // text bands absorb the slack
        nat.forEach(function (n) {
          if (n.band.kind === 'text' && n.band.growWeight) {
            n.h += slack * (n.band.growWeight / growTotal);
          }
        });
      } else if (opts.slackToGaps !== false && sumGap > 0) {
        // no growers (e.g. collage) -> stretch every gap proportionally
        var k = (sumGap + slack) / sumGap;
        nat.forEach(function (n, i) { if (i < nat.length - 1) n.gapAfter *= k; });
      } else if (sumGap === 0) {
        // distribute evenly as leading/trailing padding
        column = Object.assign({}, column, { top: column.top + slack / 2 });
      }
    }

    // 2. walk top->bottom
    var y = column.top, result = [];
    nat.forEach(function (n, i) {
      var b = n.band;
      var entry = { id: b.id, kind: b.kind, rect: [column.x, y, column.w, n.h] };
      if (b.kind === 'photos') entry.slots = placeRow(column, b.slots, y, n.h);
      if (b.kind === 'text') { entry.field = b.field; entry.type = b.type; }
      if (b.kind === 'fixed') entry.ref = b.ref;
      result.push(entry);
      y += n.h + (i < nat.length - 1 ? n.gapAfter : 0);
    });

    return { bands: result, overflow: overflow, usedBottom: y };
  }

  var ENGINE = { solveColumn: solveColumn, PAGE_ASPECT: PAGE_ASPECT, rowHeightFrac: rowHeightFrac };

  if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
  if (root) root.FSB_V2_LAYOUT = ENGINE;
})(typeof window !== 'undefined' ? window : null);
