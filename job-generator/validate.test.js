// Run with: node validate.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const { isValidShootDate } = require('./validate.js');

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

test('accepts a well-formed date', () => {
  assert.strictEqual(isValidShootDate('2026/08/27'), true);
});

test('rejects day/month swapped (still well-formed, just not what it means)', () => {
  // This is exactly the mistake the check exists to catch -- 27 is not a
  // valid month, so this correctly fails even though it "looks like" a date.
  assert.strictEqual(isValidShootDate('2026/27/08'), false);
});

test('rejects single-digit month/day (must be zero-padded)', () => {
  assert.strictEqual(isValidShootDate('2026/8/7'), false);
});

test('rejects dashes instead of slashes', () => {
  assert.strictEqual(isValidShootDate('2026-08-27'), false);
});

test('rejects a non-existent calendar date', () => {
  assert.strictEqual(isValidShootDate('2026/02/30'), false);
});

test('accepts a leap-day date on a leap year', () => {
  assert.strictEqual(isValidShootDate('2028/02/29'), true);
});

test('rejects a leap-day date on a non-leap year', () => {
  assert.strictEqual(isValidShootDate('2026/02/29'), false);
});

test('rejects month 00 and month 13', () => {
  assert.strictEqual(isValidShootDate('2026/00/15'), false);
  assert.strictEqual(isValidShootDate('2026/13/15'), false);
});

test('rejects empty/garbage/non-string input', () => {
  assert.strictEqual(isValidShootDate(''), false);
  assert.strictEqual(isValidShootDate('not a date'), false);
  assert.strictEqual(isValidShootDate(null), false);
  assert.strictEqual(isValidShootDate(undefined), false);
});

test('tolerates surrounding whitespace', () => {
  assert.strictEqual(isValidShootDate('  2026/08/27  '), true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
