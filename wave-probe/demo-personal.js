// END-TO-END DEMO in the "Personal" Wave business ONLY (hard-asserted). Never writes to the FranVision job or the real business.
// usage: node demo-personal.js run <job.json path>   |   node demo-personal.js cleanup
const fs = require('fs'), path = require('path');
const { createWaveClient } = require('../wave-invoicing/wave-client');
const { buildInvoiceRequest, compareTotals } = require('../wave-invoicing/invoice-request');
const cfg = require('../pricing/pricing-config.js');
const TOKEN = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').find((l) => l.startsWith('WAVE_TOKEN=')).slice(11).trim();
const PERSONAL = 'QnVzaW5lc3M6MzYxOWIzMTAtMDRhNi00OTc2LWI3ZjktZGE4NDdkMjRhYTZi';
const INCOME = 'QWNjb3VudDoyMDMzODkxNTM2NDUzNzYzMjY2O0J1c2luZXNzOjM2MTliMzEwLTA0YTYtNDk3Ni1iN2Y5LWRhODQ3ZDI0YWE2Yg==';
const STATE = path.join(__dirname, 'out', 'demo-ids.json');
const w = createWaveClient({ token: TOKEN, businessId: PERSONAL });
const ok = (m, what) => { if (!m.didSucceed) throw new Error(what + ': ' + JSON.stringify(m.inputErrors)); return m; };

(async () => {
  const biz = await w.gql('query($b:ID!){ business(id:$b){ name isPersonal } }', { b: PERSONAL });
  if (biz.business.name !== 'Personal' || !biz.business.isPersonal) throw new Error('not Personal, abort');
  const mode = process.argv[2];
  if (mode === 'run') {
    const row = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const job = (row.data || {}).job || {};
    const pricing = job.pricing;
    // 1. product set from pricing-config
    const defs = [];
    for (const s of Object.values(cfg.services)) if (s.pricing && s.pricing.type !== undefined) {
      const cents = s.pricing.amountCents != null ? s.pricing.amountCents : s.pricing.unitAmountCents != null ? s.pricing.unitAmountCents : s.pricing.condo;
      defs.push([s.id, s.displayName, cents]);
    }
    for (const p of cfg.packages) defs.push([p.id, p.displayName, p.priceCents]);
    defs.push(['adjustment_discount', 'Discount', 0], ['custom_item', 'Additional Item', 0]);
    const productMap = {}, created = [];
    for (const [key, name, cents] of defs) {
      const d = await w.gql('mutation($i:ProductCreateInput!){ productCreate(input:$i){ didSucceed inputErrors{ message } product{ id } } }', { i: { businessId: PERSONAL, name, unitPrice: (cents / 100).toFixed(2), incomeAccountId: INCOME } }, { mutation: true });
      productMap[key] = ok(d.productCreate, 'productCreate ' + name).product.id; created.push(productMap[key]);
    }
    console.log('products created:', defs.length);
    // 2. throwaway customer (NOT the real client)
    const cust = await w.createCustomer({ name: 'ZZ DEMO Customer (delete me)' });
    // 3. request from the real job's frozen pricing -> DRAFT
    const req = buildInvoiceRequest({ pricing, businessId: PERSONAL, customerId: cust.id, taxId: '', allowNoTax: true, productMap, address: (row.address || '').trim(), invoiceDate: '2026-09-21', jobId: row.job_id });
    console.log('REQUEST items:', JSON.stringify(req.items.map((i) => [i.description, i.unitPrice]), null, 0), '| due', req.dueDate, '| po', req.poNumber);
    const inv = await w.createDraftInvoice(req);
    fs.writeFileSync(STATE, JSON.stringify({ invoiceId: inv.id, customerId: cust.id, products: created }));
    console.log('DRAFT:', JSON.stringify(inv));
    console.log('engine subtotal (pre-tax, cents):', pricing.finalSubtotalCents, '| Wave total (no HST in Personal):', inv.totalDecimal, '| engine total incl. HST:', pricing.totalCents);
    console.log('sanity:', JSON.stringify(compareTotals(pricing.finalSubtotalCents, inv.totalDecimal)));
  } else if (mode === 'cleanup') {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const t = async (n, f) => { try { await f(); console.log('ok', n); } catch (e) { console.log('FAILED', n, e.message); } };
    await t('delete invoice', () => w.deleteInvoice(st.invoiceId));
    await t('delete customer', () => w.gql('mutation($i:CustomerDeleteInput!){ customerDelete(input:$i){ didSucceed } }', { i: { id: st.customerId } }, { mutation: true }));
    for (const id of st.products) await t('archive product', () => w.gql('mutation($i:ProductArchiveInput!){ productArchive(input:$i){ didSucceed inputErrors{ message } } }', { i: { id } }, { mutation: true }));
    fs.unlinkSync(STATE);
  }
})().catch((e) => { console.log('FAILED:', e.message); process.exit(1); });
