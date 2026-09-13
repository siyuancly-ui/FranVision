const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { FORM_STATE_FILENAME, readFormState, writeFormState } = require('./form-state.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (err) {
    console.log('  FAIL  ' + name);
    console.log('    ' + err.message);
    failed++;
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'form-state-test-'));
}

test('readFormState: defaults when the sidecar does not exist', () => {
  const dir = makeTmpDir();
  try {
    assert.deepStrictEqual(readFormState(dir), {
      shootTime: '', notes: '', chosenCandidateIndex: null,
      commission: { checkedItemIds: [], travelCents: 0 },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFormState: defaults (not a throw) when the sidecar is corrupted', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, FORM_STATE_FILENAME), 'not json');
    assert.doesNotThrow(() => readFormState(dir));
    assert.strictEqual(readFormState(dir).shootTime, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFormState / readFormState: round-trips shootTime, notes, chosenCandidateIndex, commission', () => {
  const dir = makeTmpDir();
  try {
    writeFormState(dir, {
      shootTime: '14:30',
      notes: 'lockbox code 4821',
      chosenCandidateIndex: 1,
      commission: { checkedItemIds: ['photography', 'drone'], travelCents: 2500 },
    });
    assert.deepStrictEqual(readFormState(dir), {
      shootTime: '14:30',
      notes: 'lockbox code 4821',
      chosenCandidateIndex: 1,
      commission: { checkedItemIds: ['photography', 'drone'], travelCents: 2500 },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFormState: full-state overwrite, not merge -- a second write without a field clears it', () => {
  const dir = makeTmpDir();
  try {
    writeFormState(dir, { shootTime: '14:30', notes: 'first' });
    writeFormState(dir, { notes: 'second' });
    const state = readFormState(dir);
    assert.strictEqual(state.shootTime, '');
    assert.strictEqual(state.notes, 'second');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFormState: missing chosenCandidateIndex is stored as null, not 0/undefined', () => {
  const dir = makeTmpDir();
  try {
    writeFormState(dir, { shootTime: '14:30' });
    assert.strictEqual(readFormState(dir).chosenCandidateIndex, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
