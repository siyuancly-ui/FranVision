const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('./job-sync.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jg-sync-'));
const writeJob = (root, name, data) => { fs.mkdirSync(path.join(root, name), { recursive: true }); fs.writeFileSync(path.join(root, name, 'job.json'), JSON.stringify(data)); };
const ROW = (o) => Object.assign({
  folder_name: 'F', job_id: null, client_name: 'Jane', address: '1 Main', shoot_date: '2026/09/20',
  created_at: '2026-09-19T10:00:00Z', updated_at: '2026-09-19T11:00:00Z',
  data: { job: { photographer: 'Franky', property: { address: '1 Main', propertyType: 'house' }, services: { photography: 'standard' }, pricing: { totalCents: 11074 } }, form: { shootTime: '14:30', notes: 'gate 1234', chosenCandidateIndex: 1, commission: { checkedItemIds: ['photography'], travelCents: 500 } } },
}, o);
const fake = (over) => Object.assign({ isConfigured: () => true, getJob: async () => null, allocateJobId: async () => 'FVS-20260919-001' }, over);

(async () => {
  await test('summaryFromRow: list-panel shape incl. shootTime from the form state', () => {
    const s = sync.summaryFromRow(ROW({}));
    assert.strictEqual(s.folderName, 'F'); assert.strictEqual(s.jobId, null);
    assert.strictEqual(s.shootTime, '14:30'); assert.strictEqual(s.previousTotalCents, 11074);
    assert.strictEqual(s.updatedAt, '2026-09-19T11:00:00Z');
  });

  await test('detailFromRow: everything loadJobIntoForm needs, from the server row alone', () => {
    const d = sync.detailFromRow(ROW({ job_id: 'FVS-20260919-002' }));
    assert.strictEqual(d.jobId, 'FVS-20260919-002'); assert.strictEqual(d.photographerName, 'Franky');
    assert.deepStrictEqual(d.order, { photography: 'standard' });
    assert.strictEqual(d.notes, 'gate 1234'); assert.strictEqual(d.chosenCandidateIndex, 1);
    assert.deepStrictEqual(d.commission, { checkedItemIds: ['photography'], travelCents: 500 });
  });

  await test('buildRow: identity columns + { job, form } blob; a draft has job_id null', () => {
    const job = { jobId: null, createdAt: 'c', client: { name: 'Jane' }, property: { address: '1 Main' }, shootDate: '2026/09/20' };
    const r = sync.buildRow({ folderName: 'F', previousFolderName: 'Old', job, form: { shootTime: '' } });
    assert.strictEqual(r.job_id, null); assert.strictEqual(r.previous_folder_name, 'Old');
    assert.strictEqual(r.client_name, 'Jane'); assert.deepStrictEqual(r.data, { job, form: { shootTime: '' } });
  });

  await test('resolveExisting: backend unconfigured -> exactly the local lookup', async () => {
    const root = tmp();
    try {
      writeJob(root, 'F', { jobId: 'FVS-20260919-005', createdAt: 'c' });
      const r = await sync.resolveExisting(root, 'F', { isConfigured: () => false });
      assert.strictEqual(r.existing.jobId, 'FVS-20260919-005');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('resolveExisting: job exists only on the SERVER (made on the other machine) -> update mode with its ID', async () => {
    const root = tmp();
    try {
      const r = await sync.resolveExisting(root, 'F', fake({ getJob: async () => ROW({ job_id: 'FVS-20260919-002' }) }));
      assert.strictEqual(r.existing.jobId, 'FVS-20260919-002'); assert.strictEqual(r.existing.source, 'server');
      assert.deepStrictEqual(r.existing.order, { photography: 'standard' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('resolveExisting: server has a DRAFT -> existing with jobId null (not a real job)', async () => {
    const root = tmp();
    try {
      const r = await sync.resolveExisting(root, 'F', fake({ getJob: async () => ROW({}) }));
      assert.strictEqual(r.existing.jobId, null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('resolveExisting: two DIFFERENT real IDs for one identity -> conflict, never merged silently', async () => {
    const root = tmp();
    try {
      writeJob(root, 'F', { jobId: 'FVS-20260919-001', createdAt: 'c' });
      const r = await sync.resolveExisting(root, 'F', fake({ getJob: async () => ROW({ job_id: 'FVS-20260919-002' }) }));
      assert.deepStrictEqual(r.conflict, { local: 'FVS-20260919-001', remote: 'FVS-20260919-002' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('resolveExisting: local already real, server still has the draft -> keep the local ID (server catches up on upsert)', async () => {
    const root = tmp();
    try {
      writeJob(root, 'F', { jobId: 'FVS-20260919-003', createdAt: 'c' });
      const r = await sync.resolveExisting(root, 'F', fake({ getJob: async () => ROW({}) }));
      assert.strictEqual(r.existing.jobId, 'FVS-20260919-003'); assert.strictEqual(r.conflict, null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('resolveExisting: an unreachable server propagates (caller refuses instead of guessing)', async () => {
    await assert.rejects(sync.resolveExisting(tmp(), 'F', fake({ getJob: async () => { throw new Error('offline'); } })), /offline/);
  });

  await test('allocateJobId: passes the highest LOCAL sequence today as the floor', async () => {
    const root = tmp();
    try {
      const stamp = require('./id-generator.js').formatDateStamp(new Date());
      writeJob(root, 'A', { jobId: 'FVS-' + stamp + '-007' });
      let seen;
      const id = await sync.allocateJobId({ rootFolder: root, backend: fake({ allocateJobId: async (a) => { seen = a; return 'FVS-' + stamp + '-008'; } }) });
      assert.strictEqual(seen.floor, 7); assert.strictEqual(id, 'FVS-' + stamp + '-008');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('allocateJobId: an ID already tagged on Dropbox is skipped (floor jumps past it)', async () => {
    const root = tmp();
    try {
      const stamp = require('./id-generator.js').formatDateStamp(new Date());
      const floors = []; let n = 0;
      const backend = fake({ allocateJobId: async ({ floor }) => { floors.push(floor); return 'FVS-' + stamp + '-00' + (++n); } });
      const id = await sync.allocateJobId({ rootFolder: root, backend, checkFn: async (i) => ({ checked: true, exists: i.endsWith('-001') }) });
      assert.strictEqual(id, 'FVS-' + stamp + '-002'); assert.deepStrictEqual(floors, [0, 1]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('allocateJobId: a Dropbox check that cannot run never blocks -- ID returned as allocated', async () => {
    const stamp = require('./id-generator.js').formatDateStamp(new Date());
    const id = await sync.allocateJobId({ rootFolder: tmp(), backend: fake({ allocateJobId: async () => 'FVS-' + stamp + '-001' }), checkFn: async () => ({ checked: false, exists: false }) });
    assert.strictEqual(id, 'FVS-' + stamp + '-001');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
