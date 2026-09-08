// Run with: node sanitize.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner (same
// pattern as pricing/engine.test.js).

const assert = require('assert');
const { sanitizeSegment, buildJobFolderName, formatDateForFolderName } = require('./sanitize.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

test('leaves a normal name untouched', () => {
  assert.strictEqual(sanitizeSegment('12 Cozens Dr'), '12 Cozens Dr');
});

test('replaces a forward slash (unit-range address)', () => {
  assert.strictEqual(sanitizeSegment('12/14 Main St'), '12-14 Main St');
});

test('replaces every Windows-illegal character', () => {
  assert.strictEqual(sanitizeSegment('a\\b/c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
});

test('strips control characters', () => {
  assert.strictEqual(sanitizeSegment('abc\x00\x1Fdef'), 'abc--def');
});

test('trims trailing dots and spaces (Windows rule)', () => {
  assert.strictEqual(sanitizeSegment('Some Folder...  '), 'Some Folder');
});

test('collapses internal whitespace runs', () => {
  assert.strictEqual(sanitizeSegment('a    b'), 'a b');
});

test('falls back to default on empty/whitespace-only input', () => {
  assert.strictEqual(sanitizeSegment('   ', 'fallback'), 'fallback');
  assert.strictEqual(sanitizeSegment('', 'fallback'), 'fallback');
});

test('falls back to "untitled" when no fallback given', () => {
  assert.strictEqual(sanitizeSegment(''), 'untitled');
});

test('handles null/undefined input', () => {
  assert.strictEqual(sanitizeSegment(null, 'x'), 'x');
  assert.strictEqual(sanitizeSegment(undefined, 'x'), 'x');
});

test('dodges a reserved Windows device name (exact)', () => {
  assert.strictEqual(sanitizeSegment('CON'), 'CON_');
  assert.strictEqual(sanitizeSegment('con'), 'con_');
});

test('dodges a reserved Windows device name with an extension', () => {
  assert.strictEqual(sanitizeSegment('NUL.txt'), 'NUL.txt_');
});

test('does not flag a name that merely starts with a reserved word', () => {
  assert.strictEqual(sanitizeSegment('CONference Room'), 'CONference Room');
});

test('buildJobFolderName: normal case -- no leading zero on month/day', () => {
  assert.strictEqual(
    buildJobFolderName({ shootDate: '2026/08/27', address: '12 Cozens Dr, Markham', clientName: 'Jane Smith' }),
    '2026.8.27 12 Cozens Dr, Markham_Jane Smith'
  );
});

test('buildJobFolderName: sanitizes illegal characters in address/client', () => {
  assert.strictEqual(
    buildJobFolderName({ shootDate: '2026/08/27', address: '12/14 Main St', clientName: 'A/B Realty' }),
    '2026.8.27 12-14 Main St_A-B Realty'
  );
});

test('buildJobFolderName: missing pieces fall back to placeholders', () => {
  assert.strictEqual(
    buildJobFolderName({ shootDate: '2026/08/27', address: '', clientName: '' }),
    '2026.8.27 Unknown Address_Unknown Client'
  );
});

test('buildJobFolderName: strips leading zero from both single-digit month AND day', () => {
  assert.strictEqual(
    buildJobFolderName({ shootDate: '2026/09/08', address: '1 Test Ave', clientName: 'Client' }),
    '2026.9.8 1 Test Ave_Client'
  );
});

test('buildJobFolderName: leaves an already-two-digit month/day untouched', () => {
  assert.strictEqual(
    buildJobFolderName({ shootDate: '2026/12/25', address: '1 Test Ave', clientName: 'Client' }),
    '2026.12.25 1 Test Ave_Client'
  );
});

test('formatDateForFolderName: strips both leading zeros', () => {
  assert.strictEqual(formatDateForFolderName('2026/01/01'), '2026.1.1');
});

test('formatDateForFolderName: accepts dash separators too', () => {
  assert.strictEqual(formatDateForFolderName('2026-09-08'), '2026.9.8');
});

test('formatDateForFolderName: falls back to a plain separator swap on unexpected input rather than throwing', () => {
  assert.strictEqual(formatDateForFolderName('not a date'), 'not a date');
  assert.strictEqual(formatDateForFolderName(''), '');
  assert.doesNotThrow(() => formatDateForFolderName(null));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
