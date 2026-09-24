const assert = require('assert');
const { score, rankMatches, editDistance } = require('./wave-match.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message); }
}

test('identical names (ignoring case, spacing, punctuation) score 0', () => {
  assert.strictEqual(score('Margaret', 'margaret'), 0);
  assert.strictEqual(score('Jane  Smith', 'jane smith'), 0);
  assert.strictEqual(score('J. Smith', 'J Smith'), 0);
});

test('containment scores 1, but not for very short strings', () => {
  assert.strictEqual(score('Jane Smith', 'Jane Smith Realty'), 1);
  assert.strictEqual(score('Jane Smith Realty', 'Jane Smith'), 1);
  assert.strictEqual(score('Li', 'Lily Wong'), null); // 2 latin chars: too short to trust
  assert.strictEqual(score('李明', '李明地产'), 1);   // 2 CJK chars are enough
});

test('same words in another order / extra middle initial score 2', () => {
  assert.strictEqual(score('Smith Jane', 'Jane Smith'), 2);
  assert.strictEqual(score('Jane Smith', 'Jane A. Smith'), 2);
});

test('small spelling differences score 3; unrelated names do not match', () => {
  assert.strictEqual(score('Margret', 'Margaret'), 3);
  assert.strictEqual(score('Yinan Xia', 'Yinan Xai'), 3);
  assert.strictEqual(score('Margaret', 'Monica Mac'), null);
  assert.strictEqual(score('Tom', 'Tim'), null); // short names: no typo tolerance
});

test('editDistance stops early once the limit is exceeded', () => {
  assert.strictEqual(editDistance('kitten', 'sitting', 5), 3);
  assert.ok(editDistance('abcdef', 'uvwxyz', 1) > 1);
});

test('rankMatches: best score first, ties alphabetical, limit applied, original fields kept', () => {
  const rows = [
    { id: '1', name: 'Margaret Lee' }, { id: '2', name: 'Margret' }, { id: '3', name: 'Margaret' }, { id: '4', name: 'Bob' },
  ];
  const r = rankMatches('Margaret', rows, 2);
  assert.deepStrictEqual(r.map((x) => [x.id, x.matchScore]), [['3', 0], ['1', 1]]);
  assert.deepStrictEqual(rankMatches('Margaret', rows).map((x) => x.id), ['3', '1', '2']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
