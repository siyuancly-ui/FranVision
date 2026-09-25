// The invoice page (/invoice) and the PDF served through the Worker (/invoice.pdf), Wave's PDF host faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { pdfSourceUrl, buildHubModel, renderHubPage, renderInvoicePage } from '../src/hub.js';

const JOB = 'FVS-20260925-001';
const TOKEN = 'c'.repeat(32);
const PDF_URL = 'https://accounting.waveapps.com/invoices/biz/export/123/abc?pdf=1';
const PROJECT = { id: JOB, data: { address: '12 Main St, Toronto' }, updated_at: '2026-09-25T10:00:00Z' };

function setup({ pdf = PDF_URL, paid = false, upstream } = {}) {
  const calls = [];
  const row = { job_id: JOB, token: TOKEN, paid, unlocked: false, wave_pdf_url: pdf, wave_view_url: 'https://link.waveapps.com/x', total_cents: 5650, lines: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://accounting.waveapps.com/')) return upstream ? upstream() : new Response('%PDF-1.4 fake', { status: 200, headers: { 'content-type': 'application/pdf; charset=utf-8' } });
    if (u.includes('/rest/v1/delivery_hub')) return json(u.includes(`token=eq.${TOKEN}`) ? [row] : []);
    if (u.includes('/rest/v1/gallery_tokens')) return json([]);
    if (u.includes('/rest/v1/projects')) return json([PROJECT]);
    return new Response('nf', { status: 404 });
  };
  return { env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }, calls };
}
const get = (env, path) => worker.fetch(new Request('https://realgta.ca' + path), env);

test('pdfSourceUrl: https on accounting.waveapps.com only', () => {
  assert.equal(pdfSourceUrl({ wave_pdf_url: PDF_URL }), PDF_URL);
  for (const bad of ['http://accounting.waveapps.com/x.pdf', 'https://evil.example.com/x.pdf', 'https://accounting.waveapps.com.evil.com/x', 'javascript:alert(1)', '', null, 'https://link.waveapps.com/x']) {
    assert.equal(pdfSourceUrl({ wave_pdf_url: bad }), '', String(bad));
  }
});

test('invoice page: shows the PDF in a frame with a Download button, a way back, and "Ready to pay" while unpaid', async () => {
  const { env } = setup();
  const res = await get(env, `/deliver/x/${TOKEN}/invoice`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, new RegExp(`<iframe class="inv-frame" title="Invoice" src="/deliver/x/${TOKEN}/invoice\\.pdf#view=FitH"`));
  assert.match(html, new RegExp(`href="/deliver/x/${TOKEN}/invoice\\.pdf\\?download=1">Download PDF 下载`));
  assert.match(html, new RegExp(`href="/deliver/x/${TOKEN}">&larr; Back`));
  assert.match(html, new RegExp(`href="/deliver/x/${TOKEN}\\?pay=1">Ready to pay`));
  assert.doesNotMatch(html, /accounting\.waveapps\.com/);                       // the Wave URL never reaches the browser
  assert.doesNotMatch(await (await get(setup({ paid: true }).env, `/deliver/x/${TOKEN}/invoice`)).text(), /Ready to pay/);
});

test('invoice.pdf: streamed through the Worker -- inline for the frame, attachment with ?download=1; never cached; named after the address', async () => {
  const { env, calls } = setup();
  const inline = await get(env, `/deliver/x/${TOKEN}/invoice.pdf`);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.equal(inline.headers.get('cache-control'), 'no-store');
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="Invoice - 12 Main St, Toronto\.pdf"/);
  assert.equal(await inline.text(), '%PDF-1.4 fake');
  assert.ok(calls.includes(PDF_URL), 'fetched from the stored Wave PDF link');
  const dl = await get(env, `/deliver/x/${TOKEN}/invoice.pdf?download=1`);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="Invoice - 12 Main St, Toronto\.pdf"/);
});

test('invoice.pdf / invoice: unknown token -> 404 without touching Wave; no usable PDF link -> not-ready page; Wave failing -> friendly 502', async () => {
  const { env, calls } = setup();
  assert.equal((await get(env, `/deliver/x/${'e'.repeat(32)}/invoice.pdf`)).status, 404);
  assert.equal(calls.some((u) => u.startsWith('https://accounting.waveapps.com/')), false);
  const none = setup({ pdf: 'https://evil.example.com/x.pdf' });
  assert.equal((await get(none.env, `/deliver/x/${TOKEN}/invoice`)).status, 404);
  assert.equal((await get(none.env, `/deliver/x/${TOKEN}/invoice.pdf`)).status, 404);
  assert.equal(none.calls.some((u) => u.startsWith('https://evil.example.com')), false);
  const down = setup({ upstream: () => new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  const bad = await get(down.env, `/deliver/x/${TOKEN}/invoice.pdf`);
  assert.equal(bad.status, 502);
  assert.match(await bad.text(), /isn't ready yet/);
});

test('dialog "View invoice" opens our invoice page (not a raw download) when we hold the PDF link; falls back to Wave\'s page otherwise; ?pay=1 opens the dialog', async () => {
  const withPdf = renderHubPage(buildHubModel({ job_id: JOB, wave_pdf_url: PDF_URL, wave_view_url: 'https://link.waveapps.com/x', lines: [] }, PROJECT, null), { base: '/deliver/x/y' });
  assert.match(withPdf, /class="hub-pay is-ghost" href="\/deliver\/x\/y\/invoice" target="_blank"/);
  const noPdf = renderHubPage(buildHubModel({ job_id: JOB, wave_view_url: 'https://link.waveapps.com/x', lines: [] }, PROJECT, null), { base: '/deliver/x/y' });
  assert.match(noPdf, /class="hub-pay is-ghost" href="https:\/\/link\.waveapps\.com\/x"/);
  const { env } = setup();
  assert.match(await (await get(env, `/deliver/x/${TOKEN}?pay=1`)).text(), /open\(\);/);
  assert.doesNotMatch(await (await get(env, `/deliver/x/${TOKEN}`)).text(), /open\(\);\n/);
  assert.match(renderInvoicePage(buildHubModel({ job_id: JOB, lines: [] }, PROJECT, null), { base: '/deliver/x/y' }), /Invoice — 12 Main St, Toronto/);
});
