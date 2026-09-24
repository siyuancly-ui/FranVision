// FranVision Job Generator -- optional Wave integration.
//
// Thin glue between server.js and the shared ../wave-invoicing/ library (invoice-request.js's pure
// request builder + wave-client.js's GraphQL client). Optional, same "unconfigured = behaves as
// before" contract job-backend.js uses for the shared job server: with WAVE_TOKEN/WAVE_BUSINESS_ID
// unset, isConfigured() is false and every caller in server.js skips Wave entirely.
//
// What this owns that the shared library doesn't:
//   - reading WAVE_* env vars + the local product-id map (wave-product-map.json, gitignored --
//     see wave-product-map.example.json; built by wave-probe/setup-real-products.js in the
//     core-schema branch, see its CLAUDE.md)
//   - an in-memory cache of Wave's customer list (Wave has no server-side name search -- see the
//     2026-09-23 introspection in project history -- so the picker fetches the full list, small,
//     ~300 rows, and searches client-side/here) and of the HST tax id (rarely changes)
//   - turning a job's pricing + selected customer into a create-or-patch call, honoring the
//     "never silently touch an invoice that's already past DRAFT" rule (server.js decides whether
//     to call patch at all, based on the job's saved wave.status; this module just refuses if asked
//     to patch with a non-DRAFT status recorded, as a second guard)

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const { createWaveClient } = require(path.join(__dirname, '..', 'wave-invoicing', 'wave-client.js'));
const { buildInvoiceRequest } = require(path.join(__dirname, '..', 'wave-invoicing', 'invoice-request.js'));

const CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000; // Wave's customer list changes rarely; avoid refetching every keystroke
const MAX_SEARCH_RESULTS = 20;
// Wave can't delete a customer that has invoices, so duplicates are marked in Wave by renaming them
// with this prefix (2026-09-23 cleanup, scripts/wave-customer-dedupe.js) and hidden from the picker here.
const DUPLICATE_PREFIX = '[重复]';

function config(env) {
  env = env || process.env;
  return {
    token: env.WAVE_TOKEN || '',
    businessId: env.WAVE_BUSINESS_ID || '',
    autoInvoice: /^(1|true)$/i.test(env.WAVE_AUTO_INVOICE || ''),
    productMapPath: env.WAVE_PRODUCT_MAP_PATH || path.join(__dirname, 'wave-product-map.json'),
  };
}

// Token + business id present -- enough to show the customer picker and search customers.
// Does NOT check the product map (see canBuildInvoices) so the picker still works even before
// that file exists.
function isConfigured(env) {
  const c = config(env);
  return !!(c.token && c.businessId);
}

function loadProductMap(env) {
  const c = config(env);
  const raw = fs.readFileSync(c.productMapPath, 'utf8'); // throws with a clear ENOENT if missing -- caller decides how to report it
  const map = JSON.parse(raw);
  if (!map || typeof map !== 'object') throw new Error('wave-product-map.json did not parse to an object');
  return map;
}

// Configured AND the product map file is readable -- everything buildAndSubmitInvoice needs.
function canBuildInvoices(env) {
  if (!isConfigured(env)) return false;
  try { loadProductMap(env); return true; } catch (err) { return false; }
}

let cachedClient = null, cachedClientKey = null;
function getClient(deps) {
  deps = deps || {};
  if (deps.client) return deps.client; // test seam
  const c = config(deps.env);
  if (!c.token || !c.businessId) throw new Error('Wave is not configured (WAVE_TOKEN / WAVE_BUSINESS_ID missing).');
  const key = c.token + '|' + c.businessId;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = createWaveClient({ token: c.token, businessId: c.businessId, fetchImpl: deps.fetchImpl });
    cachedClientKey = key;
  }
  return cachedClient;
}

let customerCache = null; // { at: number, rows: [{id,name,email}] }
let taxIdCache = null; // string

async function listAllCustomers(deps) {
  deps = deps || {};
  const now = deps.now ? deps.now() : Date.now();
  if (customerCache && now - customerCache.at < CUSTOMER_CACHE_TTL_MS) return customerCache.rows;
  const client = getClient(deps);
  const businessId = config(deps.env).businessId;
  const rows = [];
  for (let page = 1; ; page++) {
    const d = await client.gql(
      'query($b:ID!,$p:Int!){ business(id:$b){ customers(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ id name email } } } } }',
      { b: businessId, p: page },
    );
    const c = d.business.customers;
    c.edges.forEach((e) => {
      if (String(e.node.name || '').trim().startsWith(DUPLICATE_PREFIX)) return;
      rows.push({ id: e.node.id, name: e.node.name, email: e.node.email || '' });
    });
    if (page >= c.pageInfo.totalPages) break;
  }
  customerCache = { at: now, rows };
  return rows;
}

// Wave's Business.customers has no free-text name search (only exact `email`) -- fetch/cache the
// whole list and filter here. Case-insensitive substring on name or email; rows whose name STARTS
// WITH the query sort first (more likely what you're looking for), then the rest alphabetically.
async function searchCustomers(query, deps) {
  const rows = await listAllCustomers(deps);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SEARCH_RESULTS);
  const matches = rows.filter((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q));
  matches.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(q), bStarts = b.name.toLowerCase().startsWith(q);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return matches.slice(0, MAX_SEARCH_RESULTS);
}

async function getHstTaxId(deps) {
  if (taxIdCache) return taxIdCache;
  taxIdCache = await getClient(deps).findHstTaxId();
  return taxIdCache;
}

// Builds an invoice request from a job's pricing + selection and either creates a new DRAFT or
// patches an existing one. `mode: 'patch'` requires `invoiceId` and `currentStatus` (the status
// last saved in job.json) -- refuses (throws, caller catches) if currentStatus isn't 'DRAFT', so
// an approved/sent/paid invoice is never silently rewritten; the caller (server.js) is expected to
// check this BEFORE calling, this is a second guard, not the only one.
async function buildAndSubmitInvoice(args, deps) {
  deps = deps || {};
  const c = config(deps.env);
  if (!c.token || !c.businessId) throw new Error('Wave is not configured.');
  const productMap = loadProductMap(deps.env);
  const client = getClient(deps);
  const taxId = await getHstTaxId(deps);

  const request = buildInvoiceRequest({
    pricing: args.pricing,
    businessId: c.businessId,
    customerId: args.customerId,
    taxId,
    productMap,
    address: args.address || '',
    invoiceDate: args.invoiceDate || new Date().toISOString().slice(0, 10),
    jobId: args.jobId,
    customItems: args.customItems,
    adjustmentLabel: args.adjustmentLabel,
  });

  if (args.mode === 'patch') {
    if (!args.invoiceId) throw new Error('patch mode needs invoiceId');
    if (args.currentStatus !== 'DRAFT') throw new Error('refusing to patch a Wave invoice that is not DRAFT any more (status: ' + args.currentStatus + ')');
    const { businessId, status, invoiceDate, ...patchFields } = request; // InvoicePatchInput has neither; status is never patched (see wave-client.js)
    return client.patchInvoice(args.invoiceId, patchFields);
  }
  return client.createDraftInvoice(request);
}

function _resetCachesForTests() {
  cachedClient = null; cachedClientKey = null; customerCache = null; taxIdCache = null;
}

module.exports = {
  config, isConfigured, canBuildInvoices, loadProductMap,
  listAllCustomers, searchCustomers, getHstTaxId, buildAndSubmitInvoice,
  _resetCachesForTests,
};
