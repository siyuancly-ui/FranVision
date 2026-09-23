const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { scanJobs, listDrafts, listRecentJobs, markJobCompleted } = require('./job-list.js');
const { writeFormState } = require('./form-state.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-list-test-'));
}

function writeJob(root, folderName, data) {
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(data));
  return dir;
}

test('scanJobs: [] for a nonexistent root folder', () => {
  assert.deepStrictEqual(scanJobs(path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), []);
});

test('scanJobs: skips folders with no job.json, malformed job.json, or a corrupted jobId', () => {
  const root = makeTmpDir();
  try {
    fs.mkdirSync(path.join(root, 'no-json'));
    writeJob(root, 'bad-json', {});
    fs.writeFileSync(path.join(root, 'bad-json', 'job.json'), 'not json');
    writeJob(root, 'garbage-id', { jobId: 42 });
    writeJob(root, 'good-draft', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    assert.strictEqual(scanJobs(root).length, 1);
    assert.strictEqual(scanJobs(root)[0].folderName, 'good-draft');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanJobs: reads client/address/shootDate/pricing back out of job.json', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, '2026.9.20 1 Main St_Jane', {
      jobId: 'FVS-20260920-001',
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T11:00:00.000Z',
      client: { name: 'Jane' },
      property: { address: '1 Main St', propertyType: 'house' },
      shootDate: '2026/09/20',
      pricing: { totalCents: 12345 },
    });
    const [job] = scanJobs(root);
    assert.strictEqual(job.jobId, 'FVS-20260920-001');
    assert.strictEqual(job.clientName, 'Jane');
    assert.strictEqual(job.address, '1 Main St');
    assert.strictEqual(job.propertyType, 'house');
    assert.strictEqual(job.shootDate, '2026/09/20');
    assert.strictEqual(job.previousTotalCents, 12345);
    assert.strictEqual(job.updatedAt, '2026-09-20T11:00:00.000Z');
    assert.strictEqual(job.hasCalendar, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanJobs: shootTime is read back from form-state.js\'s sidecar, not job.json', () => {
  const root = makeTmpDir();
  try {
    const dir = writeJob(root, 'has-time', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    writeFormState(dir, { shootTime: '14:30' });
    writeJob(root, 'no-time', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    const jobs = scanJobs(root);
    assert.strictEqual(jobs.find((j) => j.folderName === 'has-time').shootTime, '14:30');
    assert.strictEqual(jobs.find((j) => j.folderName === 'no-time').shootTime, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listDrafts: only jobId === null folders, most-recently-updated first', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, 'draft-old', { jobId: null, updatedAt: '2026-09-10T00:00:00.000Z' });
    writeJob(root, 'draft-new', { jobId: null, updatedAt: '2026-09-12T00:00:00.000Z' });
    writeJob(root, 'real-job', { jobId: 'FVS-20260913-001', updatedAt: '2026-09-13T00:00:00.000Z' });
    const drafts = listDrafts(root);
    assert.deepStrictEqual(drafts.map((d) => d.folderName), ['draft-new', 'draft-old']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listRecentJobs: every real jobId regardless of age, most-recent first, excludes drafts (permanent retention, 2026-09-22)', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, 'draft', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    writeJob(root, 'ancient-job', { jobId: 'FVS-20260101-001', createdAt: '2026-01-01T00:00:00.000Z' });
    writeJob(root, 'recent-job-1', { jobId: 'FVS-20260912-001', createdAt: '2026-09-12T00:00:00.000Z' });
    writeJob(root, 'recent-job-2', { jobId: 'FVS-20260913-001', createdAt: '2026-09-13T10:00:00.000Z' });
    const recent = listRecentJobs(root);
    assert.deepStrictEqual(recent.map((j) => j.folderName), ['recent-job-2', 'recent-job-1', 'ancient-job']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listRecentJobs: excludes a job with completedAt set, even if very recent', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, 'still-open', { jobId: 'FVS-20260913-001', createdAt: '2026-09-13T00:00:00.000Z' });
    writeJob(root, 'done', { jobId: 'FVS-20260913-002', createdAt: '2026-09-13T01:00:00.000Z', completedAt: '2026-09-13T05:00:00.000Z' });
    assert.deepStrictEqual(listRecentJobs(root).map((j) => j.folderName), ['still-open']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanJobs: reads completedAt back out of job.json (null when absent/not a string)', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, 'open', { jobId: 'FVS-20260913-001', createdAt: '2026-09-13T00:00:00.000Z' });
    writeJob(root, 'done', { jobId: 'FVS-20260913-002', createdAt: '2026-09-13T00:00:00.000Z', completedAt: '2026-09-14T00:00:00.000Z' });
    const jobs = scanJobs(root);
    assert.strictEqual(jobs.find((j) => j.folderName === 'open').completedAt, null);
    assert.strictEqual(jobs.find((j) => j.folderName === 'done').completedAt, '2026-09-14T00:00:00.000Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- markJobCompleted ----

test('markJobCompleted: sets completedAt on the real job\'s job.json, leaves other fields untouched, returns true', () => {
  const root = makeTmpDir();
  try {
    writeJob(root, 'a-job', { jobId: 'FVS-20260913-001', createdAt: '2026-09-13T00:00:00.000Z', client: { name: 'Jane' } });
    assert.strictEqual(markJobCompleted(root, 'a-job'), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'a-job', 'job.json'), 'utf8'));
    assert.ok(typeof saved.completedAt === 'string' && saved.completedAt.length > 0);
    assert.strictEqual(saved.client.name, 'Jane');
    assert.deepStrictEqual(listRecentJobs(root), []); // drops out of the list immediately
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('markJobCompleted: false (no throw) for a missing folder, unreadable job.json, or a Draft (jobId: null)', () => {
  const root = makeTmpDir();
  try {
    assert.strictEqual(markJobCompleted(root, 'does-not-exist'), false);
    writeJob(root, 'a-draft', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    assert.strictEqual(markJobCompleted(root, 'a-draft'), false);
    fs.mkdirSync(path.join(root, 'bad'));
    fs.writeFileSync(path.join(root, 'bad', 'job.json'), 'not json');
    assert.strictEqual(markJobCompleted(root, 'bad'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
