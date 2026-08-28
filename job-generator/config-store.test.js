// Run with: node config-store.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readConfig, writeConfig, getRootFolder, setRootFolder } = require('./config-store.js');

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

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-config-test-'));
  return path.join(dir, '.config.json');
}

test('readConfig returns {} when the file does not exist', () => {
  assert.deepStrictEqual(readConfig('/no/such/path/.config.json'), {});
});

test('readConfig returns {} on malformed JSON instead of throwing', () => {
  const p = tempConfigPath();
  fs.writeFileSync(p, '{ not valid json');
  assert.deepStrictEqual(readConfig(p), {});
});

test('writeConfig then readConfig round-trips', () => {
  const p = tempConfigPath();
  writeConfig({ rootFolder: '/Users/test/Jobs' }, p);
  assert.deepStrictEqual(readConfig(p), { rootFolder: '/Users/test/Jobs' });
});

test('getRootFolder falls back to the default when nothing is stored', () => {
  assert.strictEqual(getRootFolder('/default/path', '/no/such/path/.config.json'), '/default/path');
});

test('setRootFolder persists it, getRootFolder then returns it (ignores the default)', () => {
  const p = tempConfigPath();
  setRootFolder('/Users/test/Jobs', p);
  assert.strictEqual(getRootFolder('/default/path', p), '/Users/test/Jobs');
});

test('setRootFolder preserves other keys already in the config file', () => {
  const p = tempConfigPath();
  writeConfig({ someOtherSetting: 42 }, p);
  setRootFolder('/Users/test/Jobs', p);
  assert.deepStrictEqual(readConfig(p), { someOtherSetting: 42, rootFolder: '/Users/test/Jobs' });
});

test('setRootFolder can be called twice, second call wins', () => {
  const p = tempConfigPath();
  setRootFolder('/first/path', p);
  setRootFolder('/second/path', p);
  assert.strictEqual(getRootFolder(null, p), '/second/path');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
