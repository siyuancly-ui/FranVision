// WRITE TEST -- ONLY against the "Personal" business (hard-asserted). Creates a test customer, product and DRAFT invoice, reads them back, then cleans up.
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const PERSONAL = 'QnVzaW5lc3M6MzYxOWIzMTAtMDRhNi00OTc2LWI3ZjktZGE4NDdkMjRhYTZi';
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
const okChk = (m) => { if (!m.didSucceed) throw new Error('mutation failed: ' + JSON.stringify(m.inputErrors)); };
(async () => {
  const b = await gql('query($b:ID!){ business(id:$b){ name isPersonal salesTaxes(page:1,pageSize:50){ edges{ node{ id name rate } } } } }', { b: PERSONAL });
  if (b.business.name !== 'Personal' || !b.business.isPersonal) throw new Error('not the Personal business, abort');
  console.log('business:', b.business.name, '| taxes:', JSON.stringify(b.business.salesTaxes.edges.map((e) => e.node)));
  const cust = await gql('mutation($i:CustomerCreateInput!){ customerCreate(input:$i){ didSucceed inputErrors{ message path } customer{ id name } } }', { i: { businessId: PERSONAL, name: 'ZZ API TEST Customer' } });
  okChk(cust.customerCreate); const cid = cust.customerCreate.customer.id; console.log('customer', cid);
  const prod = await gql('mutation($i:ProductCreateInput!){ productCreate(input:$i){ didSucceed inputErrors{ message path } product{ id name } } }', { i: { businessId: PERSONAL, name: 'ZZ API TEST Product', unitPrice: '98.00', incomeAccountId: 'QWNjb3VudDoyMDMzODkxNTM2NDUzNzYzMjY2O0J1c2luZXNzOjM2MTliMzEwLTA0YTYtNDk3Ni1iN2Y5LWRhODQ3ZDI0YWE2Yg==' } });
  okChk(prod.productCreate); const pid = prod.productCreate.product.id; console.log('product', pid);
  const tax = (b.business.salesTaxes.edges[0] || {}).node;
  const items = [{ productId: pid, description: '123 Test St', quantity: 1, unitPrice: '98.00', ...(tax ? { taxes: [{ salesTaxId: tax.id }] } : {}) }];
  const inv = await gql(`mutation($i:InvoiceCreateInput!){ invoiceCreate(input:$i){ didSucceed inputErrors{ message path } invoice{ id status invoiceNumber viewUrl total{ value } amountDue{ value } items{ total{ value } } } } }`,
    { i: { businessId: PERSONAL, customerId: cid, status: 'DRAFT', invoiceDate: '2026-09-21', dueDate: '2026-10-21', items } });
  okChk(inv.invoiceCreate); const iv = inv.invoiceCreate.invoice;
  console.log('DRAFT invoice:', JSON.stringify(iv, null, 1));
  console.log('viewUrl fetch status (draft):', await fetch(iv.viewUrl).then((r) => r.status).catch((e) => e.message));
  const Q = 'didSucceed inputErrors{ message path } invoice{ id status invoiceNumber viewUrl total{ value } }';
  const ap = await gql(`mutation($i:InvoiceApproveInput!){ invoiceApprove(input:$i){ ${Q} } }`, { i: { invoiceId: iv.id } }).catch((e) => ({ err: e.message }));
  console.log('APPROVE:', JSON.stringify(ap));
  if (ap.invoiceApprove && ap.invoiceApprove.invoice) console.log('viewUrl fetch status (approved):', await fetch(ap.invoiceApprove.invoice.viewUrl).then((r) => r.status).catch((e) => e.message));
  // cleanup (each step reported, never throws)
  const tryDo = async (n, f) => { try { console.log(n, JSON.stringify(await f())); } catch (e) { console.log(n, 'FAILED', e.message); } };
  await tryDo('delete invoice', () => gql('mutation($i:InvoiceDeleteInput!){ invoiceDelete(input:$i){ didSucceed inputErrors{ message } } }', { i: { invoiceId: iv.id } }));
  await tryDo('archive product', () => gql('mutation($i:ProductArchiveInput!){ productArchive(input:$i){ didSucceed inputErrors{ message } } }', { i: { productId: pid } }));
  for (const id of [cid, 'QnVzaW5lc3M6MzYxOWIzMTAtMDRhNi00OTc2LWI3ZjktZGE4NDdkMjRhYTZiO0N1c3RvbWVyOjEwNTU5NjUyOQ==']) await tryDo('delete customer', () => gql('mutation($i:CustomerDeleteInput!){ customerDelete(input:$i){ didSucceed inputErrors{ message } } }', { i: { id } }));
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
