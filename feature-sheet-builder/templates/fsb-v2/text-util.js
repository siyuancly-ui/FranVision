/*
 * FranVision Feature Sheet Builder -- v2 pure text helpers.
 * DOM-free, shared by the renderer and the tests.
 *   FSB_V2_TEXT.formatPhone(raw)     -> "647-268-6266"
 *   FSB_V2_TEXT.splitAddress(str)    -> ["333 Denison St, Unit 2", "Markham, ON L3R 2Z4"]
 */
(function (root) {
  'use strict';

  function formatPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return String(raw || '');
  }

  // Split a street address into EXACTLY two lines:
  //   line 1 = street + unit,  line 2 = city onward (City, PROV, Postal).
  // The break is always right BEFORE the city. The city is the segment
  // just before a 2-letter-province segment; if the unit has no comma
  // ("... Unit 2 Markham, ON ...") the city is split out of that segment
  // after the unit token, so the unit stays on line 1. An explicit
  // newline in the field always wins.
  var UNIT_RE = /^(.*\b(?:unit|suite|ste|apt|apartment|#|rm|room|fl|floor|ph|penthouse|bsmt|lower|upper|main|bldg|building)\.?\s*[\w\-\/]+)\s+([A-Za-z].*)$/i;
  var PROV_RE = /^[A-Za-z]{2}\b\.?(\s+[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d)?$/;

  function splitAddress(s) {
    s = String(s || '').trim();
    if (!s) return [];
    if (s.indexOf('\n') >= 0) {
      var p = s.split('\n');
      return [p.shift().trim(), p.join(', ').replace(/\s*,\s*/g, ', ').trim()].filter(Boolean);
    }
    var seg = s.split(/\s*,\s*/).filter(Boolean);
    if (seg.length <= 1) return [s];
    var provIdx = -1;
    for (var i = 1; i < seg.length; i++) { if (PROV_RE.test(seg[i])) { provIdx = i; break; } }
    var cityIdx = provIdx > 0 ? provIdx - 1 : seg.length - 1;
    var m = UNIT_RE.exec(seg[cityIdx]);   // "Unit 2 Markham" -> ["Unit 2", "Markham"]
    var before = seg.slice(0, cityIdx);
    var after = seg.slice(cityIdx + 1);
    if (m) {
      return [before.concat(m[1].trim()).join(', '), [m[2].trim()].concat(after).join(', ')];
    }
    if (!before.length) return [seg[0], seg.slice(1).join(', ')];
    return [before.join(', '), seg.slice(cityIdx).join(', ')];
  }

  var API = { formatPhone: formatPhone, splitAddress: splitAddress };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.FSB_V2_TEXT = API;
})(typeof window !== 'undefined' ? window : null);
