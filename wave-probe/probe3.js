// READ-ONLY: per-product usage across ALL invoices. No writes. Never prints the token.
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const BIZ = 'QnVzaW5lc3M6NzJhNjk5YmUtNDA0ZS00Y2Q3LWI4ZWItNjU0ZTBiMmRkMDE1';
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json(); if (b.errors) throw new Error(b.errors.map((e) => e.message).join('; ')); return b.data;
}
(async () => {
  const use = {}; let page = 1, n = 0, first = null, last = null;
  for (;;) {
    const d = await gql('query($b:ID!,$p:Int!){ business(id:$b){ invoices(page:$p,pageSize:100){ pageInfo{ totalPages totalCount } edges{ node{ invoiceDate status items{ quantity unitPrice product{ name } } } } } } }', { b: BIZ, p: page });
    const inv = d.business.invoices;
    inv.edges.forEach(({ node }) => {
      n++; if (!first || node.invoiceDate < first) first = node.invoiceDate; if (!last || node.invoiceDate > last) last = node.invoiceDate;
      node.items.forEach((it) => {
        const k = it.product ? it.product.name : '(none)'; const u = (use[k] = use[k] || { lines: 0, last: '', prices: {} });
        u.lines++; if (node.invoiceDate > u.last) u.last = node.invoiceDate;
        const pr = Number(it.unitPrice); u.prices[pr] = (u.prices[pr] || 0) + 1;
      });
    });
    if (page >= inv.pageInfo.totalPages) break; page++;
  }
  console.log(`invoices scanned: ${n}  (${first} .. ${last})\n`);
  Object.entries(use).sort((a, b) => b[1].lines - a[1].lines).forEach(([k, u]) => {
    const prices = Object.entries(u.prices).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, c]) => `${p}x${c}`).join(', ');
    console.log(`${String(u.lines).padStart(5)} lines | last ${u.last} | ${k} | prices: ${prices}`);
  });
})().catch((e) => console.log('FAILED:', e.message));
