// FranVision Job Generator -- filename/folder-name sanitization.
//
// Pure string logic only -- no fs, no I/O. Takes free-typed strings (client
// name, address, etc.) and returns names that are safe to use as a file or
// folder path segment on BOTH macOS and Windows, regardless of which OS
// this code actually runs on (the union of both OS's illegal-character
// rules is applied unconditionally, so names stay portable either way).
//
// Works unmodified in Node (require) and in a plain <script> tag in the
// browser (sets window.JobSanitize), same pattern as pricing/engine.js.
//
// Folder-name date format (2026-09-08): "YYYY.M.D", no leading zero on
// month/day (e.g. "2026.9.8", not "2026.09.08") -- matches the user's own
// existing naming convention for their real client folders. This is
// display-only; the Shoot Date input FIELD itself still requires strict
// zero-padded "yyyy/mm/dd" (see validate.js) for unambiguous validation.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JobSanitize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Windows forbids: \ / : * ? " < > |  and control chars (0x00-0x1F).
  // macOS forbids: : and / (and NUL). The Windows set is a superset, so
  // applying it covers both.
  const ILLEGAL_CHARS_REGEX = /[\\/:*?"<>|\x00-\x1F]/g;

  // Windows reserved device names -- illegal as a whole segment name
  // (with or without an extension), case-insensitive.
  const WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);

  // Sanitize a single path segment (one folder or file name -- not a full
  // path). Replaces illegal characters with "-", trims the trailing dots
  // and spaces Windows doesn't allow, and dodges reserved device names.
  function sanitizeSegment(input, fallback) {
    fallback = fallback || 'untitled';
    if (input == null) return fallback;

    let s = String(input).replace(ILLEGAL_CHARS_REGEX, '-');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[.\s]+$/, ''); // Windows: trailing dots/spaces are stripped by the OS

    if (!s) s = fallback;

    const nameBeforeExt = s.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(s.toUpperCase()) || WINDOWS_RESERVED_NAMES.has(nameBeforeExt)) {
      s = s + '_';
    }

    return s;
  }

  // The Shoot Date FIELD still requires strict zero-padded "yyyy/mm/dd"
  // input (see validate.js) -- that's about unambiguous validation, not
  // display. The FOLDER NAME's date, however, follows the user's own
  // existing naming habit (matches the real client folders already in
  // Dropbox, e.g. "2026.9.8", not "2026.09.08") -- no leading zero on the
  // month or day. Falls back to just swapping separators to dots,
  // unchanged, if shootDate doesn't look like the expected padded format
  // (defensive -- this must never throw on odd input).
  function formatDateForFolderName(shootDate) {
    const normalized = String(shootDate || '').replace(/[/.-]/g, '.').trim();
    const match = normalized.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    if (!match) return normalized;
    const [, year, month, day] = match;
    return year + '.' + String(Number(month)) + '.' + String(Number(day));
  }

  // Builds the top-level job folder name: "YYYY.M.D Address_Client".
  // shootDate must be a "YYYY/MM/DD" or "YYYY-MM-DD" string (validation
  // happens elsewhere).
  function buildJobFolderName({ shootDate, address, clientName }) {
    const datePart = formatDateForFolderName(shootDate);
    const addressPart = sanitizeSegment(address, 'Unknown Address');
    const clientPart = sanitizeSegment(clientName, 'Unknown Client');
    return sanitizeSegment(datePart + ' ' + addressPart + '_' + clientPart);
  }

  return { sanitizeSegment, buildJobFolderName, formatDateForFolderName, ILLEGAL_CHARS_REGEX, WINDOWS_RESERVED_NAMES };
});
