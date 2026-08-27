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

  // Builds the top-level job folder name: "YYYY.MM.DD Address_Client".
  // shootDate must be a "YYYY/MM/DD" or "YYYY-MM-DD" string (validation
  // happens elsewhere -- this just reformats the separator to dots).
  function buildJobFolderName({ shootDate, address, clientName }) {
    const datePart = String(shootDate || '').replace(/[/.]/g, '.').trim();
    const addressPart = sanitizeSegment(address, 'Unknown Address');
    const clientPart = sanitizeSegment(clientName, 'Unknown Client');
    return sanitizeSegment(datePart + ' ' + addressPart + '_' + clientPart);
  }

  return { sanitizeSegment, buildJobFolderName, ILLEGAL_CHARS_REGEX, WINDOWS_RESERVED_NAMES };
});
