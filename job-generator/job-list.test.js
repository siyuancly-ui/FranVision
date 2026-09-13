const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { scanJobs, listDrafts, listRecentJobs, RECENT_JOBS_WINDOW_MS } = require('./job-list.js');
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

test('listRecentJobs: only real jobIds created within the window, most-recent first, excludes drafts and stale jobs', () => {
  const root = makeTmpDir();
  const now = new Date('2026-09-13T12:00:00.000Z');
  try {
    writeJob(root, 'draft', { jobId: null, createdAt: '2026-09-13T00:00:00.000Z' });
    writeJob(root, 'stale-job', { jobId: 'FVS-20260901-001', createdAt: '2026-09-01T00:00:00.000Z' });
    writeJob(root, 'recent-job-1', { jobId: 'FVS-20260912-001', createdAt: '2026-09-12T00:00:00.000Z' });
    writeJob(root, 'recent-job-2', { jobId: 'FVS-20260913-001', createdAt: '2026-09-13T10:00:00.000Z' });
    const recent = listRecentJobs(root, now);
    assert.deepStrictEqual(recent.map((j) => j.folderName), ['recent-job-2', 'recent-job-1']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listRecentJobs: a job exactly at the window boundary is still included', () => {
  const root = makeTmpDir();
  const now = new Date('2026-09-13T12:00:00.000Z');
  try {
    const boundary = new Date(now.getTime() - RECENT_JOBS_WINDOW_MS).toISOString();
    writeJob(root, 'boundary-job', { jobId: 'FVS-20260910-001', createdAt: boundary });
    assert.strictEqual(listRecentJobs(root, now).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
