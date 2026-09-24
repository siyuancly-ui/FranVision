'use strict';
// Pure function: pricing-engine result (+ job info) -> Wave `invoiceCreate` input. No network, no I/O.
//
// Mirrors how Franky invoices by hand (observed from his real invoices, 2026-09-21): one line per
// service/package, quantity 1, the property ADDRESS as the description of the FIRST line only,
// HST as a per-line tax, created as DRAFT. Due date defaults to the invoice date (pay before delivery;
// changed 2026-09-21 from his old +30d habit), overridable for monthly-billing customers.
//
// Never guesses: a line whose pricing id has no Wave product in `productMap` throws (listing every
// missing id) instead of silently picking a product.

// Default: due on receipt (Franky delivers originals only after payment). Monthly-billing customers pass
// dueDays (e.g. days until month end) or an explicit dueDate.
const DEFAULT_DUE_DAYS = 0;

function centsToDecimal(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The engine's virtual_staging label is "Virtual Staging ×N"; its lineItem has no separate qty field.
function qtyNote(label) {
  const m = /×\s*(\d+)\s*$/.exec(label || '');
  return m ? m[1] : null;
}

/**
 * @param {object} args
 * @param {object} args.pricing        engine result (status 'ok' shape: lineItems, manualAdjustmentCents, ...)
 * @param {string} args.businessId     Wave business id
 * @param {string} args.customerId     Wave customer id (the ordering agent)
 * @param {string} args.taxId          Wave HST sales-tax id (required; see allowNoTax)
 * @param {boolean} [args.allowNoTax]  sandbox-only opt-out for a business with no HST configured
 * @param {Object<string,string>} args.productMap  pricing id -> Wave product id. Special keys for the manual
 *                                     adjustment line: `adjustment_discount` (negative), `custom_item` (positive; the item's name goes in the line description).
 * @param {string} args.address        property address (description of the first line)
 * @param {string} args.invoiceDate    'YYYY-MM-DD'
 * @param {{name:string, amountCents:number}[]} [args.customItems]  free-form one-off lines (name in the description, generic 'custom_item'/'adjustment_discount' product); part of pricing.manualAdjustmentCents -- the rest: a positive remainder is folded into the FIRST line's price, a negative one becomes one 'Discount' line
 * @param {string} [args.adjustmentLabel]  label for the un-itemized remainder (default 'Price adjustment')
 * @param {string} [args.dueDate]      explicit 'YYYY-MM-DD' (monthly billing)
 * @param {number} [args.dueDays]      days after invoiceDate; ignored when dueDate is given (default 0 = due on receipt)
 * @param {string} [args.invoiceNumber]    leave undefined to let Wave assign the next number
 * @param {string} [args.memo]
 * @param {string} [args.jobId]         FVS job id; goes in Wave's P.O./S.O. field (poNumber), NOT invoiceNumber (keeps Franky's sequence)
 */
function buildInvoiceRequest(args) {
  const { pricing, businessId, customerId, taxId, productMap, address, invoiceDate } = args;
  if (!pricing || !Array.isArray(pricing.lineItems)) {
    throw new Error('pricing result has no lineItems (status ' + (pricing && pricing.status) + '); refusing to build an invoice');
  }
  if (pricing.status && pricing.status !== 'ok') throw new Error('pricing status is ' + pricing.status + ', not ok');
  for (const [k, v] of Object.entries({ businessId, customerId, invoiceDate })) {
    if (!v) throw new Error('missing ' + k);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new Error('invoiceDate must be YYYY-MM-DD');
  if (args.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)) throw new Error('dueDate must be YYYY-MM-DD');

  // taxId is required unless the caller explicitly opts out (only for a sandbox business that has no HST configured).
  if (!taxId && !args.allowNoTax) throw new Error('missing taxId');
  const taxes = taxId ? [{ salesTaxId: taxId }] : undefined;
  const items = [];
  const missing = [];
  const pricingLineCount = pricing.lineItems.length;

  const lookup = (key) => {
    const id = productMap && productMap[key];
    if (!id) missing.push(key);
    return id;
  };

  for (const li of pricing.lineItems) {
    const productId = lookup(li.id);
    const note = qtyNote(li.label);
    items.push({ productId, description: '', quantity: 1, unitPrice: centsToDecimal(li.amountCents), ...(taxes ? { taxes } : {}), _note: note });
  }

  // Manual adjustment = (override/adjust-field delta) + (sum of named custom items). The invoice shows each
  // named custom item as its own line; whatever remains is the un-named price adjustment (e.g. from the
  // "exact package price" mode), shown as one line. Lines therefore always add up to the engine's total
  // by construction, so there is nothing to mismatch.
  //
  // 2026-09-23 (user decision): custom items always use the generic 'custom_item' ('Other') product,
  // name in the line description -- NOT a product created on the fly named after the item. A per-name
  // product was tried (wave-client.js#ensureProduct existed for this) and reverted: for now, keep it
  // simple, revisit later if the Other-product list gets unwieldy.
  const adj = pricing.manualAdjustmentCents || 0;
  const customs = Array.isArray(args.customItems) ? args.customItems : [];
  for (const c of customs) {
    if (!c.name || !String(c.name).trim()) throw new Error('every custom item needs a name');
    if (!Number.isFinite(c.amountCents) || Math.round(c.amountCents) === 0) throw new Error('custom item "' + c.name + '" needs a non-zero amountCents');
    const cents = Math.round(c.amountCents);
    const cname = String(c.name).trim().replace(/\s+/g, ' ');
    const productId = lookup(cents < 0 ? 'adjustment_discount' : 'custom_item');
    items.push({ productId, description: cname, quantity: 1, unitPrice: centsToDecimal(cents), ...(taxes ? { taxes } : {}), _note: null });
  }
  const remainder = adj - customs.reduce((t, c) => t + Math.round(c.amountCents), 0);
  if (remainder > 0 && pricingLineCount > 0) {
    // 2026-09-23 (user decision): an un-itemized price INCREASE is folded into the first line's price
    // instead of getting its own "Price adjustment" line (the client just sees a slightly higher price
    // for the first service). A decrease still gets its own visible Discount line below.
    const first = items[0];
    first.unitPrice = centsToDecimal(Math.round(Number(first.unitPrice) * 100) + remainder);
  } else if (remainder !== 0) {
    const productId = lookup(remainder < 0 ? 'adjustment_discount' : 'custom_item');
    items.push({ productId, description: args.adjustmentLabel || (remainder < 0 ? 'Discount' : 'Price adjustment'), quantity: 1, unitPrice: centsToDecimal(remainder), ...(taxes ? { taxes } : {}), _note: null });
  }

  if (missing.length) throw new Error('no Wave product mapped for: ' + [...new Set(missing)].join(', '));
  if (!items.length) throw new Error('invoice would have no lines');

  // description: address on the first line only; a quantity note (e.g. staging photos) is appended.
  items.forEach((it, i) => {
    const parts = [];
    if (i === 0 && address) parts.push(address);
    if (it.description) parts.push(it.description);
    if (it._note) parts.push('×' + it._note);
    it.description = parts.join(' | ');
    delete it._note;
  });

  const input = {
    businessId,
    customerId,
    status: 'DRAFT',
    invoiceDate,
    dueDate: args.dueDate || addDays(invoiceDate, args.dueDays == null ? DEFAULT_DUE_DAYS : args.dueDays),
    items,
  };
  if (args.invoiceNumber) input.invoiceNumber = args.invoiceNumber;
  if (args.memo) input.memo = args.memo;
  if (args.jobId) input.poNumber = args.jobId;
  return input;
}

// Sanity guard, NOT a rounding check (user decision 2026-09-21: cent-level HST differences between
// Wave's per-line rounding and the engine's single rounding need no human review). Flags only a
// difference big enough to mean a wrong product/price/line.
// Wave returns money as strings WITH thousands separators ("1,695.00"), so strip commas before parsing.
function parseWaveMoneyToCents(v) {
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error('cannot parse Wave amount: ' + v);
  return Math.round(n * 100);
}

function compareTotals(engineTotalCents, waveTotalDecimal, toleranceCents = 100) {
  const waveCents = parseWaveMoneyToCents(waveTotalDecimal);
  const diff = waveCents - engineTotalCents;
  return { engineTotalCents, waveTotalCents: waveCents, diffCents: diff, suspicious: Math.abs(diff) > toleranceCents };
}

module.exports = { buildInvoiceRequest, compareTotals, parseWaveMoneyToCents, centsToDecimal, addDays, DEFAULT_DUE_DAYS };
