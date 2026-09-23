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

  await test('buildAndSubmitInvoice: create mode builds the request and calls createDraftInvoice', async () => {
    backend._resetCachesForTests();
    const mapPath = writeProductMap({ standard_photo: 'P1', adjustment_discount: 'PD', custom_item: 'PC' });
    let created = null;
    const client = {
      findHstTaxId: async () => 'TAX1',
      createDraftInvoice: async (req) => { created = req; return { id: 'INV1', status: 'DRAFT', viewUrl: 'https://x', invoiceNumber: '1' }; },
    };
    const pricing = { status: 'ok', lineItems: [{ id: 'standard_photo', type: 'base', label: 'Standard Photography', amountCents: 9800 }], manualAdjustmentCents: 0 };
    const out = await backend.buildAndSubmitInvoice(
      { mode: 'create', pricing, customerId: 'CUST1', address: '1 Main St', jobId: 'FVS-1', invoiceDate: '2026-09-23' },
      { env: { ...ENV, WAVE_PRODUCT_MAP_PATH: mapPath }, client },
    );
    assert.strictEqual(out.id, 'INV1');
    assert.strictEqual(created.customerId, 'CUST1');
    assert.strictEqual(created.poNumber, 'FVS-1');
    assert.strictEqual(created.items[0].productId, 'P1');
  });

  await test('buildAndSubmitInvoice: patch mode strips businessId/status/invoiceDate and calls patchInvoice', async () => {
    backend._resetCachesForTests();
    const mapPath = writeProductMap({ standard_photo: 'P1', adjustment_discount: 'PD', custom_item: 'PC' });
    let patchedId = null, patchedFields = null;
    const client = {
      findHstTaxId: async () => 'TAX1',
      patchInvoice: async (id, fields) => { patchedId = id; patchedFields = fields; return { id, status: 'DRAFT' }; },
    };
    const pricing = { status: 'ok', lineItems: [{ id: 'standard_photo', type: 'base', label: 'Standard Photography', amountCents: 9800 }], manualAdjustmentCents: 0 };
    await backend.buildAndSubmitInvoice(
      { mode: 'patch', invoiceId: 'INV1', currentStatus: 'DRAFT', pricing, customerId: 'CUST1', address: '1 Main St', jobId: 'FVS-1' },
      { env: { ...ENV, WAVE_PRODUCT_MAP_PATH: mapPath }, client },
    );
    assert.strictEqual(patchedId, 'INV1');
    assert.strictEqual('businessId' in patchedFields, false);
    assert.strictEqual('status' in patchedFields, false);
    assert.strictEqual('invoiceDate' in patchedFields, false);
    assert.strictEqual(patchedFields.poNumber, 'FVS-1');
  });

  await test('buildAndSubmitInvoice: patch mode refuses when currentStatus is not DRAFT (never silently rewrites an approved/sent invoice)', async () => {
    backend._resetCachesForTests();
    const mapPath = writeProductMap({ standard_photo: 'P1' });
    const client = { findHstTaxId: async () => 'TAX1', patchInvoice: async () => { throw new Error('must not be called'); } };
    const pricing = { status: 'ok', lineItems: [{ id: 'standard_photo', type: 'base', label: 'x', amountCents: 9800 }], manualAdjustmentCents: 0 };
    await assert.rejects(
      backend.buildAndSubmitInvoice({ mode: 'patch', invoiceId: 'INV1', currentStatus: 'SAVED', pricing, customerId: 'C' }, { env: { ...ENV, WAVE_PRODUCT_MAP_PATH: mapPath }, client }),
      /not DRAFT/,
    );
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
