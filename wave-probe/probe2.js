// READ-ONLY second probe. No writes. Never prints the token.
const fs = require('fs'), path = require('path');
const line = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN='));
const TOKEN = line.slice('WAVE_TOKEN='.length).trim();
const BIZ = 'QnVzaW5lc3M6NzJhNjk5YmUtNDA0ZS00Y2Q3LWI4ZWItNjU0ZTBiMmRkMDE1';
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
async function step(t, fn) { console.log(`\n=== ${t} ===`); try { await fn(); } catch (e) { console.log('FAILED:', e.message); } }
const typeRef = (t) => (t.kind === 'NON_NULL' ? typeRef(t.ofType) + '!' : t.kind === 'LIST' ? '[' + typeRef(t.ofType) + ']' : t.name);
async function inputType(name) {
  const d = await gql('query($n:String!){ __type(name:$n){ inputFields{ name type{ kind name ofType{ kind name ofType{ kind name ofType{ kind name }}}}}}}', { n: name });
  (d.__type ? d.__type.inputFields : []).forEach((f) => console.log(`  ${f.name}: ${typeRef(f.type)}`));
}
(async () => {
  await step('A. Customer contact-data coverage (all pages)', async () => {
    let page = 1, total = 0, withEmail = 0, withPhone = 0, withAddr = 0, samples = [];
    for (;;) {
      const d = await gql('query($b:ID!,$p:Int!){ business(id:$b){ customers(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ name email mobile phone address{ city } } } } } }', { b: BIZ, p: page });
      const c = d.business.customers;
      c.edges.forEach((e) => { total++; if (e.node.email) { withEmail++; if (samples.length < 3) samples.push(e.node.name + ' | ' + e.node.email); } if (e.node.mobile || e.node.phone) withPhone++; if (e.node.address && e.node.address.city) withAddr++; });
      if (page >= c.pageInfo.totalPages) break; page++;
    }
    console.log({ total, withEmail, withPhone, withAddr }); console.log('email samples:', samples);
  });
  await step('B. How Franky actually invoices: last 3 invoices in full', async () => {
    const d = await gql('query($b:ID!){ business(id:$b){ invoices(page:1,pageSize:3){ edges{ node{ invoiceNumber title subhead memo footer invoiceDate dueDate status customer{ name email } items{ description quantity unitPrice product{ name } taxes{ salesTax{ name } amount{ value } } total{ value } } } } } } }', { b: BIZ });
    d.business.invoices.edges.forEach((e) => console.log(JSON.stringify(e.node, null, 1)));
  });
  await step('C. InvoiceCreateInput', () => inputType('InvoiceCreateInput'));
  await step('D. InvoiceCreateItemInput', () => inputType('InvoiceCreateItemInput'));
  await step('E. InvoiceCreateItemTaxInput (guess name)', () => inputType('InvoiceItemTaxInput'));
  await step('F. ProductCreateInput', () => inputType('ProductCreateInput'));
  await step('G. CustomerCreateInput', () => inputType('CustomerCreateInput'));
  await step('H. Mutations available', async () => {
    const d = await gql('{ __type(name:"Mutation"){ fields{ name } } }');
    console.log(d.__type.fields.map((f) => f.name).join(', '));
  });
  console.log('\nDone. Nothing was written to Wave.');
})();
