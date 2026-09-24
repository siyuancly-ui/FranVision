// READ-ONLY. Discover the "Personal" business + mutation/enum names before any write test.
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
async function step(t, fn) { console.log(`\n=== ${t} ===`); try { await fn(); } catch (e) { console.log('FAILED:', e.message); } }
const typeRef = (t) => (t.kind === 'NON_NULL' ? typeRef(t.ofType) + '!' : t.kind === 'LIST' ? '[' + typeRef(t.ofType) + ']' : t.name);
(async () => {
  await step('businesses', async () => {
    const d = await gql('{ businesses(page:1,pageSize:20){ edges{ node{ id name isPersonal currency{ code } } } } }');
    d.businesses.edges.forEach((e) => console.log(e.node.id, '|', e.node.name, '| personal:', e.node.isPersonal, '|', e.node.currency.code));
  });
  await step('Mutation fields', async () => {
    const d = await gql('query($n:String!){ __type(name:$n){ fields{ name } } }', { n: 'Mutation' });
    console.log(d.__type.fields.map((f) => f.name).filter((n) => /invoice|product|customer/i.test(n)).join(', '));
  });
  for (const n of ['InvoiceCreateStatus']) await step('enum ' + n, async () => {
    const d = await gql('query($n:String!){ __type(name:$n){ enumValues{ name } } }', { n });
    console.log(d.__type && d.__type.enumValues.map((v) => v.name).join(', '));
  });
  for (const n of ['InvoiceCreateItemTaxInput', 'InvoiceCreateInput']) await step('input ' + n, async () => {
    const d = await gql('query($n:String!){ __type(name:$n){ inputFields{ name type{ kind name ofType{ kind name ofType{ kind name }}}}}}', { n });
    d.__type.inputFields.forEach((f) => console.log(`  ${f.name}: ${typeRef(f.type)}`));
  });
})();
