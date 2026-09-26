// The forwardable client view (?for=client): only what is below the divider, no price / payment / brand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { buildHubModel, renderHubPage, renderClientView } from '../src/hub.js';

const JOB = 'FVS-20260925-001';
const TOKEN = 'c'.repeat(32);
const GTOKEN = 'd'.repeat(32);
const PROJECT = { id: JOB, data: { address: '12 Main St, Toronto', tourUrl: 'https://my.matterport.com/show/?m=x' }, updated_at: '2026-09-25T10:00:00Z' };
const ROW = {
  job_id: JOB, token: TOKEN, paid: false, unlocked: false, client_name: 'Jessie Tang', total_cents: 11300, pretax_cents: 10000,
  wave_view_url: 'https://link.waveapps.com/x', wave_pdf_url: 'https://accounting.waveapps.com/i.pdf',
  lines: [{ key: 'HDR' }, { key: 'MLS', url: 'https://www.dropbox.com/scl/fo/mls' }, { key: 'VIDEO', url: 'https://www.dropbox.com/scl/fo/v' }, { key: 'THREE_D' }],
};
const BASE = `/deliver/x/${TOKEN}`;

// everything the client must never see, in a locked AND an unlocked view
const FORBIDDEN = /\$|Fee 费用|Pay now|View invoice|Invoice|receipt|Payment|payment|hubModal|hubPayNow|hubEmt|Franky|FranVision|FRANVISION|Preview|Thank you|Hello|Photos by|waveapps|frankystudio|\?pay=1|\/invoice|\/status/;

test('client view (locked): address + All in One + inert download buttons + "contact your agent"; no price, payment, invoice, brand, sign-off', () => {
  const html = renderClientView(buildHubModel(ROW, PROJECT, GTOKEN), { base: BASE });
  const body = html.slice(html.indexOf('<body>'));
  assert.doesNotMatch(body.replace(/<style>[\s\S]*?<\/style>/g, ''), FORBIDDEN);
  assert.match(body, />All in One Virtual Tour URL<span class="hub-zh">在线浏览<\/span>/);  // now the last item of the gated list
  assert.doesNotMatch(body, /href="\/12-main-st-toronto\/FVS-20260925-001"/);             // locked: no link
  assert.match(body, /<h1 class="mail-addr">12 Main St, Toronto<\/h1>/);
  assert.equal((body.match(/class="hub-btn is-disabled"/g) || []).length, 5);              // inert, no links at all
  assert.doesNotMatch(body, /\/go\/|dropbox|matterport|<button|<script/);
  assert.match(body, /please contact your agent/);
  assert.match(body, /请联系您的经纪/);
  assert.match(html, /<title>12 Main St, Toronto<\/title>/);                                // no brand in the tab title either
});

test('client view (unlocked): download links go through /go/<KEY>?for=client (so a later lock never falls back to the priced page)', () => {
  for (const state of [{ paid: true }, { unlocked: true }]) {
    const html = renderClientView(buildHubModel({ ...ROW, ...state }, PROJECT, GTOKEN), { base: BASE });
    const body = html.slice(html.indexOf('<body>')).replace(/<style>[\s\S]*?<\/style>/g, '');
    assert.doesNotMatch(body.replace(/\/go\/[A-Z_]+\?for=client/g, ''), FORBIDDEN);
    assert.match(body, new RegExp(`href="${BASE}/go/HDR\\?for=client" target="_blank" rel="noopener"`));
    assert.match(body, new RegExp(`href="${BASE}/go/THREE_D\\?for=client"`));
    assert.doesNotMatch(body, /please contact your agent/);
  }
});

test('the full page gets a "Share downloads with your client" button as its LAST line, after the sign-off; it copies <origin>/<hub path>?for=client', () => {
  const html = renderHubPage(buildHubModel(ROW, PROJECT, GTOKEN), { base: BASE });
  assert.match(html, /<p class="sign-text">Thank you!<br>Franky<br>FranVision Media<\/p>\s*<img class="sign-img"[^>]*>\s*<\/footer>\s*<div class="mail-share"><button class="hub-share" id="hubShare"[^>]*>(<svg[\s\S]*?<\/svg>)?Share downloads with your client \(no prices\) 分享给客户（不含价格）<\/button><\/div>\s*<\/main>/);   // last line of the page, after the sign-off + signature
  assert.match(html, /location\.origin\+"\/deliver\/x\/c+"\+'\?for=client'/);
  assert.match(renderHubPage(buildHubModel({ ...ROW, paid: true }, PROJECT, GTOKEN), { base: BASE }), /id="hubShare"/);   // also once paid
});

// ---- Worker routing ----
function setup(over = {}) {
  const row = { ...ROW, ...over };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/delivery_hub')) return json(u.includes(`token=eq.${TOKEN}`) ? [row] : []);
    if (u.includes('/rest/v1/gallery_tokens')) return json([{ token: GTOKEN }]);
    if (u.includes('/rest/v1/projects')) return json([PROJECT]);
    return new Response('nf', { status: 404 });
  };
  return { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
}
const get = (env, path) => worker.fetch(new Request('https://realgta.ca' + path, { redirect: 'manual' }), env);

test('route: ?for=client serves the client view (also wins over ?pay=1); without it the full page; wrong token stays a plain 404', async () => {
  const env = setup();
  const client = await (await get(env, `${BASE}?for=client`)).text();
  assert.match(client, /please contact your agent/);
  assert.doesNotMatch(client, /Hello Jessie|\$113|hubModal/);
  assert.doesNotMatch(await (await get(env, `${BASE}?for=client&pay=1`)).text(), /hubModal|Invoice &amp; payment/);
  assert.match(await (await get(env, BASE)).text(), /Hello Jessie Tang/);
  assert.equal((await get(env, `/deliver/x/${'e'.repeat(32)}?for=client`)).status, 404);
});

test('route: /go/<KEY>?for=client -- locked never shows the pay dialog (client view instead); unlocked redirects as usual', async () => {
  const locked = await get(setup(), `${BASE}/go/MLS?for=client`);
  assert.equal(locked.status, 200);
  assert.equal(locked.headers.get('location'), null);
  const html = await locked.text();
  assert.doesNotMatch(html, /hubModal|Invoice &amp; payment|Pay by|\$113/);
  assert.doesNotMatch(html, /dropbox\.com/);
  const open = await get(setup({ paid: true }), `${BASE}/go/MLS?for=client`);
  assert.equal(open.status, 302);
  assert.equal(open.headers.get('location'), 'https://www.dropbox.com/scl/fo/mls');
  assert.match(await (await get(setup(), `${BASE}/go/MLS`)).text(), /hubModal/);           // without the parameter the priced page + dialog, as before
});
