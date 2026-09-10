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
  findExistingJob,
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

// ---- findExistingJob ----

test('findExistingJob: null when no folder with that canonical name exists', () => {
  const root = makeTmpDir();
  try {
    assert.strictEqual(findExistingJob(root, '2026.9.20 1 Main St_Jane'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findExistingJob: returns jobId/createdAt/previousTotalCents/order for a real job', () => {
  const root = makeTmpDir();
  const name = '2026.9.20 1 Main St_Jane';
  try {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'job.json'), JSON.stringify({
      jobId: 'FVS-20260920-002',
      createdAt: '2026-09-20T10:00:00.000Z',
      pricing: { totalCents: 11074 },
      services: { photography: 'standard', addons: { floor_plan: true } },
    }));
    const found = findExistingJob(root, name);
    assert.strictEqual(found.jobId, 'FVS-20260920-002');
    assert.strictEqual(found.createdAt, '2026-09-20T10:00:00.000Z');
    assert.strictEqual(found.previousTotalCents, 11074);
    assert.deepStrictEqual(found.order, { photography: 'standard', addons: { floor_plan: true } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findExistingJob: { unreadable: true } when the folder exists but job.json is missing or malformed', () => {
  const root = makeTmpDir();
  try {
    fs.mkdirSync(path.join(root, 'no-json'));
    assert.strictEqual(findExistingJob(root, 'no-json').unreadable, true);

    fs.mkdirSync(path.join(root, 'bad-json'));
    fs.writeFileSync(path.join(root, 'bad-json', 'job.json'), 'not json at all');
    assert.strictEqual(findExistingJob(root, 'bad-json').unreadable, true);

    fs.mkdirSync(path.join(root, 'no-id'));
    fs.writeFileSync(path.join(root, 'no-id', 'job.json'), JSON.stringify({ createdAt: 'x' }));
    assert.strictEqual(findExistingJob(root, 'no-id').unreadable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findExistingJob: null when a FILE (not a directory) has that name', () => {
  const root = makeTmpDir();
  try {
    fs.writeFileSync(path.join(root, 'notafolder'), 'x');
    assert.strictEqual(findExistingJob(root, 'notafolder'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
