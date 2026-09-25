// Pure Delivery Hub logic (src/hub.js): model, target resolution, and the lock gate in the HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHubToken, hubPath, buildHubModel, resolveTarget, isUnlocked, renderHubPage } from '../src/hub.js';

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
  assert.match(html, /\$113\.00/);
  assert.match(html, /frankystudio@mail\.com/);
  assert.doesNotMatch(html, /dropbox\.com/);
  assert.doesNotMatch(html, /matterport/);
  assert.doesNotMatch(html, /\/go\//);              // not even the gate URLs
  assert.doesNotMatch(html, new RegExp(GTOKEN));    // nor the Gallery token
  assert.match(html, /href="\/FVS-20260925-001|href="\/12-main-st-toronto\/FVS-20260925-001/);  // the free All in One preview
});

test('unlocked page: real links through /go/<KEY>, no dialog; not-ready item is disabled, not a link', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, paid: true }, PROJECT, GTOKEN), { base: '/deliver/x/' + ROW.token });
  assert.match(html, new RegExp(`href="/deliver/x/${ROW.token}/go/MLS"`));
  assert.match(html, new RegExp(`href="/deliver/x/${ROW.token}/go/HDR"`));
  assert.doesNotMatch(html, /Please pay to unlock|class="hub-btn is-locked"|id="hubModal"/);
  assert.doesNotMatch(html, /dropbox\.com/);
  assert.doesNotMatch(html, /go\/LOCAL_REPORT/);
  assert.match(html, /Preparing/);
});

test('pay dialog without a Wave link still explains e-Transfer and shows no Pay now button; escapes address', () => {
  const html = renderHubPage(buildHubModel({ ...ROW, wave_view_url: null, total_cents: null }, { data: { address: '<b>1</b> St' } }, GTOKEN), { base: '/deliver/x/y' });
  assert.doesNotMatch(html, /Pay now/);
  assert.doesNotMatch(html, /Total 应付/);
  assert.match(html, /frankystudio@mail\.com/);
  assert.doesNotMatch(html, /<b>1<\/b>/);
  assert.match(html, /&lt;b&gt;1&lt;\/b&gt; St/);
});
