// REAL BUSINESS (Franky Photography Studio), approved by user 2026-09-21.
// 1) back up legacy product names, 2) rename every legacy product with a leading "*", 3) create the clean product set
// from pricing-config. Idempotent: legacy names already starting with "*" are skipped; a clean product that already exists is reused.
// usage: node setup-real-products.js            (dry run, read-only)
//        node setup-real-products.js --apply
const fs = require('fs'), path = require('path');
const { createWaveClient } = require('../wave-invoicing/wave-client');
const cfg = require('../pricing/pricing-config.js');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const REAL = 'QnVzaW5lc3M6NzJhNjk5YmUtNDA0ZS00Y2Q3LWI4ZWItNjU0ZTBiMmRkMDE1';
const APPLY = process.argv.includes('--apply');
const OUT = path.join(__dirname, 'out');
const w = createWaveClient({ token: TOKEN, businessId: REAL });
const ok = (m, what) => { if (!m.didSucceed) throw new Error(what + ': ' + JSON.stringify(m.inputErrors)); return m; };

(async () => {
  const b = await w.gql('query($b:ID!){ business(id:$b){ name isPersonal accounts(page:1,pageSize:200,types:[INCOME]){ edges{ node{ id name } } } } }', { b: REAL });
  if (b.business.name !== 'Franky Photography Studio' || b.business.isPersonal) throw new Error('unexpected business, abort');
  const sales = b.business.accounts.edges.map((e) => e.node).filter((a) => a.name === 'Sales');
  if (sales.length !== 1) throw new Error('expected exactly one "Sales" income account, found ' + sales.length);
  const hst = await w.findHstTaxId();
  const products = (await w.listProducts()).filter((p) => !p.isArchived);
  const legacy = products.filter((p) => !p.name.startsWith('*'));

  const defs = [];
  for (const s of Object.values(cfg.services)) {
    if (!s.pricing) continue; // site_plan / walkthrough_video have no standalone price (package-only)
    const p = s.pricing;
    defs.push([s.id, s.displayName, p.amountCents != null ? p.amountCents : p.unitAmountCents != null ? p.unitAmountCents : p.condo]);
  }
  for (const p of cfg.packages) defs.push([p.id, p.displayName, p.priceCents]);
  defs.push(['adjustment_discount', 'Discount', 0], ['custom_item', 'Other', 0]);

  const legacyNames = new Set(legacy.map((p) => p.name));
  console.log('LEGACY products to rename (' + legacy.length + '):');
  legacy.forEach((p) => console.log('  ', p.name, '->', '*' + p.name));
  console.log('NEW products (' + defs.length + '), income account "Sales", default tax HST:');
  defs.forEach(([k, n, c]) => console.log('  ', k.padEnd(22), n.padEnd(38), '$' + (c / 100).toFixed(2)));
  if (!APPLY) return console.log('\n(dry run: nothing written)');

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'legacy-names-backup.json'), JSON.stringify(legacy.map((p) => ({ id: p.id, name: p.name })), null, 1));
  for (const p of legacy) {
    const d = await w.gql('mutation($i:ProductPatchInput!){ productPatch(input:$i){ didSucceed inputErrors{ message } } }', { i: { id: p.id, name: '*' + p.name } }, { mutation: true });
    ok(d.productPatch, 'rename ' + p.name);
  }
  console.log('renamed', legacy.length);
  const existing = new Map((await w.listProducts()).filter((p) => !p.isArchived && !p.name.startsWith('*')).map((p) => [p.name, p.id]));
  const map = {};
  for (const [key, name, cents] of defs) {
    if (existing.has(name)) { map[key] = existing.get(name); console.log('reuse', name); continue; }
    const d = await w.gql('mutation($i:ProductCreateInput!){ productCreate(input:$i){ didSucceed inputErrors{ message } product{ id } } }', { i: { businessId: REAL, name, unitPrice: (cents / 100).toFixed(2), incomeAccountId: sales[0].id, defaultSalesTaxIds: [hst] } }, { mutation: true });
    map[key] = ok(d.productCreate, 'create ' + name).product.id;
  }
  fs.writeFileSync(path.join(OUT, 'real-product-map.json'), JSON.stringify(map, null, 1));
  console.log('created/mapped', Object.keys(map).length, '-> out/real-product-map.json');
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
