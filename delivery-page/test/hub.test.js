// Pure Delivery Hub logic (src/hub.js): model, target resolution, and the lock gate in the HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHubToken, hubPath, buildHubModel, resolveTarget, isUnlocked, remainingCents, renderHubPage } from '../src/hub.js';

const ROW = {
  job_id: 'FVS-20260925-001',
  token: 'a'.repeat(32),
  lines: [
    { key: 'HDR' },
    { key: 'MLS', url: 'https://www.dropbox.com/scl/fo/mls' },
    { key: 'VIDEO', url: 'https://www.dropbox.com/scl/fo/video' },
    { key: 'THREE_D' },
    { key: 'LOCAL_REPORT', url: 'javascript:alert(1)' },   // never a safe target
  ],
  wave_view_url: 'https://next.waveapps.com/pay/abc',
  total_cents: 11300,
  paid: false,
  unlocked: false,
};
const PROJECT = { id: ROW.job_id, data: { address: '12 Main St, Toronto', tourUrl: 'https://my.matterport.com/show/?m=x' } };
const GTOKEN = 'b'.repeat(32);

test('token shape + path: 32 hex only; slug is cosmetic, empty address falls back', () => {
  assert.equal(isHubToken('a'.repeat(32)), true);
  for (const bad of ['FVS-20260925-001', 'a'.repeat(31), 'A'.repeat(32), '', undefined, 'a'.repeat(32) + '/x']) assert.equal(isHubToken(bad), false);
  assert.equal(hubPath('12 Main St, Toronto', 'a'.repeat(32)), `/deliver/12-main-st-toronto/${'a'.repeat(32)}`);
  assert.equal(hubPath('', 'a'.repeat(32)), `/deliver/delivery/${'a'.repeat(32)}`);
});

test('buildHubModel: buttons follow the email order, only lines that were stored, readiness per target', () => {
  const m = buildHubModel(ROW, PROJECT, GTOKEN);
  assert.deepEqual(m.lines.map((l) => l.key), ['HDR', 'MLS', 'VIDEO', 'THREE_D', 'LOCAL_REPORT']);
  const ready = Object.fromEntries(m.lines.map((l) => [l.key, l.ready]));
  assert.deepEqual(ready, { HDR: true, MLS: true, VIDEO: true, THREE_D: true, LOCAL_REPORT: false });  // unsafe scheme = not ready
  assert.equal(m.unlocked, false);
  assert.equal(m.totalCents, 11300);
  assert.equal(m.address, '12 Main St, Toronto');
  // HDR needs a Gallery token; THREE_D needs a tourUrl
  const n = buildHubModel(ROW, { data: {} }, null);
  assert.equal(n.lines.find((l) => l.key === 'HDR').ready, false);
  assert.equal(n.lines.find((l) => l.key === 'THREE_D').ready, false);
});

test('resolveTarget: HDR -> Gallery page, THREE_D -> tourUrl, others -> stored link; null when not ready / unknown', () => {
  assert.equal(resolveTarget('HDR', ROW, PROJECT, GTOKEN), `/delivery/12-main-st-toronto/${GTOKEN}`);
  assert.equal(resolveTarget('HDR', ROW, PROJECT, null), null);
  assert.equal(resolveTarget('THREE_D', ROW, PROJECT, GTOKEN), 'https://my.matterport.com/show/?m=x');
  assert.equal(resolveTarget('MLS', ROW, PROJECT, GTOKEN), 'https://www.dropbox.com/scl/fo/mls');
  assert.equal(resolveTarget('LOCAL_REPORT', ROW, PROJECT, GTOKEN), null);
  assert.equal(resolveTarget('HOME_REPORT', ROW, PROJECT, GTOKEN), null);   // not one of this Job's lines
  assert.equal(resolveTarget('NOPE', ROW, PROJECT, GTOKEN), null);
});

test('isUnlocked: paid OR unlocked', () => {
  assert.equal(isUnlocked({ paid: false, unlocked: false }), false);
  assert.equal(isUnlocked({ paid: true }), true);
  assert.equal(isUnlocked({ unlocked: true }), true);
  assert.equal(isUnlocked(null), false);
});

test('locked page: lock buttons + dialog with Pay now, and NO target anywhere in the HTML', () => {
  const html = renderHubPage(buildHubModel(ROW, PROJECT, GTOKEN), { base: '/deliver/x/' + ROW.token });
  assert.equal((html.match(/is-locked/g) || []).length >= 5, true);
  assert.match(html, /Please pay to unlock/);
  assert.match(html, /href="https:\/\/next\.waveapps\.com\/pay\/abc"/);
  assert.match(html, /Pay by credit card/);
  assert.match(html, /Pay by e-Transfer/);
  assert.match(html, /\$113\.00/);
  assert.match(html, /frankystudio@mail\.com/);   // inside the e-Transfer panel
  assert.doesNotMatch(html, /dropbox\.com/);
  assert.doesNotMatch(html, /matterport/);
  assert.doesNotMatch(html, /\/go\//);              // not even the gate URLs
  assert.doesNotMatch(html, new RegExp(GTOKEN));    // nor the Gallery token
  assert.match(html, /href="\/FVS-20260925-001|href="\/12-main-st-toronto\/FVS-20260925-001/);  // the free All in One preview
});

test('unlocked page: real links through /go/<KEY>, no dialog; not-ready item is disabled, not a link', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, paid: true }, PROJECT, GTOKEN), { base: '/deliver/x/' + ROW.token });
  assert.match(html, new RegExp(`href="/deliver/x/${ROW.token}/go/MLS" target="_blank" rel="noopener"`));   // opens in a new tab, the hub stays put
  assert.match(html, new RegExp(`href="/deliver/x/${ROW.token}/go/HDR"`));
  assert.doesNotMatch(html, /Please pay to unlock|class="hub-btn is-locked"|id="hubModal"/);
  assert.doesNotMatch(html, /dropbox\.com/);
  assert.doesNotMatch(html, /go\/LOCAL_REPORT/);
  assert.match(html, /Preparing/);
});

test('pay dialog without a Wave link offers only e-Transfer (no credit-card button, no amount); escapes address', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, wave_view_url: null, total_cents: null }, { data: { address: '<b>1</b> St' } }, GTOKEN), { base: '/deliver/x/y' });
  assert.doesNotMatch(html, /id="hubCard"/);   // no credit-card button
  assert.match(html, /Pay by e-Transfer/);
  assert.doesNotMatch(html, /hub-fee">\$/);
  assert.match(html, /frankystudio@mail\.com/);
  assert.doesNotMatch(html, /<b>1<\/b>/);
  assert.match(html, /&lt;b&gt;1&lt;\/b&gt; St/);
});

test('interactive-email page: greeting + "photos are ready" + fee line + Pay now / Print invoice at the top, sign-off at the bottom', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, pretax_cents: 10000, client_name: 'Jessie Tang' }, PROJECT, GTOKEN), { base: '/deliver/x/' + ROW.token });
  assert.match(html, /Hello Jessie Tang,/);
  assert.match(html, /Your photos for <strong>12 Main St, Toronto<\/strong> are ready/);
  assert.match(html, /12 Main St, Toronto 的照片已经制作完成/);
  assert.match(html, /Fee 费用: <strong>\$100 \+ HST = \$113\.00<\/strong>/);   // whole dollars, like the email
  assert.match(html, /id="hubPayNow" href="https:\/\/next\.waveapps\.com\/pay\/abc" target="_blank" rel="noopener">Pay now \/ Invoice/);   // ONE blue button -> the Wave invoice page
  assert.doesNotMatch(html, /Print invoice/);
  assert.match(html, /id="hubEmtLink"/);                                            // Wave's page has no Interac e-Transfer
  assert.ok(html.indexOf('id="hubPayNow"') < html.indexOf('class="hub-list"'), 'the button sits above the download buttons');
  assert.match(html, /Thank you!<br>Franky<br>FranVision Media/);
  assert.match(html, /24 hours/);                                                  // Video's note (VIDEO is one of ROW's lines)
});

test('interactive-email page: cents in the pre-tax amount are kept; no name -> plain "Hello,"; no Wave invoice -> Pay now opens the dialog, no e-Transfer side link', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, wave_view_url: null, pretax_cents: 9885, total_cents: 11170 }, PROJECT, GTOKEN), { base: '/deliver/x/y' });
  assert.match(html, /Hello,/);
  assert.match(html, /\$98\.85 \+ HST = \$111\.70/);
  assert.match(html, /<button class="hub-cta" id="hubPayNow" type="button">Pay now/);
  assert.doesNotMatch(html, /id="hubEmtLink"/);
});

test('interactive-email page: once paid, the same button stays (now "Invoice (Paid)", green) so the paid invoice can be downloaded; no e-Transfer link; copy says the files are ready', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, paid: true }, PROJECT, GTOKEN), { base: '/deliver/x/y' });
  assert.match(html, /class="hub-cta is-paid" id="hubPayNow" href="https:\/\/next\.waveapps\.com\/pay\/abc" target="_blank" rel="noopener">Invoice \(Paid\)/);
  assert.doesNotMatch(html, /id="hubEmtLink"/);
  assert.match(html, /Payment received/);
  assert.doesNotMatch(html, /complete payment first/);
});

test('3D Tour button follows Tour Link.txt (projects.data.tourUrl): first line only, BOM/blank lines/CRLF tolerated, non-URLs rejected', () => {
  const target = (tourUrl) => resolveTarget('THREE_D', ROW, { data: { tourUrl } }, GTOKEN);
  assert.equal(target('https://my.matterport.com/show/?m=abc'), 'https://my.matterport.com/show/?m=abc');
  assert.equal(target('﻿https://my.matterport.com/show/?m=abc\r\n'), 'https://my.matterport.com/show/?m=abc');            // Windows Notepad BOM + CRLF
  assert.equal(target('\n\n  https://tour.example.com/x  \nnote: floor tour\n'), 'https://tour.example.com/x');                  // extra lines under the link
  for (const bad of ['', '   ', null, undefined, 'my.matterport.com/show', 'javascript:alert(1)', 'https://a b.com', 'see attached']) assert.equal(target(bad), null);
  // the button is "ready" exactly when there is a usable link
  const ready = (tourUrl) => buildHubModel(ROW, { data: { tourUrl } }, GTOKEN).lines.find((l) => l.key === 'THREE_D').ready;
  assert.equal(ready('https://tour.example.com/x'), true);
  assert.equal(ready(''), false);
});

test('partial payment (safety net): the page shows what came in and what is still owed, and the pay dialog asks for the remainder; no partial -> nothing extra', () => {
  const partialRow = { ...ROW, pretax_cents: 10000, wave_paid_cents: 5000, wave_remaining_cents: 6300 };
  assert.equal(remainingCents(partialRow), 6300);
  assert.equal(remainingCents({ ...partialRow, paid: true }), null);          // paid: nothing owed
  assert.equal(remainingCents({ ...partialRow, unlocked: true }), null);      // unlocked: nothing to show
  assert.equal(remainingCents({ ...ROW, wave_remaining_cents: 0 }), null);
  const html = renderHubPage(buildHubModel(partialRow, PROJECT, GTOKEN), { base: '/deliver/x/y' });
  assert.match(html, /Partial payment received \(\$50\.00\) — <strong>\$63\.00 still owed<\/strong>/);
  assert.match(html, /还需支付 <strong>\$63\.00<\/strong>/);
  assert.match(html, /hub-fee">\$63\.00 <span>remaining/);                     // dialog: the remainder, not the $113 total again
  assert.match(html, /class="hub-btn is-locked"/);                              // still locked
  const plain = renderHubPage(buildHubModel({ ...ROW, pretax_cents: 10000 }, PROJECT, GTOKEN), { base: '/deliver/x/y' });
  assert.doesNotMatch(plain, /Partial payment received|still owed/);
  assert.match(plain, /hub-fee">\$113\.00 <span>incl\. HST/);
});
