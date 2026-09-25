#!/usr/bin/env node
// Local preview of the Delivery Hub with a FAKE Supabase (no network, nothing real touched):
//   node scripts/preview-hub.js            -> http://localhost:4190/
// The index page just links to the hub and to /admin (flip Paid / Unlock there, exactly as in production).
import http from 'node:http';
import worker from '../src/index.js';

const PORT = Number(process.env.PORT) || 4190;
const TOKEN = 'c'.repeat(32);
const GTOKEN = 'd'.repeat(32);
const JOB = 'FVS-20260925-001';
const state = {
  paid: false, unlocked: false, withPay: true,
  lines: [{ key: 'HDR' }, { key: 'MLS', url: 'https://www.dropbox.com/scl/fo/mls-example' }, { key: 'VIDEO', url: 'https://www.dropbox.com/scl/fo/video-example' },
    { key: 'FLOORPLAN', url: 'https://www.dropbox.com/scl/fo/floorplan-example' }, { key: 'THREE_D' }, { key: 'LOCAL_REPORT', url: 'https://www.dropbox.com/scl/fo/report-example' }, { key: 'HOME_REPORT' }],
};
const project = () => ({ id: JOB, data: { address: '48 Red Ash Dr, Oakville', tourUrl: 'https://my.matterport.com/show/?m=example' }, updated_at: '2026-09-25T10:00:00Z' });
const row = () => ({ job_id: JOB, token: TOKEN, paid: state.paid, unlocked: state.unlocked, lines: state.lines, total_cents: 22599, wave_view_url: state.withPay ? 'https://next.waveapps.com/example/public/invoices/abc' : null });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://sb.preview')) return realFetch(url, init);
  const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/rest/v1/delivery_hub')) {
    if (init.method === 'PATCH') { Object.assign(state, JSON.parse(init.body)); return json([row()]); }
    if (u.includes('select=job_id,token,paid,unlocked')) return json([row()]);
    return json(u.includes(`token=eq.${TOKEN}`) ? [row()] : []);
  }
  if (u.includes('/rest/v1/gallery_tokens')) return json([{ token: GTOKEN, job_id: JOB }]);
  if (u.includes('/rest/v1/projects')) return json(u.includes('id=eq.') ? [project()] : [project()]);
  return new Response('nf', { status: 404 });
};

const env = { SUPABASE_URL: 'https://sb.preview', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm' };
const hub = `/deliver/48-red-ash-dr-oakville/${TOKEN}`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:2">
      <h2>Delivery Hub preview (fake data)</h2>
      <p><a href="${hub}" target="_blank">1. 打开交付页 →</a></p>
      <p><a href="/admin?admin=adm" target="_blank">2. 打开 /admin 目录 →</a> 在这里勾 Paid / Unlock，然后刷新交付页</p>
      <p style="color:#888;font-size:13px">这个首页只是预览用的，上线后不存在。已解锁的按钮会在新标签页打开示例 Dropbox 链接（地址是假的，只看跳转）。</p></body>`);
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
  const out = await worker.fetch(new Request(`https://realgta.ca${req.url}`, { method: req.method, headers: req.headers, body, redirect: 'manual' }), env);
  const headers = Object.fromEntries(out.headers);
  res.writeHead(out.status, headers);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`Delivery Hub preview: http://localhost:${PORT}/`));
