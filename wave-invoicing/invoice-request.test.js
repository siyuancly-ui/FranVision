'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInvoiceRequest, compareTotals, centsToDecimal, addDays } = require('./invoice-request');

const productMap = { standard_photo: 'P1', floor_plan: 'P2', virtual_staging: 'P3', standard_floorplan: 'P4', adjustment_discount: 'PD', custom_item: 'PC' };
const base = { businessId: 'B', customerId: 'C', taxId: 'T', productMap, address: '1 Main St, Toronto', invoiceDate: '2026-09-21' };
const pricing = (lineItems, adj = 0) => ({ status: 'ok', lineItems, manualAdjustmentCents: adj });
const li = (id, amountCents, label = id) => ({ type: 'addon', id, label, amountCents });

test('centsToDecimal / addDays', () => {
  assert.equal(centsToDecimal(9800), '98.00');
  assert.equal(centsToDecimal(5), '0.05');
  assert.equal(centsToDecimal(-9900), '-99.00');
  assert.equal(addDays('2026-09-21', 30), '2026-10-21');
  assert.equal(addDays('2026-12-15', 30), '2027-01-14');
});

test('one line per pricing line, address on the first line only, HST on each, DRAFT, due on receipt', () => {
  const r = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_floorplan', 16900), li('virtual_staging', 3000, 'Virtual Staging ×3')]) });
  assert.equal(r.status, 'DRAFT');
  assert.equal(r.dueDate, '2026-09-21');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0], { productId: 'P4', description: '1 Main St, Toronto', quantity: 1, unitPrice: '169.00', taxes: [{ salesTaxId: 'T' }] });
  assert.equal(r.items[1].description, '×3');
  assert.equal(r.items[1].unitPrice, '30.00');
  assert.equal('invoiceNumber' in r, false);
});

test('monthly billing: explicit dueDate or dueDays override the due-on-receipt default', () => {
  const p = pricing([li('standard_photo', 9800)]);
  assert.equal(buildInvoiceRequest({ ...base, pricing: p, dueDate: '2026-09-30' }).dueDate, '2026-09-30');
  assert.equal(buildInvoiceRequest({ ...base, pricing: p, dueDays: 30 }).dueDate, '2026-10-21');
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: p, dueDate: 'Sept 30' }), /dueDate/);
});

test('negative manual adjustment -> discount product; positive -> charge product with its label (e.g. Road Fee)', () => {
  const d = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], -1000) });
  assert.equal(d.items[1].productId, 'PD');
  assert.equal(d.items[1].unitPrice, '-10.00');
  // 2026-09-23: a positive un-itemized adjustment is folded into the first line, not listed separately
  const c = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800), li('floor_plan', 3000)], 4500) });
  assert.equal(c.items.length, 2);
  assert.equal(c.items[0].unitPrice, '143.00');
  assert.equal(c.items[1].unitPrice, '30.00');
  assert.equal(c.items[0].description, '1 Main St, Toronto');
});

test('customItems: named lines; a positive remainder folds into the first line, a negative one becomes a Discount line', () => {
  const p = pricing([li('standard_photo', 9800)], 6500);
  const r = buildInvoiceRequest({ ...base, pricing: p, customItems: [{ name: 'Road Fee', amountCents: 4500 }, { name: 'Rush delivery', amountCents: 2000 }] });
  assert.deepEqual(r.items.slice(1).map((i) => [i.productId, i.description, i.unitPrice]), [['PC', 'Road Fee', '45.00'], ['PC', 'Rush delivery', '20.00']]);
  assert.equal(r.items[0].unitPrice, '98.00'); // no remainder here -> first line untouched
  // remainder +10 on top of a named custom item -> first line absorbs it
  const f = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], 5500), customItems: [{ name: 'Road Fee', amountCents: 4500 }] });
  assert.deepEqual(f.items.map((i) => i.unitPrice), ['108.00', '45.00']);
  // Road Fee 45 on top of an exact-price override that lowered the package by 10 -> adjustment 35
  const q = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], 3500), customItems: [{ name: 'Road Fee', amountCents: 4500 }] });
  assert.deepEqual(q.items.slice(1).map((i) => [i.productId, i.description, i.unitPrice]), [['PC', 'Road Fee', '45.00'], ['PD', 'Discount', '-10.00']]);
  // invoice lines always add up to the engine's final subtotal
  const sum = (r) => r.items.reduce((t, i) => t + Math.round(Number(i.unitPrice) * 100), 0);
  assert.equal(sum(r), 9800 + 6500);
  assert.equal(sum(q), 9800 + 3500);
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], 100), customItems: [{ name: ' ', amountCents: 100 }] }), /needs a name/);
  const mixed = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], 3500), customItems: [{ name: 'Road Fee', amountCents: 4500 }, { name: 'Loyalty discount', amountCents: -1000 }] });
  assert.deepEqual(mixed.items.slice(1).map((i) => i.productId), ['PC', 'PD']);
});

test('missing product mapping throws and lists every missing id', () => {
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: pricing([li('drone_photos', 5000), li('three_d_tour', 8000)]) }), /drone_photos, three_d_tour/);
  assert.throws(() => buildInvoiceRequest({ ...base, productMap: { standard_photo: 'P1' }, pricing: pricing([li('standard_photo', 9800)], 100), customItems: [{ name: 'Road Fee', amountCents: 100 }] }), /custom_item/);
});

test('refuses non-ok / lineless pricing and missing required fields', () => {
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: { status: 'ambiguous', candidates: [] } }), /no lineItems/);
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: { status: 'invalid', lineItems: [] } }), /not ok/);
  assert.throws(() => buildInvoiceRequest({ ...base, customerId: '', pricing: pricing([li('standard_photo', 9800)]) }), /customerId/);
  assert.throws(() => buildInvoiceRequest({ ...base, invoiceDate: '09/21/2026', pricing: pricing([li('standard_photo', 9800)]) }), /YYYY-MM-DD/);
  assert.throws(() => buildInvoiceRequest({ ...base, pricing: pricing([]) }), /no lines/);
});

test('optional invoiceNumber and memo pass through', () => {
  const r = buildInvoiceRequest({ ...base, invoiceNumber: '360101-2077-9', memo: 'FVS-1', pricing: pricing([li('standard_photo', 9800)]) });
  assert.equal(r.invoiceNumber, '360101-2077-9');
  assert.equal(r.memo, 'FVS-1');
});

test('custom items always use the generic Other product, name in the description (2026-09-23 decision, no per-name product)', () => {
  const r = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], 6500), customItems: [{ name: 'Road  Fee', amountCents: 4500 }, { name: 'Rush', amountCents: 2000 }] });
  assert.deepEqual(r.items.slice(1).map((i) => [i.productId, i.description]), [['PC', 'Road Fee'], ['PC', 'Rush']]);
});

test('positive remainder with no pricing lines at all falls back to its own line (nothing to fold into)', () => {
  const r = buildInvoiceRequest({ ...base, pricing: pricing([], 2000) });
  assert.deepEqual(r.items.map((i) => [i.productId, i.unitPrice]), [['PC', '20.00']]);
});

test('negative remainder is labelled Discount; taxId may only be omitted with allowNoTax', () => {
  const r = buildInvoiceRequest({ ...base, pricing: pricing([li('standard_photo', 9800)], -1000) });
  assert.deepEqual([r.items[1].productId, r.items[1].description, r.items[1].unitPrice], ['PD', 'Discount', '-10.00']);
  assert.throws(() => buildInvoiceRequest({ ...base, taxId: '', pricing: pricing([li('standard_photo', 9800)]) }), /taxId/);
  const n = buildInvoiceRequest({ ...base, taxId: '', allowNoTax: true, pricing: pricing([li('standard_photo', 9800)]) });
  assert.equal('taxes' in n.items[0], false);
});

test('jobId goes to poNumber, never to invoiceNumber', () => {
  const r = buildInvoiceRequest({ ...base, jobId: 'FVS-20260921-001', pricing: pricing([li('standard_photo', 9800)]) });
  assert.equal(r.poNumber, 'FVS-20260921-001');
  assert.equal('invoiceNumber' in r, false);
});

test('Wave amounts with thousands separators parse correctly', () => {
  const { parseWaveMoneyToCents } = require('./invoice-request');
  assert.equal(parseWaveMoneyToCents('1,695.00'), 169500);
  assert.equal(parseWaveMoneyToCents('98.00'), 9800);
  assert.equal(compareTotals(169500, '1,695.00').diffCents, 0);
  assert.throws(() => parseWaveMoneyToCents('abc'), /cannot parse/);
});

test('compareTotals: cent-level rounding is NOT suspicious, a wrong line is', () => {
  assert.equal(compareTotals(11074, '110.75').suspicious, false);
  assert.equal(compareTotals(11074, '110.75').diffCents, 1);
  assert.equal(compareTotals(11074, '160.75').suspicious, true);
});

test('works against the real pricing engine output (package + add-on + manual adjustment)', () => {
  const engine = require('../pricing/engine.js');
  const config = require('../pricing/pricing-config.js');
  const res = engine.calculatePrice({ propertyType: 'condo', photography: 'standard', addons: { floor_plan: true, drone_photos: true }, manualAdjustmentCents: -500 }, config);
  assert.equal(res.status, 'ok');
  const map = { standard_floorplan: 'P4', drone_photos: 'PDR', adjustment_discount: 'PD' };
  const r = buildInvoiceRequest({ ...base, pricing: res, productMap: map });
  assert.equal(r.items.length, res.lineItems.length + 1);
  const wave = r.items.reduce((sum, it) => sum + Math.round(Number(it.unitPrice) * 100), 0);
  assert.equal(wave, res.finalSubtotalCents); // lines sum to the engine's pre-tax subtotal
});
