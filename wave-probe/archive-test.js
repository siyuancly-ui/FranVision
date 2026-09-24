// WRITE TEST, Personal business ONLY: does productPatch (rename/reprice) or productArchive change an existing invoice?
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const PERSONAL = 'QnVzaW5lc3M6MzYxOWIzMTAtMDRhNi00OTc2LWI3ZjktZGE4NDdkMjRhYTZi';
const INCOME = 'QWNjb3VudDoyMDMzODkxNTM2NDUzNzYzMjY2O0J1c2luZXNzOjM2MTliMzEwLTA0YTYtNDk3Ni1iN2Y5LWRhODQ3ZDI0YWE2Yg==';
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
const ok = (m) => { if (!m.didSucceed) throw new Error(JSON.stringify(m.inputErrors)); return m; };
const READ = 'query($b:ID!,$i:ID!){ business(id:$b){ invoice(id:$i){ status total{ value } items{ description unitPrice total{ value } product{ id name unitPrice isArchived } } } } }';
(async () => {
  const b = await gql('query($b:ID!){ business(id:$b){ name isPersonal } }', { b: PERSONAL });
  if (b.business.name !== 'Personal' || !b.business.isPersonal) throw new Error('not Personal, abort');
  const pin = await gql('query($n:String!){ __type(name:$n){ inputFields{ name } } }', { n: 'ProductPatchInput' });
  console.log('ProductPatchInput fields:', pin.__type.inputFields.map((f) => f.name).join(', '));
  let cid, pid, iid;
  try {
    cid = ok((await gql('mutation($i:CustomerCreateInput!){ customerCreate(input:$i){ didSucceed inputErrors{ message } customer{ id } } }', { i: { businessId: PERSONAL, name: 'ZZ ARCHIVE TEST' } })).customerCreate).customer.id;
    pid = ok((await gql('mutation($i:ProductCreateInput!){ productCreate(input:$i){ didSucceed inputErrors{ message } product{ id } } }', { i: { businessId: PERSONAL, name: 'ZZ OLD NAME', unitPrice: '50.00', incomeAccountId: INCOME } })).productCreate).product.id;
    iid = ok((await gql('mutation($i:InvoiceCreateInput!){ invoiceCreate(input:$i){ didSucceed inputErrors{ message } invoice{ id } } }', { i: { businessId: PERSONAL, customerId: cid, status: 'DRAFT', items: [{ productId: pid, quantity: 1 }] } })).invoiceCreate).invoice.id;
    await gql('mutation($i:InvoiceApproveInput!){ invoiceApprove(input:$i){ didSucceed } }', { i: { invoiceId: iid } });
    console.log('BEFORE:', JSON.stringify((await gql(READ, { b: PERSONAL, i: iid })).business.invoice));
    console.log('PATCH:', JSON.stringify((await gql('mutation($i:ProductPatchInput!){ productPatch(input:$i){ didSucceed inputErrors{ message } } }', { i: { id: pid, name: 'ZZ NEW NAME', unitPrice: '99.00' } })).productPatch));
    console.log('AFTER PATCH:', JSON.stringify((await gql(READ, { b: PERSONAL, i: iid })).business.invoice));
    try { console.log('ARCHIVE (invoice still exists):', JSON.stringify((await gql('mutation($i:ProductArchiveInput!){ productArchive(input:$i){ didSucceed inputErrors{ message } } }', { i: { id: pid } })).productArchive)); } catch (e) { console.log('ARCHIVE ERROR:', e.message); }
    console.log('AFTER ARCHIVE:', JSON.stringify((await gql(READ, { b: PERSONAL, i: iid })).business.invoice));
    const list = await gql('query($b:ID!){ business(id:$b){ products(page:1,pageSize:100){ edges{ node{ name isArchived } } } } }', { b: PERSONAL });
    console.log('product list shows archived one?', JSON.stringify(list.business.products.edges.map((e) => e.node).filter((p) => /ZZ/.test(p.name))));
  } finally {
    const t = async (n, f) => { try { console.log(n, JSON.stringify(await f())); } catch (e) { console.log(n, 'FAILED', e.message); } };
    if (iid) await t('del invoice', () => gql('mutation($i:InvoiceDeleteInput!){ invoiceDelete(input:$i){ didSucceed } }', { i: { invoiceId: iid } }));
    if (pid) await t('archive product', () => gql('mutation($i:ProductArchiveInput!){ productArchive(input:$i){ didSucceed } }', { i: { id: pid } }));
    if (cid) await t('del customer', () => gql('mutation($i:CustomerDeleteInput!){ customerDelete(input:$i){ didSucceed } }', { i: { id: cid } }));
  }
})().catch((e) => console.log('FAILED:', e.message));
