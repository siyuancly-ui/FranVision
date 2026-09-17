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

test('buildAdminModel: pulls address/photoCount/hasVideo/hasTour off each row', () => {
  const rows = [
    row('FVS-1', {
      data: {
        address: '48 Red Ash Dr',
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
    jobId: 'FVS-1', address: '48 Red Ash Dr', photoCount: 2, hasVideo: true, hasTour: true, updatedAt: '2026-09-17T12:00:00Z',
  });
  assert.deepEqual(model.jobs[1], {
    jobId: 'FVS-2', address: null, photoCount: 0, hasVideo: false, hasTour: false, updatedAt: '2026-09-17T12:00:00Z',
  });
});

test('buildAdminModel: a whitespace-only address/tourUrl counts as absent', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '   ', tourUrl: '  ' } })]);
  assert.equal(model.jobs[0].address, null);
  assert.equal(model.jobs[0].hasTour, false);
});

test('renderAdminPage: lists every job with its delivery-page link', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '48 Red Ash Dr' } })]);
  const out = renderAdminPage(model);
  assert.ok(out.includes('href="/delivery/FVS-1"'));
  assert.ok(out.includes('48 Red Ash Dr'));
  assert.ok(out.includes('1 job'));
});

test('renderAdminPage: escapes address content', () => {
  const model = buildAdminModel([row('FVS-1', { data: { address: '<script>alert(1)</script>' } })]);
  const out = renderAdminPage(model);
  assert.ok(!out.includes('<script>alert(1)</script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('renderAdminPage: empty state when there are no jobs at all', () => {
  const out = renderAdminPage(buildAdminModel([]));
  assert.ok(out.includes('No jobs yet'));
  assert.ok(out.includes('0 jobs'));
});
