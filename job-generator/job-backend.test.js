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
  await test('uploadImage: POSTs the bytes to the bucket with the machine token header and returns the PUBLIC link', async () => {
    const calls = [];
    const url = await backend.uploadImage(
      { objectPath: 'ab12.jpg', contentType: 'image/jpeg', buffer: Buffer.from('bytes') },
      { env: ENV, fetchImpl: async (u, o) => { calls.push({ u, o }); return { ok: true, status: 200, text: async () => '{}' }; } });
    assert.strictEqual(url, 'https://x.supabase.co/storage/v1/object/public/jg-shoot-notes/ab12.jpg');
    assert.strictEqual(calls[0].u, 'https://x.supabase.co/storage/v1/object/jg-shoot-notes/ab12.jpg');
    assert.strictEqual(calls[0].o.method, 'POST');
    assert.strictEqual(calls[0].o.headers['x-jg-token'], 'secret-token');
    assert.strictEqual(calls[0].o.headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(calls[0].o.headers['x-upsert'], 'false');
    assert.ok(Buffer.from('bytes').equals(calls[0].o.body));
  });

  await test('uploadImage: rejected upload -> BackendError with status + message; network failure -> unreachable', async () => {
    await assert.rejects(
      backend.uploadImage({ objectPath: 'a.jpg', buffer: Buffer.alloc(1) }, { env: ENV, fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: 'violates row-level security' }) }) }),
      (e) => e.name === 'BackendError' && e.status === 403 && /row-level security/.test(e.message) && e.unreachable === false);
    await assert.rejects(
      backend.uploadImage({ objectPath: 'a.jpg', buffer: Buffer.alloc(1) }, { env: ENV, fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
      (e) => e.unreachable === true);
  });

  await test('recordWavePairing / suggestWavePairings: call the token-gated RPCs with the right argument names', async () => {
    const calls = [];
    await backend.recordWavePairing({ clientName: 'Jane Smith', waveCustomerId: 'W1', waveCustomerName: 'Jane Realty' }, { env: ENV, fetchImpl: okFetch({}, calls) });
    const rec = JSON.parse(calls[0].opts.body);
    assert.ok(calls[0].url.endsWith('/rest/v1/rpc/jg_record_wave_pairing'));
    assert.deepStrictEqual(rec, { p_token: 'secret-token', p_client_name: 'Jane Smith', p_wave_customer_id: 'W1', p_wave_customer_name: 'Jane Realty' });
    const out = await backend.suggestWavePairings('Jane', { env: ENV, fetchImpl: okFetch([{ waveCustomerId: 'W1' }], calls) });
    assert.ok(calls[1].url.endsWith('/rest/v1/rpc/jg_suggest_wave_pairings'));
    assert.deepStrictEqual(JSON.parse(calls[1].opts.body), { p_token: 'secret-token', p_client_name: 'Jane' });
    assert.deepStrictEqual(out, [{ waveCustomerId: 'W1' }]);
  });

  await test('getWaveMap / setWaveMap: call jg_get_wave_map / jg_set_wave_map with the token (and p_map)', async () => {
    const calls = [];
    const got = await backend.getWaveMap({ env: ENV, fetchImpl: okFetch({ standard_photo: 'P1' }, calls) });
    assert.ok(calls[0].url.endsWith('/rest/v1/rpc/jg_get_wave_map'));
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { p_token: 'secret-token' });
    assert.deepStrictEqual(got, { standard_photo: 'P1' });
    await backend.setWaveMap({ custom_item: 'PC' }, { env: ENV, fetchImpl: okFetch({}, calls) });
    assert.ok(calls[1].url.endsWith('/rest/v1/rpc/jg_set_wave_map'));
    assert.deepStrictEqual(JSON.parse(calls[1].opts.body), { p_token: 'secret-token', p_map: { custom_item: 'PC' } });
  });

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
    await backend.listRecentJobs(deps);
    await backend.upsertJob({ folder_name: 'F' }, deps);
    await backend.deleteDraft('F', deps);
    const names = calls.map((c) => c.url.split('/').pop());
    assert.deepStrictEqual(names, ['jg_list_jobs', 'jg_list_jobs', 'jg_upsert_job', 'jg_delete_draft']);
    assert.strictEqual(JSON.parse(calls[0].opts.body).p_kind, 'drafts');
    // 'recent' now means "not completed", no time window -- no p_since sent at all.
    assert.strictEqual(JSON.parse(calls[1].opts.body).p_kind, 'recent');
    assert.strictEqual('p_since' in JSON.parse(calls[1].opts.body), false);
    assert.deepStrictEqual(JSON.parse(calls[2].opts.body).p_row, { folder_name: 'F' });
  });

  await test('completeJob: calls jg_complete_job with the folder name', async () => {
    const calls = [];
    await backend.completeJob('2026.9.9 12 Test Ave_Jane', { env: ENV, fetchImpl: okFetch({ folder_name: 'x' }, calls) });
    assert.ok(calls[0].url.endsWith('/jg_complete_job'));
    assert.strictEqual(JSON.parse(calls[0].opts.body).p_folder_name, '2026.9.9 12 Test Ave_Jane');
  });

  await test('completeJob: "not found" errors (legacy local-only job never synced) are flagged notFound', async () => {
    const f = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'jg: job not found or not a real job' }) });
    await assert.rejects(
      backend.completeJob('F', { env: ENV, fetchImpl: f }),
      (e) => e.name === 'BackendError' && e.notFound === true);
  });

  await test('getGalleryToken: calls jg_gallery_token with the machine token + job id, returns the string (or null)', async () => {
    const calls = [];
    const f = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => '"8779efe254f329f0766d73328550ae62"' }; };
    const t = await backend.getGalleryToken('FVS-20260924-001', { env: ENV, fetchImpl: f });
    assert.strictEqual(t, '8779efe254f329f0766d73328550ae62');
    assert.strictEqual(calls[0].url, 'https://x.supabase.co/rest/v1/rpc/jg_gallery_token');
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { p_token: 'secret-token', p_job_id: 'FVS-20260924-001' });
    const none = await backend.getGalleryToken('F', { env: ENV, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'null' }) });
    assert.strictEqual(none, null);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
