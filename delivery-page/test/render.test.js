import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryModel, renderDeliveryPage, renderNotFoundPage, escapeHtml } from '../src/render.js';

const OPTS = {
  jobId: 'FVS-20260915-001',
  supabaseUrl: 'https://example.supabase.co',
  galleryFolders: ['HDR Photos', 'MLS'],
  localReportFolder: 'Local Report',
  videoFolders: ['Video', 'VLOG'],
  coverPhotoFolder: 'Cover Photo',
  closingPhotoFolder: 'Closing Photo',
  droneCalloutFolder: 'Drone Callout',
};

function photo(overrides = {}) {
  return { photoId: 'p1', filename: 'a.jpg', folder: 'HDR Photos', status: 'ok', hasThumb: true, ...overrides };
}

test('buildDeliveryModel: empty project has no sections', () => {
  const model = buildDeliveryModel(null, OPTS);
  assert.equal(model.found, false);
  assert.equal(model.hero, null);
  assert.equal(model.video, null);
  assert.equal(model.tour, null);
  assert.deepEqual(model.gallery, []);
  assert.equal(model.localReport, null);
  assert.equal(model.aerial, null);
  assert.equal(model.address, null);
});

test('buildDeliveryModel: gallery folder photos become hero + gallery + closing', () => {
  const project = { id: OPTS.jobId, data: { photos: [
    photo({ photoId: 'p1', filename: 'b.jpg' }),
    photo({ photoId: 'p2', filename: 'a.jpg' }),
    photo({ photoId: 'p3', filename: 'c.jpg' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  // sorted by filename: a, b, c -> hero is 'a' (p2), closing is 'c' (p3)
  assert.equal(model.gallery.length, 3);
  assert.equal(model.hero.photoId, 'p2');
  assert.equal(model.closing.photoId, 'p3');
  assert.ok(model.hero.url.includes('/storage/v1/object/public/photos/FVS-20260915-001/p2_thumb.jpg'));
});

test('buildDeliveryModel: single gallery photo is both hero and closing', () => {
  const project = { data: { photos: [photo()] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, model.closing.photoId);
});

test('buildDeliveryModel: Cover Photo / Closing Photo folders override the auto first/last pick', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'p2', filename: 'z.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover Photo' }),
    photo({ photoId: 'closing', folder: 'Closing Photo' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'cover');
  assert.equal(model.closing.photoId, 'closing');
  // the override photos are not part of the gallery itself
  assert.deepEqual(model.gallery.map((p) => p.photoId), ['p1', 'p2']);
});

test('buildDeliveryModel: Cover Photo present but Closing Photo absent -- closing still falls back normally', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'p2', filename: 'z.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover Photo' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'cover');
  assert.equal(model.closing.photoId, 'p2'); // last gallery photo by filename
});

test('buildDeliveryModel: a pending_review photo in Cover Photo folder does not override (falls back)', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover Photo', status: 'pending_review' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'p1');
});

test('buildDeliveryModel: hasLarge:true uses the _large.jpg render for full-bleed slots, gallery stays small', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover Photo', hasLarge: true }),
    photo({ photoId: 'report', folder: 'Local Report', hasLarge: true }),
    photo({ photoId: 'drone', folder: 'Drone Callout', hasLarge: true }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.ok(model.hero.url.endsWith('cover_large.jpg'));
  assert.ok(model.localReport.url.endsWith('report_large.jpg'));
  assert.ok(model.aerial.url.endsWith('drone_large.jpg'));
  // gallery photos never get the large variant, even if hasLarge were set
  assert.ok(model.gallery[0].url.endsWith('p1_thumb.jpg'));
});

test('buildDeliveryModel: no hasLarge (or the plain gallery fallback) falls back to _thumb.jpg', () => {
  const overrideNoLarge = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'cover', folder: 'Cover Photo', hasLarge: false })] } },
    OPTS,
  );
  assert.ok(overrideNoLarge.hero.url.endsWith('cover_thumb.jpg'));

  const galleryFallback = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'p1', filename: 'a.jpg' })] } }, // ordinary HDR Photos, never large
    OPTS,
  );
  assert.ok(galleryFallback.hero.url.endsWith('p1_thumb.jpg'));
});

test('buildDeliveryModel: Drone Callout photo populates aerial, absent means null', () => {
  const withPhoto = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'drone', folder: 'Drone Callout' })] } },
    OPTS,
  );
  assert.equal(withPhoto.aerial.photoId, 'drone');

  const without = buildDeliveryModel({ data: { photos: [photo()] } }, OPTS);
  assert.equal(without.aerial, null);
});

test('buildDeliveryModel: non-ok or thumbless photos are excluded', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', status: 'pending_review' }),
    photo({ photoId: 'p2', hasThumb: false }),
    photo({ photoId: 'p3', folder: 'Floorplan' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.deepEqual(model.gallery, []);
});

test('buildDeliveryModel: Local Report photo is separate from gallery', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', folder: 'HDR Photos' }),
    photo({ photoId: 'p2', folder: 'Local Report' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.gallery.length, 1);
  assert.equal(model.localReport.photoId, 'p2');
});

test('buildDeliveryModel: video picked from VIDEO_FOLDERS, builds Stream iframe URL', () => {
  const project = { data: { videos: [
    { videoId: 'v1', folder: 'Video', status: 'ok', streamUid: 'abc123' },
    { videoId: 'v2', folder: 'Video', status: 'processing', streamUid: 'zzz' },
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.video.playbackUrl, 'https://iframe.videodelivery.net/abc123');
});

test('buildDeliveryModel: tourUrl/tourType pass through, invalid tourType dropped', () => {
  const project = { data: { tourUrl: '  https://floortour.example/x  ', tourType: 'floor_tour' } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.tour.url, 'https://floortour.example/x');
  assert.equal(model.tour.type, 'floor_tour');

  const project2 = { data: { tourUrl: 'https://x', tourType: 'bogus' } };
  const model2 = buildDeliveryModel(project2, OPTS);
  assert.equal(model2.tour.type, null);
});

test('renderDeliveryPage: omits sections with no data', () => {
  const model = buildDeliveryModel({ data: { address: '142 Cedarcrest Hollow' } }, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('142 Cedarcrest Hollow'));
  assert.ok(!out.includes('id="galTrack"'));
  assert.ok(!out.includes('videodelivery.net'));
  // The closing section's Google Maps embed IS expected whenever there's an
  // address (see the dedicated map test below) -- that's the only iframe here.
  assert.equal((out.match(/<iframe/g) || []).length, 1);
});

test('renderDeliveryPage: includes gallery/video/tour markup when present', () => {
  const project = {
    data: {
      address: '1 Main St',
      photos: [photo(), photo({ photoId: 'drone', folder: 'Drone Callout' })],
      videos: [{ videoId: 'v1', folder: 'Video', status: 'ok', streamUid: 'abc' }],
      tourUrl: 'https://tour.example/x',
      tourType: '3d_tour',
    },
  };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('gallery-track'));
  assert.ok(out.includes('iframe.videodelivery.net/abc'));
  assert.ok(out.includes('tour.example/x'));
  assert.ok(out.includes('drone_thumb.jpg'));
});

test('renderDeliveryPage: closing section embeds a Google Maps iframe for the address, no API key', () => {
  const model = buildDeliveryModel({ data: { address: '1 Main St, Toronto' } }, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('google.com/maps?q=1%20Main%20St%2C%20Toronto'));
  assert.ok(out.includes('output=embed'));
  assert.ok(!out.includes('key='));
});

test('escapeHtml escapes markup-significant characters', () => {
  assert.equal(escapeHtml(`<script>"'&`), '&lt;script&gt;&quot;&#39;&amp;');
});

test('renderNotFoundPage includes the requested jobId', () => {
  const out = renderNotFoundPage('FVS-BOGUS');
  assert.ok(out.includes('FVS-BOGUS'));
});
