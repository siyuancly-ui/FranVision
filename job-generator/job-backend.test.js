const assert = require('assert');
const backend = require('./job-backend.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message); }
}

const ENV = { JG_SUPABASE_URL: 'https://x.supabase.co/', JG_SUPABASE_ANON_KEY: 'anon', JG_TOKEN: 'secret-token' };
const okFetch = (payload, calls) => async (url, opts) => {
  if (calls) calls.push({ url, opts });
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

(async () => {
  await test('isConfigured: needs all three of url / anon key / token', () => {
    assert.strictEqual(backend.isConfigured(ENV), true);
    assert.strictEqual(backend.isConfigured({ ...ENV, JG_TOKEN: '' }), false);
    assert.strictEqual(backend.isConfigured({}), false);
  });

  await test('rpc: POSTs to /rest/v1/rpc/<name> with apikey, bearer, and the token merged into the body', async () => {
    const calls = [];
    const out = await backend.rpc('jg_get_job', { p_folder_name: 'F' }, { env: ENV, fetchImpl: okFetch({ a: 1 }, calls) });
    assert.deepStrictEqual(out, { a: 1 });
    assert.strictEqual(calls[0].url, 'https://x.supabase.co/rest/v1/rpc/jg_get_job');
    assert.strictEqual(calls[0].opts.headers.apikey, 'anon');
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { p_token: 'secret-token', p_folder_name: 'F' });
  });

  await test('rpc: a null response body (e.g. job not found) comes back as null', async () => {
    const out = await backend.getJob('F', { env: ENV, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' }) });
    assert.strictEqual(out, null);
  });

  await test('rpc: network failure -> BackendError with unreachable:true', async () => {
    await assert.rejects(
      backend.rpc('x', {}, { env: ENV, fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
      (e) => e.name === 'BackendError' && e.unreachable === true
    );
  });

  await test('rpc: HTTP error -> BackendError (not unreachable) carrying the server message', async () => {
    const f = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'jg: invalid token' }) });
    await assert.rejects(backend.rpc('x', {}, { env: ENV, fetchImpl: f }), (e) => e.unreachable === false && e.status === 400 && /invalid token/.test(e.message));
  });

  await test('rpc: unconfigured -> BackendError, no request made', async () => {
    let called = false;
    await assert.rejects(backend.rpc('x', {}, { env: {}, fetchImpl: async () => { called = true; } }), /not configured/);
    assert.strictEqual(called, false);
  });

  await test('allocateJobId / peekJobId: send today as YYYYMMDD and the floor', async () => {
    const calls = [];
    await backend.allocateJobId({ date: new Date(2026, 8, 5), floor: 3 }, { env: ENV, fetchImpl: okFetch('FVS-20260905-004', calls) });
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { p_token: 'secret-token', p_day: '20260905', p_floor: 3 });
    await backend.peekJobId({ date: new Date(2026, 8, 5) }, { env: ENV, fetchImpl: okFetch('x', calls) });
    assert.ok(calls[1].url.endsWith('/jg_peek_job_id'));
  });

  await test('list/upsert/delete call the matching RPCs with the right arguments', async () => {
    const calls = [];
    const deps = { env: ENV, fetchImpl: okFetch([], calls) };
    await backend.listDrafts(deps);
    await backend.listRecentJobs('2026-09-01T00:00:00Z', deps);
    await backend.upsertJob({ folder_name: 'F' }, deps);
    await backend.deleteDraft('F', deps);
    const names = calls.map((c) => c.url.split('/').pop());
    assert.deepStrictEqual(names, ['jg_list_jobs', 'jg_list_jobs', 'jg_upsert_job', 'jg_delete_draft']);
    assert.strictEqual(JSON.parse(calls[0].opts.body).p_kind, 'drafts');
    assert.strictEqual(JSON.parse(calls[1].opts.body).p_since, '2026-09-01T00:00:00Z');
    assert.deepStrictEqual(JSON.parse(calls[2].opts.body).p_row, { folder_name: 'F' });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
