'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaveClient } = require('./wave-client');

const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const mk = (responses) => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(JSON.parse(opts.body)); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  return { calls, client: createWaveClient({ token: 't', businessId: 'B', fetchImpl, sleep: async () => {} }) };
};
const inv = { id: 'I', status: 'DRAFT', invoiceNumber: '9', viewUrl: 'u', total: { value: '1.13' }, amountDue: { value: '1.13' } };

test('createDraftInvoice shapes the result', async () => {
  const { client, calls } = mk([resp(200, { data: { invoiceCreate: { didSucceed: true, inputErrors: null, invoice: inv } } })]);
  const out = await client.createDraftInvoice({ businessId: 'B', items: [] });
  assert.deepEqual(out, { id: 'I', status: 'DRAFT', invoiceNumber: '9', viewUrl: 'u', totalDecimal: '1.13', amountDueDecimal: '1.13' });
  assert.deepEqual(calls[0].variables.i, { businessId: 'B', items: [] });
});

test('patchInvoice sends id + fields, shapes the result; refuses businessId or status in fields', async () => {
  const { client, calls } = mk([resp(200, { data: { invoicePatch: { didSucceed: true, inputErrors: null, invoice: inv } } })]);
  const out = await client.patchInvoice('I', { items: [{ productId: 'P', quantity: 1, unitPrice: '1.00' }], poNumber: 'FVS-1' });
  assert.equal(out.id, 'I');
  assert.deepEqual(calls[0].variables.i, { id: 'I', items: [{ productId: 'P', quantity: 1, unitPrice: '1.00' }], poNumber: 'FVS-1' });
  await assert.rejects(() => client.patchInvoice('I', { businessId: 'B' }), /must not include businessId/);
  await assert.rejects(() => client.patchInvoice('I', { status: 'DRAFT' }), /never changes status/);
});

test('rejects an invoice input built for a different business', async () => {
  const { client } = mk([]);
  await assert.rejects(() => client.createDraftInvoice({ businessId: 'OTHER' }), /does not match/);
});

test('didSucceed=false surfaces inputErrors', async () => {
  const { client } = mk([resp(200, { data: { invoiceApprove: { didSucceed: false, inputErrors: [{ message: 'nope' }] } } })]);
  await assert.rejects(() => client.approveInvoice('I'), /invoiceApprove failed.*nope/);
});

test('reads retry on 429/5xx/network; mutations retry only on 429', async () => {
  let s = mk([resp(500, {}), new Error('boom'), resp(200, { data: { business: { invoice: inv } } })]);
  assert.equal((await s.client.getInvoice('I')).id, 'I');
  assert.equal(s.calls.length, 3);

  s = mk([resp(429, {}), resp(200, { data: { invoiceApprove: { didSucceed: true, invoice: inv } } })]);
  assert.equal((await s.client.approveInvoice('I')).status, 'DRAFT');
  assert.equal(s.calls.length, 2);

  s = mk([resp(500, {})]);
  await assert.rejects(() => s.client.approveInvoice('I'), (e) => e.outcomeUnknown === true);
  assert.equal(s.calls.length, 1);

  s = mk([new Error('reset')]);
  await assert.rejects(() => s.client.createDraftInvoice({ businessId: 'B' }), /network error/);
  assert.equal(s.calls.length, 1);
});

test('GraphQL errors are not retried', async () => {
  const s = mk([resp(200, { errors: [{ message: 'bad field' }] })]);
  await assert.rejects(() => s.client.getInvoice('I'), /bad field/);
  assert.equal(s.calls.length, 1);
});

test('findHstTaxId requires exactly one HST tax', async () => {
  let s = mk([resp(200, { data: { business: { salesTaxes: { edges: [{ node: { id: 'T', name: 'HST', rate: '0.13' } }, { node: { id: 'X', name: 'GST' } }] } } } })]);
  assert.equal(await s.client.findHstTaxId(), 'T');
  s = mk([resp(200, { data: { business: { salesTaxes: { edges: [] } } } })]);
  await assert.rejects(() => s.client.findHstTaxId(), /found 0/);
});

// ensureProduct (per-name product creation for custom items) was tried and reverted 2026-09-23 --
// custom items now always use the generic 'custom_item'/'adjustment_discount' product (see
// invoice-request.js); no code here calls listProducts()/productCreate for that purpose any more.
