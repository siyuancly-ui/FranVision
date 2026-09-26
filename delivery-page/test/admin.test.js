import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminModel, renderAdminPage } from '../src/admin.js';

function row(id, over = {}) {
  return { id, data: {}, updated_at: '2026-09-17T12:00:00Z', ...over };
}

test('buildAdminModel: empty rows -> empty jobs list', () => {
  assert.deepEqual(buildAdminModel([]), { jobs: [] });
  assert.deepEqual(buildAdminModel(null), { jobs: [] });
});

test('buildAdminModel: pulls address/agents/photoCount/hasVideo/hasTour off each row', () => {
  const rows = [
    row('FVS-1', {
      data: {
        address: '48 Red Ash Dr',
        agentInfo: { name: 'Jane Doe' },
        agentInfo2: { name: 'John Roe' },
        photos: [{ status: 'ok' }, { status: 'ok' }, { status: 'pending_review' }],
        videos: [{ videoId: 'v1' }],
        tourUrl: 'https://my.matterport.com/show/?m=abc',
      },
    }),
    row('FVS-2', { data: {} }), // bare job, nothing synced yet
  ];
  const model = buildAdminModel(rows);
  assert.equal(model.jobs.length, 2);
  assert.deepEqual(model.jobs[0], {
    jobId: 'FVS-1', address: '48 Red Ash Dr', agents: ['Jane Doe', 'John Roe'],
    photoCount: 2, hasVideo: true, hasTour: true, updatedAt: '2026-09-17T12:00:00Z', galleryToken: null, hub: null,
  });
  assert.deepEqual(model.jobs[1], {
    jobId: 'FVS-2', address: null, agents: [], photoCount: 0, hasVideo: false, hasTour: false, updatedAt: '2026-09-17T12:00:00Z', galleryToken: null, hub: null,
  });
});

test('buildAdminModel: a whitespace-only address/tourUrl/agent name counts as absent', () => {
  const model = buildAdminModel([row('FVS-1', {
    data: { address: '   ', tourUrl: '  ', agentInfo: { name: '  ' } },
  })]);
  assert.equal(model.jobs[0].address, null);
  assert.equal(model.jobs[0].hasTour, false);
  assert.deepEqual(model.jobs[0].agents, []);
});

test('buildAdminModel: only agentInfo2 (no primary) still counts as one agent', () => {
  const model = buildAdminModel([row('FVS-1', { data: { agentInfo2: { name: 'Solo Agent' } } })]);
  assert.deepEqual(model.jobs[0].agents, ['Solo Agent']);
});

test('buildAdminModel: sorts by primary agent first name A-Z, no-agent jobs sink to the bottom', () => {
  const rows = [
    row('FVS-none', { data: {} }),
    row('FVS-zed', { data: { agentInfo: { name: 'Zed Zephyr' } } }),
    row('FVS-amy', { data: { agentInfo: { name: 'Amy Adams' } } }),
  ];
  const model = buildAdminModel(rows);
  assert.deepEqual(model.jobs.map((j) => j.jobId), ['FVS-amy', 'FVS-zed', 'FVS-none']);
});

test('buildAdminModel: same agent first name -> newest-updated first', () => {
  const rows = [
    row('FVS-old', { data: { agentInfo: { name: 'Amy Adams' } }, updated_at: '2026-09-01T00:00:00Z' }),
    row('FVS-new', { data: { agentInfo: { name: 'Amy Anderson' } }, updated_at: '2026-09-15T00:00:00Z' }),
  ];
  const model = buildAdminModel(rows);
  assert.deepEqual(model.jobs.map((j) => j.jobId), ['FVS-new', 'FVS-old']);
});

test('renderAdminPage: lists every job with its delivery-page link and agent', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '48 Red Ash Dr', agentInfo: { name: 'Jane Doe' } } })]);
  const out = renderAdminPage(model);
  assert.ok(out.includes('href="/48-red-ash-dr/FVS-1"'));
  assert.ok(out.includes('48 Red Ash Dr'));
  assert.ok(out.includes('Jane Doe'));
  assert.ok(out.includes('1 job'));
});

test('renderAdminPage: the only copy-link button is the Delivery (hub) one, carrying the full absolute URL', () => {
  const HTOK = 'c'.repeat(32);
  const model = buildAdminModel([row('FVS-1', { data: {} })], {}, { 'FVS-1': { token: HTOK, paid: false, unlocked: false } });
  const out = renderAdminPage(model, { origin: 'https://real.gta3d.ca' });
  assert.ok(out.includes(`data-link="https://real.gta3d.ca/deliver/delivery/${HTOK}"`));
  assert.ok(out.includes('Copy link 复制链接'));
  assert.equal((out.match(/data-link=/g) || []).length, 1);                        // not for All in One, not for Gallery
  assert.ok(!out.includes('data-link="https://real.gta3d.ca/delivery/FVS-1"'));
});

const TOK = '8779efe254f329f0766d73328550ae62';

test('buildAdminModel: attaches each Job\'s gallery token (null when it has none yet)', () => {
  const model = buildAdminModel([row('FVS-1', { data: {} }), row('FVS-2', { data: {} })], { 'FVS-1': TOK });
  assert.equal(model.jobs.find((j) => j.jobId === 'FVS-1').galleryToken, TOK);
  assert.equal(model.jobs.find((j) => j.jobId === 'FVS-2').galleryToken, null);
});

test('renderAdminPage: All in One and Gallery are two columns with an Open link only (no copy buttons); Photos/Video/Tour columns are gone', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '12 Main St, Toronto', photos: [{ status: 'ok' }], videos: [{}], tourUrl: 'https://t.example/x' } })], { 'FVS-1': TOK });
  const out = renderAdminPage(model, { origin: 'https://realgta.ca' });
  assert.ok(out.includes('<th>All in One</th><th>Gallery</th>'));
  assert.ok(out.includes('class="open-link" href="/12-main-st-toronto/FVS-1"'));
  assert.ok(out.includes(`class="open-link" href="/delivery/12-main-st-toronto/${TOK}"`));
  assert.ok(!out.includes('data-link='));                                          // no copy button anywhere (no hub row here)
  assert.ok(!out.includes('open-link is-off'));                                     // both Open links active
  assert.ok(!/Photos 照片|Video 视频|Tour 全景/.test(out));
  assert.deepEqual(out.match(/<th>[^<]*<\/th>/g).map((t) => t.replace(/<\/?th>/g, '')), ['Address 地址', 'Agent 经纪', 'Updated 更新时间', 'All in One', 'Gallery', 'Delivery 交付页', 'Payment 付款']);
});

test('renderAdminPage: a Job whose gallery token is unreachable shows a greyed-out Open with nothing to click; nothing ever creates a link', () => {
  const out = renderAdminPage(buildAdminModel([row('FVS-1', { data: { address: '1 A St' } })]), { origin: 'https://realgta.ca' });
  assert.ok(!/Create link|create-btn/.test(out));
  assert.ok(/class="open-link is-off" aria-disabled="true"/.test(out));
  assert.ok(!/is-off"[^>]*href/.test(out));
  assert.ok(!out.includes('data-link='));
});

test('buildAdminModel: Job Generator\'s Client Name fills the Agent column (FSB agentInfo is only the fallback), and sorting/search use it', () => {
  const rows = [
    row('FVS-1', { data: { address: 'A', agentInfo: { name: 'Zed FromFsb' } } }),
    row('FVS-2', { data: { address: 'B' } }),
    row('FVS-3', { data: { address: 'C', agentInfo: { name: 'Fallback Person' } } }),
  ];
  const model = buildAdminModel(rows, {}, {}, { 'FVS-1': '  Amy Client ', 'FVS-2': 'Ben Client', 'FVS-9': 'Not a listed job', 'FVS-3': '   ' });
  const by = Object.fromEntries(model.jobs.map((j) => [j.jobId, j.agents]));
  assert.deepEqual(by, { 'FVS-1': ['Amy Client'], 'FVS-2': ['Ben Client'], 'FVS-3': ['Fallback Person'] });   // client name wins; blank -> fallback
  assert.deepEqual(model.jobs.map((j) => j.jobId), ['FVS-1', 'FVS-2', 'FVS-3']);                            // amy, ben, fallback
  const out = renderAdminPage(model);
  assert.ok(out.includes('<td class="agent">Amy Client</td>'));
  assert.ok(out.includes('data-search="a fvs-1 amy client"'));
});

test('renderAdminPage: escapes address and agent content', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '<script>alert(1)</script>', agentInfo: { name: '<b>x</b>' } } })]);
  const out = renderAdminPage(model);
  assert.ok(!out.includes('<script>alert(1)</script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<b>x</b>'));
});

test('renderAdminPage: empty state when there are no jobs at all', () => {
  const out = renderAdminPage(buildAdminModel([]));
  assert.ok(out.includes('No jobs yet'));
  assert.ok(out.includes('0 jobs'));
});

test('buildAdminModel: photoCount does not count derived "MLS for download" duplicates', () => {
  const model = buildAdminModel([row('FVS-1', { data: { photos: [
    { status: 'ok', dropboxPath: '/J/HDR Photos/a.jpg' },
    { status: 'ok', dropboxPath: '/J/HDR Photos/Callout/c.jpg' },
    { status: 'ok', dropboxPath: '/J/MLS for download/Callout/c.jpg' },   // the duplicate
  ] } })]);
  assert.equal(model.jobs[0].photoCount, 2);
});
