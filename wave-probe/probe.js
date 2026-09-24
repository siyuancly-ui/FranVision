// READ-ONLY probe of Wave's GraphQL API. Verifies the token works and shows
// the data invoice automation depends on: businesses, customers (with
// emails), products, sales taxes, and the fields of the invoiceCreate input.
// Makes NO writes. Never prints the token.
//   cd wave-probe && cp .env.example .env   # put the token in .env
//   node probe.js
const fs = require('fs');
const path = require('path');

function loadToken() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) throw new Error('wave-probe/.env not found (copy .env.example)');
  const line = fs.readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN='));
  const t = line && line.slice('WAVE_TOKEN='.length).trim();
  if (!t) throw new Error('WAVE_TOKEN is empty in wave-probe/.env');
  return t;
}

const ENDPOINT = 'https://gql.waveapps.com/graphql/public';
const TOKEN = loadToken();

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = (body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.data;
}

async function step(title, fn) {
  console.log(`\n=== ${title} ===`);
  try { await fn(); } catch (e) { console.log('FAILED:', e.message); }
}

(async () => {
  let businessId = null;

  await step('1. Token works / businesses', async () => {
    const d = await gql('{ businesses(page:1, pageSize:20) { edges { node { id name isPersonal currency { code } } } } }');
    const list = d.businesses.edges.map((e) => e.node);
    list.forEach((b) => console.log(`- ${b.name}  [${b.currency.code}]  personal=${b.isPersonal}  id=${b.id}`));
    const pick = list.find((b) => !b.isPersonal) || list[0];
    businessId = pick && pick.id;
    console.log('using business:', pick && pick.name);
  });
  if (!businessId) return;

  await step('2. Customers (first 10 + total)', async () => {
    const d = await gql(
      'query($b:ID!){ business(id:$b){ customers(page:1,pageSize:10){ pageInfo{ totalCount totalPages } edges{ node{ id name email firstName lastName phone } } } } }',
      { b: businessId });
    const c = d.business.customers;
    console.log('total customers:', c.pageInfo.totalCount);
    c.edges.forEach((e) => console.log(`- ${e.node.name} | ${e.node.email || '(no email)'} | ${e.node.phone || ''}`));
  });

  await step('3. Products (services -> Wave products mapping)', async () => {
    const d = await gql(
      'query($b:ID!){ business(id:$b){ products(page:1,pageSize:50){ pageInfo{ totalCount } edges{ node{ id name unitPrice isSold isArchived } } } } }',
      { b: businessId });
    const p = d.business.products;
    console.log('total products:', p.pageInfo.totalCount);
    p.edges.forEach((e) => console.log(`- ${e.node.name} | ${e.node.unitPrice} | sold=${e.node.isSold} archived=${e.node.isArchived} | ${e.node.id}`));
  });

  await step('4. Sales taxes (HST)', async () => {
    const d = await gql('query($b:ID!){ business(id:$b){ salesTaxes(page:1,pageSize:20){ edges{ node{ id name abbreviation rate isArchived } } } } }', { b: businessId });
    d.business.salesTaxes.edges.forEach((e) => console.log(`- ${e.node.name} (${e.node.abbreviation}) rate=${e.node.rate} archived=${e.node.isArchived} | ${e.node.id}`));
  });

  await step('5. Existing invoices: does one expose viewUrl / payment flags? (latest 3)', async () => {
    const d = await gql(
      'query($b:ID!){ business(id:$b){ invoices(page:1,pageSize:3){ edges{ node{ id invoiceNumber status viewUrl pdfUrl disableCreditCardPayments disableBankPayments amountDue{ value } total{ value } } } } } }',
      { b: businessId });
    d.business.invoices.edges.forEach((e) => console.log(JSON.stringify(e.node)));
  });

  await step('6. invoiceCreate input schema (introspection, no write)', async () => {
    const d = await gql('{ __type(name:"InvoiceCreateInput"){ inputFields{ name type{ kind name ofType{ name kind } } } } }');
    (d.__type ? d.__type.inputFields : []).forEach((f) => console.log(`- ${f.name}: ${f.type.name || (f.type.ofType && f.type.ofType.name)} (${f.type.kind})`));
  });

  console.log('\nDone. Nothing was written to Wave.');
})();
