#!/usr/bin/env node
// Local preview of the Delivery Hub with a FAKE Supabase (no network, nothing real touched):
//   node scripts/preview-hub.js            -> http://localhost:4190/
// The index links to the hub and /admin, and can send SIGNED fake Wave webhooks (fully paid / partial) through the
// real /webhooks/wave route so you can watch /admin and the hub react exactly as in production.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';

const PORT = Number(process.env.PORT) || 4190;
const TOKEN = 'c'.repeat(32);
const GTOKEN = 'd'.repeat(32);
const JOB = 'FVS-20260925-001';
const WAVE_INVOICE = '2619579987556152644';
const SECRET = 'preview-secret';
const fresh = () => ({
  paid: false, unlocked: false, paid_source: null, paid_at: null, wave_paid_cents: null, wave_remaining_cents: null,
  lines: [{ key: 'HDR' }, { key: 'MLS', url: 'https://www.dropbox.com/scl/fo/mls-example' }, { key: 'VIDEO', url: 'https://www.dropbox.com/scl/fo/video-example' },
    { key: 'FLOORPLAN', url: 'https://www.dropbox.com/scl/fo/floorplan-example' }, { key: 'THREE_D' }, { key: 'LOCAL_REPORT', url: 'https://www.dropbox.com/scl/fo/report-example' }, { key: 'HOME_REPORT' }],
});
let state = fresh();
const events = new Map();
const project = () => ({ id: JOB, data: { address: '48 Red Ash Dr, Oakville', tourUrl: 'https://my.matterport.com/show/?m=example' }, updated_at: '2026-09-25T10:00:00Z' });
const row = () => ({ job_id: JOB, token: TOKEN, wave_invoice_id: WAVE_INVOICE, total_cents: 22599, wave_view_url: 'https://next.waveapps.com/example/public/invoices/abc', ...state });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://sb.preview')) return realFetch(url, init);
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/rest/v1/wave_events')) {
    if (init.method === 'POST') { const b = JSON.parse(init.body); if (events.has(b.event_id)) return json([]); events.set(b.event_id, b); return json([b], 201); }
    return new Response('', { status: 200 });
  }
  if (u.includes('/rest/v1/delivery_hub')) {
    if (init.method === 'PATCH') { Object.assign(state, JSON.parse(init.body)); return json([row()]); }
    if (u.includes('select=job_id,token,paid,unlocked')) return json([row()]);
    if (u.includes('wave_invoice_id=eq.')) return json(u.includes(WAVE_INVOICE) ? [row()] : []);
    return json(u.includes(TOKEN) || u.includes(`job_id=eq.${JOB}`) ? [row()] : []);
  }
  if (u.includes('/rest/v1/gallery_tokens')) return json([{ token: GTOKEN, job_id: JOB }]);
  if (u.includes('/rest/v1/projects')) return json([project()]);
  return new Response('nf', { status: 404 });
};

const env = { SUPABASE_URL: 'https://sb.preview', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm', WAVE_WEBHOOK_SECRET: SECRET };
const hub = `/deliver/48-red-ash-dr-oakville/${TOKEN}`;

async function sendWave(type, amount, remaining) {
  const body = JSON.stringify({ event_id: `evt-${Date.now()}`, event_type: type, business_id: 'preview', data: { invoice_id: WAVE_INVOICE, customer_id: '1', currency_code: 'CAD', paid_date: '2026-09-25', amount_paid: amount, remaining_balance: remaining } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
  return worker.fetch(new Request('https://realgta.ca/webhooks/wave', { method: 'POST', headers: { 'x-wave-signature': sig }, body }), env);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/sim/')) {
    const what = url.pathname.slice(5);
    if (what === 'paid') await sendWave('invoice.paid', '225.99', '0.00');
    else if (what === 'partial') await sendWave('invoice.partially_paid', '100.00', '125.99');
    else if (what === 'reset') { state = fresh(); events.clear(); }
    res.writeHead(302, { location: '/' }); return res.end();
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:2">
      <h2>Delivery Hub preview (fake data)</h2>
      <p><a href="${hub}" target="_blank">1. 打开交付页 →</a></p>
      <p><a href="/admin?admin=adm" target="_blank">2. 打开 /admin 目录 →</a> 在这里勾 Paid / Unlock，然后刷新交付页</p>
      <p>3. 模拟 Wave 通知（走真实的 /webhooks/wave，带签名）：<br>
        <a href="/sim/paid">Wave 付清 $225.99</a> &nbsp;·&nbsp; <a href="/sim/partial">Wave 部分付款 $100</a> &nbsp;·&nbsp; <a href="/sim/reset">全部还原</a></p>
      <p style="color:#888;font-size:13px">这个首页只是预览用的，上线后不存在。已解锁的按钮会在新标签页打开示例 Dropbox 链接（地址是假的，只看跳转）。</p></body>`);
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
  const out = await worker.fetch(new Request(`https://realgta.ca${req.url}`, { method: req.method, headers: req.headers, body, redirect: 'manual' }), env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`Delivery Hub preview: http://localhost:${PORT}/`));
