// READ-ONLY. Per-customer invoice frequency + last invoice date -> out/customer-stats.csv (gitignored: real names/emails).
const fs = require('fs'), path = require('path');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const BIZ = 'QnVzaW5lc3M6NzJhNjk5YmUtNDA0ZS00Y2Q3LWI4ZWItNjU0ZTBiMmRkMDE1';
async function gql(query, variables) {
  const r = await fetch('https://gql.waveapps.com/graphql/public', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.errors) throw new Error((b.errors || []).map((e) => e.message).join('; ') || `HTTP ${r.status}`);
  return b.data;
}
(async () => {
  const cust = new Map();
  for (let p = 1; ; p++) {
    const d = await gql('query($b:ID!,$p:Int!){ business(id:$b){ customers(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ id name email } } } } }', { b: BIZ, p });
    d.business.customers.edges.forEach((e) => cust.set(e.node.id, { name: e.node.name, email: e.node.email || '', n: 0, n12: 0, first: '', last: '', total: 0 }));
    if (p >= d.business.customers.pageInfo.totalPages) break;
  }
  const cutoff = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  let inv = 0;
  for (let p = 1; ; p++) {
    const d = await gql('query($b:ID!,$p:Int!){ business(id:$b){ invoices(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ invoiceDate status customer{ id } total{ value } } } } } }', { b: BIZ, p });
    d.business.invoices.edges.forEach((e) => {
      const n = e.node, c = cust.get(n.customer && n.customer.id); if (!c) return; inv++;
      c.n++; c.total += Number(String(n.total.value).replace(/,/g, '')); if (n.invoiceDate >= cutoff) c.n12++;
      if (!c.first || n.invoiceDate < c.first) c.first = n.invoiceDate;
      if (n.invoiceDate > c.last) c.last = n.invoiceDate;
    });
    if (p >= d.business.invoices.pageInfo.totalPages) break;
  }
  const rows = [...cust.values()].sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : -1));
  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  fs.writeFileSync(path.join(__dirname, 'out', 'customer-stats.csv'), '﻿客户名,邮箱,总发票数,近12个月发票数,首次开票,最近开票,累计金额(含税),公司/收款方备注(Franky填)\n' + rows.map((r) => [q(r.name), q(r.email), r.n, r.n12, r.first, r.last, r.total.toFixed(2), ''].join(',')).join('\n') + '\n');
  console.log('customers', rows.length, '| invoices matched', inv, '| with 0 invoices', rows.filter((r) => !r.n).length, '| active last 12m', rows.filter((r) => r.n12).length);
  console.log('invoices in last 12m by top customers:'); rows.slice(0, 25).forEach((r, i) => console.log(String(i + 1).padStart(2), r.name.padEnd(28), 'n=' + r.n, 'n12=' + r.n12, 'last=' + r.last));
  const cum = (k) => { let s = 0, tot = rows.reduce((a, r) => a + r.n, 0); const out = []; rows.forEach((r, i) => { s += r.n; if (i + 1 === k) out.push(`top ${k} = ${(100 * s / tot).toFixed(0)}% of invoices`); }); return out[0]; };
  console.log(cum(20), '|', cum(50), '|', cum(100));
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
