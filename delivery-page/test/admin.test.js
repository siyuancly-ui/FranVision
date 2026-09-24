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
    photoCount: 2, hasVideo: true, hasTour: true, updatedAt: '2026-09-17T12:00:00Z', galleryToken: null,
  });
  assert.deepEqual(model.jobs[1], {
    jobId: 'FVS-2', address: null, agents: [], photoCount: 0, hasVideo: false, hasTour: false, updatedAt: '2026-09-17T12:00:00Z', galleryToken: null,
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

test('renderAdminPage: copy-link button carries the full absolute URL when an origin is given', () => {
  const model = buildAdminModel([row('FVS-1', { data: {} })]);
  const out = renderAdminPage(model, { origin: 'https://real.gta3d.ca' });
  assert.ok(out.includes('data-link="https://real.gta3d.ca/delivery/FVS-1"'));
  assert.ok(out.includes('Copy link 复制链接'));
});

const TOK = '8779efe254f329f0766d73328550ae62';

test('buildAdminModel: attaches each Job\'s gallery token (null when it has none yet)', () => {
  const model = buildAdminModel([row('FVS-1', { data: {} }), row('FVS-2', { data: {} })], { 'FVS-1': TOK });
  assert.equal(model.jobs.find((j) => j.jobId === 'FVS-1').galleryToken, TOK);
  assert.equal(model.jobs.find((j) => j.jobId === 'FVS-2').galleryToken, null);
});

test('renderAdminPage: All in One and Gallery are two separate columns, each with Open + Copy (address slug + token)', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '12 Main St, Toronto' } })], { 'FVS-1': TOK });
  const out = renderAdminPage(model, { origin: 'https://realgta.ca' });
  assert.ok(out.includes('data-link="https://realgta.ca/12-main-st-toronto/FVS-1"'));
  assert.ok(out.includes(`data-link="https://realgta.ca/delivery/12-main-st-toronto/${TOK}"`));
  assert.ok(out.includes('<th>All in One</th><th>Gallery</th>'));
  const cells = out.split('<td><div class="btns">').slice(1);
  assert.equal(cells.length, 2);                                  // one cell per column
  assert.ok(cells[0].includes('data-link="https://realgta.ca/12-main-st-toronto/FVS-1"'));
  assert.ok(!cells[0].includes('/delivery/12-main-st-toronto/'));   // All in One cell has no gallery link
  assert.ok(cells[1].includes(`data-link="https://realgta.ca/delivery/12-main-st-toronto/${TOK}"`));
  assert.ok(out.includes(`class="open-link gallery-open" href="/delivery/12-main-st-toronto/${TOK}"`));
  assert.ok(!out.includes('gallery-open is-off'));
  assert.ok(!out.includes('create-btn"'));
});

test('renderAdminPage: a Job without a gallery token gets a "Create link" button in the Gallery column (no dead link)', () => {
  const out = renderAdminPage(buildAdminModel([row('FVS-1', { data: { address: '1 A St' } })]), { origin: 'https://realgta.ca' });
  assert.ok(out.includes('Create link 生成链接'));
  assert.ok(out.includes('data-job="FVS-1" data-link=""'));
  assert.ok(/class="open-link gallery-open is-off" aria-disabled="true"/.test(out)); // greyed, and no href to click
  assert.ok(!/gallery-open is-off"[^>]*href/.test(out));
  assert.ok(out.includes('gallery-btn create-btn'));                              // green Create button
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
