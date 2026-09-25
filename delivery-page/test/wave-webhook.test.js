// Wave webhook: signature rules, event classification, and the Worker route end to end (fake Supabase).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { parseSignatureHeader, verifyWaveSignature, moneyToCents, classifyWaveEvent } from '../src/wave-webhook.js';

const SECRET = 'whsec_test';
const sign = (raw, t) => `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}`;
const nowSec = () => Math.floor(Date.now() / 1000);

test('parseSignatureHeader: t=..,v1=.. (tolerates spaces); junk -> empty', () => {
  assert.deepEqual(parseSignatureHeader('t=1714400000,v1=ABCdef'), { t: '1714400000', v1: 'abcdef' });
  assert.deepEqual(parseSignatureHeader('t=1714400000, v1=abc'), { t: '1714400000', v1: 'abc' });
  assert.deepEqual(parseSignatureHeader(''), { t: '', v1: '' });
  assert.deepEqual(parseSignatureHeader(null), { t: '', v1: '' });
});

test('verifyWaveSignature: correct HMAC over "<t>.<raw body>" passes; tampered body / wrong secret / stale or bad timestamp fail', async () => {
  const raw = '{"event_id":"e1","data":{"invoice_id":"2496756670638588934"}}';
  const t = nowSec();
  assert.equal(await verifyWaveSignature({ header: sign(raw, t), rawBody: raw, secret: SECRET }), true);
  assert.equal(await verifyWaveSignature({ header: sign(raw, t), rawBody: raw + ' ', secret: SECRET }), false);          // body changed
  assert.equal(await verifyWaveSignature({ header: sign(raw, t), rawBody: raw, secret: 'other' }), false);
  assert.equal(await verifyWaveSignature({ header: sign(raw, t - 400), rawBody: raw, secret: SECRET }), false);          // older than 5 min
  assert.equal(await verifyWaveSignature({ header: sign(raw, t + 400), rawBody: raw, secret: SECRET }), false);          // from the future
  assert.equal(await verifyWaveSignature({ header: sign(raw, t - 200), rawBody: raw, secret: SECRET }), true);           // inside the window
  assert.equal(await verifyWaveSignature({ header: 'nonsense', rawBody: raw, secret: SECRET }), false);
  assert.equal(await verifyWaveSignature({ header: sign(raw, t), rawBody: raw, secret: '' }), false);                     // no secret configured
});

test('moneyToCents: exact cents, thousands separators, junk -> null', () => {
  assert.equal(moneyToCents('8.98'), 898);
  assert.equal(moneyToCents('1,695.00'), 169500);
  assert.equal(moneyToCents('0.00'), 0);
  assert.equal(moneyToCents('30'), 3000);
  for (const bad of [null, '', 'abc', '1.234']) assert.equal(moneyToCents(bad), null);
});

const ev = (type, data) => ({ event_id: 'e', event_type: type, business_id: 'b', data: { invoice_id: '2619579987556152644', amount_paid: '113.00', remaining_balance: '0.00', paid_date: '2026-09-25', ...data } });

test('classifyWaveEvent: full payment = paid; partial (event, or a "paid" event that still owes money) = partial; everything else ignored', () => {
  assert.equal(classifyWaveEvent(ev('invoice.paid')).kind, 'paid');
  assert.equal(classifyWaveEvent(ev('invoice.overpaid', { remaining_balance: '0.00' })).kind, 'paid');
  assert.equal(classifyWaveEvent(ev('invoice.partially_paid', { amount_paid: '50.00', remaining_balance: '63.00' })).kind, 'partial');
  assert.equal(classifyWaveEvent(ev('invoice.paid', { remaining_balance: '10.00' })).kind, 'partial');   // believe the payload's own balance
  for (const t of ['invoice.sent', 'invoice.viewed', 'invoice.approved', 'invoice.overdue', 'estimate.paid']) assert.equal(classifyWaveEvent(ev(t)).kind, 'ignore');
  assert.equal(classifyWaveEvent(ev('invoice.paid', { invoice_id: 'junk' })).kind, 'ignore');
  const c = classifyWaveEvent(ev('invoice.partially_paid', { amount_paid: '50.00', remaining_balance: '63.00' }));
  assert.deepEqual([c.invoiceId, c.paidCents, c.remainingCents], ['2619579987556152644', 5000, 6300]);   // id stays a string
});

// ---- Worker route ----
const JOB = 'FVS-20260925-001';
const TOKEN = 'c'.repeat(32);
function setup(hubOver = {}) {
  const state = {
    hub: { job_id: JOB, token: TOKEN, paid: false, unlocked: false, paid_source: null, wave_invoice_id: '2619579987556152644', wave_paid_cents: null, wave_remaining_cents: null, lines: [], ...hubOver },
    events: new Map(),
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rest/v1/wave_events')) {
      if (init.method === 'POST') {
        const b = JSON.parse(init.body);
        if (state.events.has(b.event_id)) return json([]);
        state.events.set(b.event_id, { ...b });
        return json([b], 201);
      }
      if (init.method === 'PATCH') {
        const id = /event_id=eq\.([^&]+)/.exec(u)[1];
        Object.assign(state.events.get(decodeURIComponent(id)), JSON.parse(init.body));
        return new Response('', { status: 200 });
      }
    }
    if (u.includes('/rest/v1/delivery_hub')) {
      if (init.method === 'PATCH') {
        if (!u.includes(`job_id=eq.${JOB}`)) return json([]);
        Object.assign(state.hub, JSON.parse(init.body));
        return json([state.hub]);
      }
      if (u.includes('wave_invoice_id=eq.')) return json(u.includes(`wave_invoice_id=eq.${state.hub.wave_invoice_id}`) ? [state.hub] : []);
      if (u.includes('select=job_id,token,paid,unlocked')) return json([state.hub]);
      if (u.includes(`job_id=eq.${JOB}`) || u.includes(`token=eq.${TOKEN}`)) return json([state.hub]);
      return json([]);
    }
    if (u.includes('/rest/v1/gallery_tokens')) return json([]);
    if (u.includes('/rest/v1/projects')) return json([{ id: JOB, data: { address: '12 Main St, Toronto' }, updated_at: '2026-09-25T10:00:00Z' }]);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', ADMIN_TOKEN: 'adm', WAVE_WEBHOOK_SECRET: SECRET }, state };
}
const hook = (env, evt, { header, raw } = {}) => {
  const body = raw ?? JSON.stringify(evt);
  return worker.fetch(new Request('https://realgta.ca/webhooks/wave', { method: 'POST', headers: { 'x-wave-signature': header ?? sign(body, nowSec()), 'content-type': 'application/json' }, body }), env);
};
const wave = (id, type, data) => ({ event_id: id, event_type: type, business_id: 'biz', data: { invoice_id: '2619579987556152644', customer_id: '1', currency_code: 'CAD', paid_date: '2026-09-25', amount_paid: '113.00', remaining_balance: '0.00', ...data } });

test('webhook: bad / missing signature -> 401 and nothing is written; no secret configured yet -> 200 and nothing happens', async () => {
  const { env, state } = setup();
  assert.equal((await hook(env, wave('e1', 'invoice.paid'), { header: 't=1,v1=00' })).status, 401);
  assert.equal((await hook(env, wave('e1', 'invoice.paid'), { header: '' })).status, 401);
  assert.equal(state.events.size, 0);
  assert.equal(state.hub.paid, false);
  // no secret configured yet (Wave validates the URL BEFORE it shows the secret): 200 and nothing is recorded
  const before = await hook({ ...env, WAVE_WEBHOOK_SECRET: '' }, wave('e1', 'invoice.paid'));
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { ok: true, configured: false });
  assert.equal(state.events.size, 0);
  assert.equal(state.hub.paid, false);
  // reachability check
  const ping = await worker.fetch(new Request('https://realgta.ca/webhooks/wave'), env);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { ok: true, service: 'wave-webhook' });   // not swallowed by the /<address-slug>/<jobId> route
});

test('webhook: invoice.paid for a Job\'s invoice -> paid, source wave; the hub unlocks; the event is logged once', async () => {
  const { env, state } = setup();
  const res = await hook(env, wave('e1', 'invoice.paid'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, result: 'paid' });
  assert.equal(state.hub.paid, true);
  assert.equal(state.hub.paid_source, 'wave');
  assert.equal(state.hub.wave_paid_cents, 11300);
  assert.equal(state.hub.wave_remaining_cents, 0);
  assert.equal(state.events.get('e1').result, 'paid');
  assert.equal(state.events.get('e1').job_id, JOB);
  const status = await (await worker.fetch(new Request(`https://realgta.ca/deliver/x/${TOKEN}/status`), env)).json();
  assert.deepEqual(status, { unlocked: true, paid: true, remainingCents: null });
});

test('webhook: PARTIAL payment does not unlock -- it only records what was paid / is still owed', async () => {
  const { env, state } = setup();
  const res = await hook(env, wave('e2', 'invoice.partially_paid', { amount_paid: '50.00', remaining_balance: '63.00' }));
  assert.deepEqual(await res.json(), { ok: true, result: 'partial' });
  assert.equal(state.hub.paid, false);
  assert.equal(state.hub.wave_paid_cents, 5000);
  assert.equal(state.hub.wave_remaining_cents, 6300);
  const admin = await (await worker.fetch(new Request('https://realgta.ca/admin?admin=adm'), env)).text();
  assert.match(admin, /部分付款 Partial: 已付 \$50\.00, 还差 \$63\.00/);
  assert.doesNotMatch(admin, /data-flag="paid" checked/);
  // ...and the rest of the money arriving later finishes it
  await hook(env, wave('e3', 'invoice.paid', { amount_paid: '63.00', remaining_balance: '0.00' }));
  assert.equal(state.hub.paid, true);
});

test('webhook: a redelivered event is a no-op; unmatched invoice and ignored event types still answer 200 (Wave must not retry)', async () => {
  const { env, state } = setup();
  await hook(env, wave('e1', 'invoice.paid'));
  state.hub.paid = false;                                           // if the duplicate were processed it would flip back
  assert.deepEqual(await (await hook(env, wave('e1', 'invoice.paid'))).json(), { ok: true, duplicate: true });
  assert.equal(state.hub.paid, false);
  const stranger = await hook(env, wave('e4', 'invoice.paid', { invoice_id: '1111111111111111111' }));
  assert.deepEqual(await stranger.json(), { ok: true, result: 'no matching job' });
  assert.equal(state.events.get('e4').result, 'no matching job');    // kept for review
  assert.deepEqual(await (await hook(env, wave('e5', 'invoice.viewed'))).json(), { ok: true, result: 'ignored' });
  assert.equal((await hook(env, null, { raw: 'not json', header: sign('not json', nowSec()) })).status, 400);
});

test('admin: a Wave-paid Job shows a greyed, disabled, ticked Paid; it cannot be unticked (409); a manual tick can, and records source manual', async () => {
  const { env, state } = setup();
  await hook(env, wave('e1', 'invoice.paid'));
  const html = await (await worker.fetch(new Request('https://realgta.ca/admin?admin=adm'), env)).text();
  assert.match(html, /class="sw is-wave"[^>]*><input type="checkbox" data-hub="FVS-20260925-001" data-flag="paid" checked disabled>/);
  const un = await worker.fetch(new Request(`https://realgta.ca/admin/hub/${JOB}`, { method: 'POST', headers: { authorization: 'Bearer adm', 'content-type': 'application/json' }, body: JSON.stringify({ paid: false }) }), env);
  assert.equal(un.status, 409);
  assert.equal(state.hub.paid, true);
  assert.equal(state.hub.paid_source, 'wave');

  const { env: env2, state: st2 } = setup();
  const tick = (b) => worker.fetch(new Request(`https://realgta.ca/admin/hub/${JOB}`, { method: 'POST', headers: { authorization: 'Bearer adm', 'content-type': 'application/json' }, body: JSON.stringify(b) }), env2);
  assert.equal((await tick({ paid: true })).status, 200);
  assert.equal(st2.hub.paid_source, 'manual');
  const manual = await (await worker.fetch(new Request('https://realgta.ca/admin?admin=adm'), env2)).text();
  assert.match(manual, /data-flag="paid" checked>/);                 // ticked and still editable
  assert.equal((await tick({ paid: false })).status, 200);
  assert.equal(st2.hub.paid, false);
  assert.equal(st2.hub.paid_source, null);
});
