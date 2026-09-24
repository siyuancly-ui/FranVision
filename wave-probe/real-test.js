// WRITE TEST on the REAL business (user-approved 2026-09-21). create -> (inspect viewUrl) -> approve -> cleanup. Ids in .write-test-ids.json (gitignored).
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const REAL = 'QnVzaW5lc3M6NzJhNjk5YmUtNDA0ZS00Y2Q3LWI4ZWItNjU0ZTBiMmRkMDE1';
const F = path.join(__dirname, '.write-test-ids.json');
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
const ok = (m) => { if (!m.didSucceed) throw new Error(JSON.stringify(m.inputErrors)); };
const step = process.argv[2];
(async () => {
  if (step === 'create') {
    const d = await gql('query($b:ID!){ business(id:$b){ name products(page:1,pageSize:100){ edges{ node{ id name isArchived } } } salesTaxes(page:1,pageSize:20){ edges{ node{ id name rate } } } } }', { b: REAL });
    console.log('business:', d.business.name);
    const prod = d.business.products.edges.map((e) => e.node).find((p) => p.name === 'Drone View' && !p.isArchived);
    const tax = d.business.salesTaxes.edges.map((e) => e.node).find((t) => /HST/i.test(t.name));
    console.log('product', prod && prod.id, '| tax', tax && tax.name, tax && tax.rate);
    if (!prod || !tax) throw new Error('product or tax not found, abort before writing');
    const c = await gql('mutation($i:CustomerCreateInput!){ customerCreate(input:$i){ didSucceed inputErrors{ message } customer{ id } } }', { i: { businessId: REAL, name: 'ZZ API TEST (delete me)' } });
    ok(c.customerCreate); const cid = c.customerCreate.customer.id;
    fs.writeFileSync(F, JSON.stringify({ cid }));
    const inv = await gql('mutation($i:InvoiceCreateInput!){ invoiceCreate(input:$i){ didSucceed inputErrors{ message path } invoice{ id status invoiceNumber viewUrl total{ value } items{ total{ value } taxes{ amount{ value } } } } } }',
      { i: { businessId: REAL, customerId: cid, status: 'DRAFT', invoiceDate: '2026-09-21', dueDate: '2026-10-21', items: [{ productId: prod.id, description: 'API TEST - delete me', quantity: 1, unitPrice: '1.00', taxes: [{ salesTaxId: tax.id }] }] } });
    ok(inv.invoiceCreate); const iv = inv.invoiceCreate.invoice;
    fs.writeFileSync(F, JSON.stringify({ cid, invoiceId: iv.id }));
    console.log(JSON.stringify(iv, null, 1));
  } else if (step === 'approve') {
    const { invoiceId } = JSON.parse(fs.readFileSync(F));
    console.log(JSON.stringify(await gql('mutation($i:InvoiceApproveInput!){ invoiceApprove(input:$i){ didSucceed inputErrors{ message } invoice{ status viewUrl } } }', { i: { invoiceId } })));
  } else if (step === 'cleanup') {
    const { cid, invoiceId } = JSON.parse(fs.readFileSync(F));
    if (invoiceId) console.log(JSON.stringify(await gql('mutation($i:InvoiceDeleteInput!){ invoiceDelete(input:$i){ didSucceed inputErrors{ message } } }', { i: { invoiceId } })));
    console.log(JSON.stringify(await gql('mutation($i:CustomerDeleteInput!){ customerDelete(input:$i){ didSucceed inputErrors{ message } } }', { i: { id: cid } })));
  }
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
