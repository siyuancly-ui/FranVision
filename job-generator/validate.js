// FranVision Job Generator -- input validation.
//
// Pure functions only. Same UMD pattern as the other modules here so it
// can be `require`d in server.js AND loaded via <script> in the browser
// (window.JobValidate) -- one implementation, no drift between client-side
// and server-side validation.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobValidate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Strictly "YYYY/MM/DD" -- 4-digit year, zero-padded month/day, and the
  // date must actually exist on the calendar (rejects e.g. 2026/02/30).
  const SHOOT_DATE_REGEX = /^(\d{4})\/(\d{2})\/(\d{2})$/;

  function isValidShootDate(input) {
    if (typeof input !== 'string') return false;
    const m = SHOOT_DATE_REGEX.exec(input.trim());
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12) return false;
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  return { isValidShootDate, SHOOT_DATE_REGEX };
});
