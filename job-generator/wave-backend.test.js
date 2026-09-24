const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backend = require('./wave-backend.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failed++; console.log('  FAIL  ' + name); console.log('        ' + (err && err.stack || err)); }
}

const ENV = { WAVE_TOKEN: 't', WAVE_BUSINESS_ID: 'B' };
const resp = (body) => ({ status: 200, ok: true, json: async () => body });
const gqlFetch = (handlers) => async (url, opts) => {
  const body = JSON.parse(opts.body);
  const h = handlers.shift();
  if (!h) throw new Error('unexpected extra GraphQL call: ' + body.query.slice(0, 60));
  return h(body);
};

function writeProductMap(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wave-map-')), 'map.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

(async () => {
  await test('isConfigured: needs both token and business id; canBuildInvoices also needs a readable product map', () => {
    assert.strictEqual(backend.isConfigured({}), false);
    assert.strictEqual(backend.isConfigured({ WAVE_TOKEN: 't' }), false);
    assert.strictEqual(backend.isConfigured(ENV), true);
    // Explicit nonexistent path -- NOT relying on the default (job-generator/wave-product-map.json)
    // being absent, since a real dev setup legitimately has that file in place.
    assert.strictEqual(backend.canBuildInvoices({ ...ENV, WAVE_PRODUCT_MAP_PATH: '/does/not/exist-' + Date.now() + '.json' }), false);
    const mapPath = writeProductMap({ standard_photo: 'P1' });
    assert.strictEqual(backend.canBuildInvoices({ ...ENV, WAVE_PRODUCT_MAP_PATH: mapPath }), true);
  });

  await test('loadProductMap: parses the file; throws a clear error when missing or not an object', () => {
    const mapPath = writeProductMap({ standard_photo: 'P1' });
    assert.deepStrictEqual(backend.loadProductMap({ WAVE_PRODUCT_MAP_PATH: mapPath }), { standard_photo: 'P1' });
    assert.throws(() => backend.loadProductMap({ WAVE_PRODUCT_MAP_PATH: '/does/not/exist.json' }), /ENOENT/);
    const badPath = writeProductMap('not-an-object'); // valid JSON, wrong shape
    assert.throws(() => backend.loadProductMap({ WAVE_PRODUCT_MAP_PATH: badPath }), /did not parse to an object/);
  });

  await test('searchCustomers: case-insensitive substring on name/email, name-starts-with sorts first, capped, cached across calls', async () => {
    backend._resetCachesForTests();
    let now = 1000;
    const calls = [];
    const fetchImpl = gqlFetch([
      (b) => { calls.push(b); return resp({ data: { business: { customers: { pageInfo: { totalPages: 1 }, edges: [
        { node: { id: '1', name: 'Yinan Xia', email: 'yinan@x.com' } },
        { node: { id: '2', name: 'Monica Mac', email: 'monica@x.com' } },
        { node: { id: '3', name: 'iancy Realty', email: '' } },
      ] } } } }); },
    ]);
    const deps = { env: ENV, fetchImpl, now: () => now };
    const r1 = await backend.searchCustomers('ian', deps);
    // only 'iancy Realty' actually contains the substring 'ian' -- 'Yinan' has i/n/a/n but not consecutively
    assert.deepStrictEqual(r1.map((c) => c.id), ['3']);
    const r1b = await backend.searchCustomers('an', deps); // contained in both 'Yinan Xia' and 'iancy Realty'; neither starts with it
    assert.deepStrictEqual(r1b.map((c) => c.id).sort(), ['1', '3']);
    // second call within the TTL must NOT refetch
    now += 1000;
    const r2 = await backend.searchCustomers('monica', deps);
    assert.deepStrictEqual(r2.map((c) => c.id), ['2']);
    assert.strictEqual(calls.length, 1);
  });

  await test('searchCustomers: cache expires after the TTL and refetches', async () => {
    backend._resetCachesForTests();
    let now = 0;
    const calls = [];
    const page = (rows) => (b) => { calls.push(b); return resp({ data: { business: { customers: { pageInfo: { totalPages: 1 }, edges: rows.map((n) => ({ node: n })) } } } }); };
    const fetchImpl = gqlFetch([page([{ id: '1', name: 'A', email: '' }]), page([{ id: '1', name: 'A', email: '' }])]);
    const deps = { env: ENV, fetchImpl, now: () => now };
    await backend.searchCustomers('', deps);
    now += 6 * 60 * 1000; // past the 5-minute TTL
    await backend.searchCustomers('', deps);
    assert.strictEqual(calls.length, 2);
  });

  await test('searchCustomers: empty query returns everything, alphabetical, capped at 20', async () => {
    backend._resetCachesForTests();
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: String(i), name: 'Z' + String(i).padStart(2, '0'), email: '' }));
    const fetchImpl = gqlFetch([(b) => resp({ data: { business: { customers: { pageInfo: { totalPages: 1 }, edges: rows.map((n) => ({ node: n })) } } } })]);
    const out = await backend.searchCustomers('', { env: ENV, fetchImpl, now: () => 0 });
    assert.strictEqual(out.length, 20);
    assert.strictEqual(out[0].name, 'Z00');
  });

  await test('listAllCustomers: follows pagination (totalPages > 1)', async () => {
    backend._resetCachesForTests();
    const fetchImpl = gqlFetch([
      (b) => { assert.strictEqual(b.variables.p, 1); return resp({ data: { business: { customers: { pageInfo: { totalPages: 2 }, edges: [{ node: { id: '1', name: 'A', email: '' } }] } } } }); },
      (b) => { assert.strictEqual(b.variables.p, 2); return resp({ data: { business: { customers: { pageInfo: { totalPages: 2 }, edges: [{ node: { id: '2', name: 'B', email: '' } }] } } } }); },
    ]);
    const rows = await backend.listAllCustomers({ env: ENV, fetchImpl, now: () => 0 });
    assert.deepStrictEqual(rows.map((r) => r.id), ['1', '2']);
  });

  await test('getHstTaxId: fetched once, cached for later calls', async () => {
    backend._resetCachesForTests();
    let calls = 0;
    const client = { findHstTaxId: async () => { calls++; return 'TAX1'; } };
    assert.strictEqual(await backend.getHstTaxId({ client }), 'TAX1');
    assert.strictEqual(await backend.getHstTaxId({ client }), 'TAX1');
    assert.strictEqual(calls, 1);
  });

  const PRICING = { status: 'ok', lineItems: [{ id: 'standard_photo', type: 'base', label: 'Standard Photography', amountCents: 9800 }], manualAdjustmentCents: 0 };
  const opts = (client) => ({ env: { ...ENV, WAVE_PRODUCT_MAP_PATH: writeProductMap({ standard_photo: 'P1', adjustment_discount: 'PD', custom_item: 'PC' }) }, client });

  await test('buildAndSubmitInvoice: create mode builds the request, creates the DRAFT and approves it straight away', async () => {
    backend._resetCachesForTests();
    let created = null, approvedId = null;
    const client = {
      findHstTaxId: async () => 'TAX1',
      createDraftInvoice: async (req) => { created = req; return { id: 'INV1', status: 'DRAFT', viewUrl: 'https://x', invoiceNumber: '1' }; },
      approveInvoice: async (id) => { approvedId = id; return { id, status: 'SAVED', viewUrl: 'https://x', invoiceNumber: '1' }; },
    };
    const out = await backend.buildAndSubmitInvoice({ mode: 'create', pricing: PRICING, customerId: 'CUST1', address: '1 Main St', jobId: 'FVS-1', invoiceDate: '2026-09-23' }, opts(client));
    assert.strictEqual(out.id, 'INV1');
    assert.strictEqual(out.status, 'SAVED');
    assert.strictEqual(approvedId, 'INV1');
    assert.strictEqual(created.customerId, 'CUST1');
    assert.strictEqual(created.poNumber, 'FVS-1');
    assert.strictEqual(created.items[0].productId, 'P1');
  });

  await test('buildAndSubmitInvoice: a failed approve keeps the DRAFT (returned with approveError) instead of throwing', async () => {
    backend._resetCachesForTests();
    const client = {
      findHstTaxId: async () => 'TAX1',
      createDraftInvoice: async () => ({ id: 'INV1', status: 'DRAFT' }),
      approveInvoice: async () => { throw new Error('approve boom'); },
    };
    const out = await backend.buildAndSubmitInvoice({ mode: 'create', pricing: PRICING, customerId: 'C' }, opts(client));
    assert.strictEqual(out.id, 'INV1');
    assert.strictEqual(out.status, 'DRAFT');
    assert.strictEqual(out.approveError, 'approve boom');
  });

  await test('buildAndSubmitInvoice: patching an APPROVED (SAVED) invoice works, strips businessId/status/invoiceDate, does not re-approve', async () => {
    backend._resetCachesForTests();
    let patchedId = null, patchedFields = null, approves = 0;
    const client = {
      findHstTaxId: async () => 'TAX1',
      getInvoice: async () => ({ id: 'INV1', status: 'SAVED' }),
      patchInvoice: async (id, fields) => { patchedId = id; patchedFields = fields; return { id, status: 'SAVED' }; },
      approveInvoice: async () => { approves++; },
    };
    const out = await backend.buildAndSubmitInvoice({ mode: 'patch', invoiceId: 'INV1', pricing: PRICING, customerId: 'CUST1', address: '1 Main St', jobId: 'FVS-1' }, opts(client));
    assert.strictEqual(out.status, 'SAVED');
    assert.strictEqual(patchedId, 'INV1');
    assert.strictEqual(approves, 0);
    assert.strictEqual('businessId' in patchedFields, false);
    assert.strictEqual('status' in patchedFields, false);
    assert.strictEqual('invoiceDate' in patchedFields, false);
    assert.strictEqual(patchedFields.poNumber, 'FVS-1');
  });

  await test('buildAndSubmitInvoice: patching a still-DRAFT invoice approves it afterwards', async () => {
    backend._resetCachesForTests();
    const client = {
      findHstTaxId: async () => 'TAX1',
      getInvoice: async () => ({ id: 'INV1', status: 'DRAFT' }),
      patchInvoice: async (id) => ({ id, status: 'DRAFT' }),
      approveInvoice: async (id) => ({ id, status: 'SAVED' }),
    };
    const out = await backend.buildAndSubmitInvoice({ mode: 'patch', invoiceId: 'INV1', pricing: PRICING, customerId: 'C' }, opts(client));
    assert.strictEqual(out.status, 'SAVED');
  });

  await test('buildAndSubmitInvoice: patch refuses a PAID or PARTIAL invoice (checked against the LIVE status in Wave)', async () => {
    for (const status of ['PAID', 'PARTIAL']) {
      backend._resetCachesForTests();
      const client = { findHstTaxId: async () => 'TAX1', getInvoice: async () => ({ id: 'INV1', status }), patchInvoice: async () => { throw new Error('must not be called'); } };
      await assert.rejects(backend.buildAndSubmitInvoice({ mode: 'patch', invoiceId: 'INV1', pricing: PRICING, customerId: 'C' }, opts(client)), new RegExp(status));
    }
  });

  await test('createCustomer: trims/validates, sends optional fields, and shows up in the cached list right away', async () => {
    backend._resetCachesForTests();
    const fetchImpl = gqlFetch([
      () => resp({ data: { business: { customers: { pageInfo: { totalPages: 1 }, edges: [{ node: { id: '1', name: 'Old One', email: '' } }] } } } }),
    ]);
    const deps = { env: ENV, fetchImpl, now: () => 0 };
    await backend.listAllCustomers(deps); // prime the cache
    let input = null;
    const client = { createCustomer: async (i) => { input = i; return { id: '2', name: i.name, email: i.email }; } };
    const row = await backend.createCustomer({ name: '  Jane   Smith ', email: ' j@x.com ', phone: '', address: '1 Main St' }, { ...deps, client });
    assert.deepStrictEqual(input, { name: 'Jane Smith', email: 'j@x.com', phone: '', address: '1 Main St' });
    assert.deepStrictEqual(row, { id: '2', name: 'Jane Smith', email: 'j@x.com' });
    assert.deepStrictEqual((await backend.listAllCustomers(deps)).map((r) => r.id), ['1', '2']); // cache hit, includes the new one
    await assert.rejects(backend.createCustomer({ name: '   ' }, { client }), /name is required/);
  });

  await test('buildAndSubmitInvoice: missing product mapping surfaces the underlying error (never silently drops a line)', async () => {
    backend._resetCachesForTests();
    const mapPath = writeProductMap({}); // empty -- standard_photo unmapped
    const client = { findHstTaxId: async () => 'TAX1' };
    const pricing = { status: 'ok', lineItems: [{ id: 'standard_photo', type: 'base', label: 'x', amountCents: 9800 }], manualAdjustmentCents: 0 };
    await assert.rejects(
      backend.buildAndSubmitInvoice({ mode: 'create', pricing, customerId: 'C' }, { env: { ...ENV, WAVE_PRODUCT_MAP_PATH: mapPath }, client }),
      /no Wave product mapped/,
    );
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
