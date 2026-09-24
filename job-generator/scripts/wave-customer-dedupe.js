#!/usr/bin/env node
// Read-only: pull every Wave customer and list groups that look like duplicates, for Franky to
// confirm before any merge. Writes nothing to Wave. Usage: node scripts/wave-customer-dedupe.js [out.json]
const path = require('path');
const fs = require('fs');
const wave = require(path.join(__dirname, '..', 'wave-backend.js'));

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[.,'"()\-_]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['inc', 'ltd', 'limited', 'corp', 'corporation', 'realty', 'real', 'estate', 'group', 'team', 'the', 'and', 'co', 'brokerage', 'homes']);
const key = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t)).sort().join(' ');
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

async function fetchAll() {
  const c = wave.config();
  const client = require(path.join(__dirname, '..', '..', 'wave-invoicing', 'wave-client.js')).createWaveClient({ token: c.token, businessId: c.businessId });
  const rows = [];
  for (let page = 1; ; page++) {
    const d = await client.gql(
      'query($b:ID!,$p:Int!){ business(id:$b){ customers(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ id name firstName lastName email phone mobile isArchived } } } } }',
      { b: c.businessId, p: page });
    const cu = d.business.customers;
    cu.edges.forEach((e) => rows.push(e.node));
    if (page >= cu.pageInfo.totalPages) break;
  }
  return rows;
}

(async () => {
  if (!wave.isConfigured()) { console.error('WAVE_TOKEN / WAVE_BUSINESS_ID not set in job-generator/.env'); process.exit(1); }
  const rows = await fetchAll();
  // union-find over pairs with a reason
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasons = new Map(); // "i|j" -> Set
  const link = (i, j, why) => { parent[find(i)] = find(j); const k = i < j ? i + '|' + j : j + '|' + i; (reasons.get(k) || reasons.set(k, new Set()).get(k)).add(why); };
  const idx = (fn, why, minLen) => {
    const m = new Map();
    rows.forEach((r, i) => { const k = fn(r); if (k && (!minLen || k.length >= minLen)) (m.get(k) || m.set(k, []).get(k)).push(i); });
    m.forEach((l) => { for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) link(l[a], l[b], why); });
  };
  idx((r) => norm(r.email), '同一邮箱');
  idx((r) => digits(r.phone), '同一电话', 10);
  idx((r) => digits(r.mobile), '同一手机', 10);
  idx((r) => key(r.name), '名字相同(忽略大小写/顺序/标点)');
  const keys = rows.map((r) => key(r.name));
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = keys[i], b = keys[j];
    if (!a || !b || a === b || Math.min(a.length, b.length) < 5) continue;
    if (lev(a, b) <= (Math.max(a.length, b.length) > 12 ? 2 : 1)) link(i, j, '名字很像(拼写差异)');
  }
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); (groups.get(g) || groups.set(g, []).get(g)).push(i); });
  const out = [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const why = new Set();
    for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) (reasons.get(Math.min(g[a], g[b]) + '|' + Math.max(g[a], g[b])) || []).forEach((w) => why.add(w));
    return { reasons: [...why], customers: g.map((i) => rows[i]) };
  }).sort((x, y) => x.customers[0].name.localeCompare(y.customers[0].name));
  const file = process.argv[2] || path.join(__dirname, '..', 'test-output', 'wave-duplicates.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`共 ${rows.length} 个客户,${out.length} 组疑似重复 -> ${file}`);
  out.forEach((g, n) => {
    console.log(`\n#${n + 1}  [${g.reasons.join(' / ')}]`);
    g.customers.forEach((c) => console.log(`   ${c.name}  | ${c.email || '-'} | ${c.phone || c.mobile || '-'}${c.isArchived ? ' | 已归档' : ''}  (${c.id})`));
  });
})().catch((e) => { console.error(e.message); process.exit(1); });
