// Run with: node id-generator.test.js
// No dependencies -- plain Node `assert` + a tiny pass/fail runner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  formatDateStamp,
  buildJobId,
  nextSequenceFromExistingIds,
  collectExistingJobIds,
  getNextJobId,
} = require('./id-generator.js');

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

// ---- pure logic ----

test('formatDateStamp pads month/day', () => {
  assert.strictEqual(formatDateStamp(new Date(2026, 0, 5)), '20260105');
});

test('buildJobId formats with 3-digit zero-padded sequence', () => {
  assert.strictEqual(buildJobId(new Date(2026, 7, 26), 1), 'FVS-20260826-001');
  assert.strictEqual(buildJobId(new Date(2026, 7, 26), 42), 'FVS-20260826-042');
});

test('buildJobId does not truncate past 999', () => {
  assert.strictEqual(buildJobId(new Date(2026, 7, 26), 1000), 'FVS-20260826-1000');
});

test('nextSequenceFromExistingIds starts at 1 with no existing ids', () => {
  assert.strictEqual(nextSequenceFromExistingIds([], '20260826'), 1);
});

test('nextSequenceFromExistingIds increments from the max seen today', () => {
  const ids = ['FVS-20260826-001', 'FVS-20260826-003', 'FVS-20260826-002'];
  assert.strictEqual(nextSequenceFromExistingIds(ids, '20260826'), 4);
});

test('nextSequenceFromExistingIds ignores ids from other days', () => {
  const ids = ['FVS-20260825-009', 'FVS-20260826-001'];
  assert.strictEqual(nextSequenceFromExistingIds(ids, '20260826'), 2);
});

test('nextSequenceFromExistingIds ignores garbage values', () => {
  const ids = ['not-a-job-id', null, 42, 'FVS-20260826-001'];
  assert.strictEqual(nextSequenceFromExistingIds(ids, '20260826'), 2);
});

// ---- fs-backed ----

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fv-jobgen-test-'));
}

test('collectExistingJobIds returns [] for a nonexistent root folder', () => {
  const ids = collectExistingJobIds('/no/such/path/at/all');
  assert.deepStrictEqual(ids, []);
});

test('collectExistingJobIds reads jobId out of each subfolder\'s job.json', () => {
  const root = makeTmpDir();
  try {
    fs.mkdirSync(path.join(root, 'Job A'));
    fs.writeFileSync(path.join(root, 'Job A', 'job.json'), JSON.stringify({ jobId: 'FVS-20260826-001' }));
    fs.mkdirSync(path.join(root, 'Job B'));
    fs.writeFileSync(path.join(root, 'Job B', 'job.json'), JSON.stringify({ jobId: 'FVS-20260826-002' }));
    fs.mkdirSync(path.join(root, 'Not A Job')); // no job.json inside

    const ids = collectExistingJobIds(root).sort();
    assert.deepStrictEqual(ids, ['FVS-20260826-001', 'FVS-20260826-002']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectExistingJobIds skips malformed job.json instead of throwing', () => {
  const root = makeTmpDir();
  try {
    fs.mkdirSync(path.join(root, 'Bad Job'));
    fs.writeFileSync(path.join(root, 'Bad Job', 'job.json'), '{ not valid json');
    fs.mkdirSync(path.join(root, 'Good Job'));
    fs.writeFileSync(path.join(root, 'Good Job', 'job.json'), JSON.stringify({ jobId: 'FVS-20260826-005' }));

    const ids = collectExistingJobIds(root);
    assert.deepStrictEqual(ids, ['FVS-20260826-005']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextJobId end-to-end against a real folder', () => {
  const root = makeTmpDir();
  try {
    const today = new Date(2026, 7, 26);
    fs.mkdirSync(path.join(root, 'Job A'));
    fs.writeFileSync(path.join(root, 'Job A', 'job.json'), JSON.stringify({ jobId: 'FVS-20260826-001' }));

    assert.strictEqual(getNextJobId(root, today), 'FVS-20260826-002');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextJobId starts fresh on an empty/nonexistent root', () => {
  assert.strictEqual(getNextJobId('/no/such/path/at/all', new Date(2026, 7, 26)), 'FVS-20260826-001');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
