import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryModel, renderDeliveryPage, renderNotFoundPage, escapeHtml, slugifyAddress, deliveryPath } from '../src/render.js';

test('slugifyAddress: lowercases, replaces non-alphanumeric runs with a hyphen, trims edges', () => {
  assert.equal(slugifyAddress('1371 Kestell Blvd, Oakville'), '1371-kestell-blvd-oakville');
  assert.equal(slugifyAddress('  48 Red Ash Dr.  '), '48-red-ash-dr');
  assert.equal(slugifyAddress(''), '');
  assert.equal(slugifyAddress(null), '');
});

test('deliveryPath: "/<address-slug>/<jobId>" when an address is known', () => {
  assert.equal(deliveryPath('FVS-20260917-003', '1371 Kestell Blvd, Oakville'), '/1371-kestell-blvd-oakville/FVS-20260917-003');
});

test('deliveryPath: falls back to "/delivery/<jobId>" with no address (nothing to slug)', () => {
  assert.equal(deliveryPath('FVS-20260917-003', null), '/delivery/FVS-20260917-003');
  assert.equal(deliveryPath('FVS-20260917-003', '   '), '/delivery/FVS-20260917-003');
});

const OPTS = {
  jobId: 'FVS-20260915-001',
  supabaseUrl: 'https://example.supabase.co',
  galleryFolders: ['HDR Photos', 'MLS'],
  localReportFolder: 'Local Report',
  videoFolders: ['Video', 'VLOG'],
  coverClosingFolder: 'Cover&Closing',
  droneCalloutFolder: 'Drone Callout',
  floorplanFolder: 'Floorplan',
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
  assert.deepEqual(model.aerial, []);
  assert.deepEqual(model.floorplan, []);
  assert.equal(model.address, null);
});

test('buildDeliveryModel: hero/closing default to the 3rd/5th gallery photo by filename', () => {
  const project = { id: OPTS.jobId, data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'p2', filename: 'b.jpg' }),
    photo({ photoId: 'p3', filename: 'c.jpg' }),
    photo({ photoId: 'p4', filename: 'd.jpg' }),
    photo({ photoId: 'p5', filename: 'e.jpg' }),
    photo({ photoId: 'p6', filename: 'f.jpg' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  // sorted a..f -> hero is the 3rd (p3/c.jpg), closing is the 5th (p5/e.jpg)
  assert.equal(model.gallery.length, 6);
  assert.equal(model.hero.photoId, 'p3');
  assert.equal(model.closing.photoId, 'p5');
  assert.ok(model.hero.url.includes('/storage/v1/object/public/photos/FVS-20260915-001/p3_thumb.jpg'));
});

test('buildDeliveryModel: fewer than 5 photos clamps the 3rd/5th pick and keeps hero/closing distinct', () => {
  const project = { id: OPTS.jobId, data: { photos: [
    photo({ photoId: 'p1', filename: 'b.jpg' }),
    photo({ photoId: 'p2', filename: 'a.jpg' }),
    photo({ photoId: 'p3', filename: 'c.jpg' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  // sorted a, b, c -> "3rd" clamps to the last (c/p3); "5th" would collide
  // with that, so closing falls back to the first instead (a/p2).
  assert.equal(model.hero.photoId, 'p3');
  assert.equal(model.closing.photoId, 'p2');
});

test('buildDeliveryModel: single gallery photo is both hero and closing', () => {
  const project = { data: { photos: [photo()] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, model.closing.photoId);
});

test('buildDeliveryModel: Cover&Closing folder -- lowest filename is cover, highest is closing', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'p2', filename: 'z.jpg' }),
    photo({ photoId: 'closing', filename: '2.jpg', folder: 'Cover&Closing' }),
    photo({ photoId: 'cover', filename: '1.jpg', folder: 'Cover&Closing' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'cover');
  assert.equal(model.closing.photoId, 'closing');
  // the override photos are not part of the gallery itself
  assert.deepEqual(model.gallery.map((p) => p.photoId), ['p1', 'p2']);
});

test('buildDeliveryModel: a single Cover&Closing photo is cover-only -- closing still falls back normally', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'p2', filename: 'z.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover&Closing' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'cover');
  assert.equal(model.closing.photoId, 'p2'); // last gallery photo by filename
});

test('buildDeliveryModel: more than two Cover&Closing photos -- only the lowest/highest filename are used', () => {
  const project = { data: { photos: [
    photo({ photoId: 'closing', filename: '3.jpg', folder: 'Cover&Closing' }),
    photo({ photoId: 'middle', filename: '2.jpg', folder: 'Cover&Closing' }),
    photo({ photoId: 'cover', filename: '1.jpg', folder: 'Cover&Closing' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'cover');
  assert.equal(model.closing.photoId, 'closing');
});

test('buildDeliveryModel: a pending_review photo in Cover&Closing folder does not override (falls back)', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover&Closing', status: 'pending_review' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.equal(model.hero.photoId, 'p1');
});

test('buildDeliveryModel: hasLarge:true uses the _large.jpg render for full-bleed slots, gallery stays small', () => {
  const project = { data: { photos: [
    photo({ photoId: 'p1', filename: 'a.jpg' }),
    photo({ photoId: 'cover', folder: 'Cover&Closing', hasLarge: true }),
    photo({ photoId: 'report', folder: 'Local Report', hasLarge: true }),
    photo({ photoId: 'drone', folder: 'Drone Callout', hasLarge: true }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.ok(model.hero.url.endsWith('cover_large.jpg'));
  assert.ok(model.localReport.url.endsWith('report_large.jpg'));
  assert.ok(model.aerial[0].url.endsWith('drone_large.jpg'));
  // gallery photos never get the large variant, even if hasLarge were set
  assert.ok(model.gallery[0].url.endsWith('p1_thumb.jpg'));
});

test('buildDeliveryModel: no hasLarge (or the plain gallery fallback) falls back to _thumb.jpg', () => {
  const overrideNoLarge = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'cover', folder: 'Cover&Closing', hasLarge: false })] } },
    OPTS,
  );
  assert.ok(overrideNoLarge.hero.url.endsWith('cover_thumb.jpg'));

  const galleryFallback = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'p1', filename: 'a.jpg' })] } }, // ordinary HDR Photos, never large
    OPTS,
  );
  assert.ok(galleryFallback.hero.url.endsWith('p1_thumb.jpg'));
});

test('buildDeliveryModel: Drone Callout photos populate aerial as an array, empty when absent', () => {
  const withOne = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'drone', folder: 'Drone Callout' })] } },
    OPTS,
  );
  assert.equal(withOne.aerial.length, 1);
  assert.equal(withOne.aerial[0].photoId, 'drone');

  const withMultiple = buildDeliveryModel(
    { data: { photos: [
      photo({ photoId: 'drone1', folder: 'Drone Callout', filename: 'a.png' }),
      photo({ photoId: 'drone2', folder: 'Drone Callout', filename: 'b.png' }),
    ] } },
    OPTS,
  );
  assert.equal(withMultiple.aerial.length, 2);
  assert.deepEqual(withMultiple.aerial.map((p) => p.photoId), ['drone1', 'drone2']);

  const without = buildDeliveryModel({ data: { photos: [photo()] } }, OPTS);
  assert.deepEqual(without.aerial, []);
});

test('buildDeliveryModel: Floor Plan photos populate floorplan as an array, empty when absent, excluded from the gallery', () => {
  const withOne = buildDeliveryModel(
    { data: { photos: [photo({ photoId: 'fp', folder: 'Floorplan' })] } },
    OPTS,
  );
  assert.equal(withOne.floorplan.length, 1);
  assert.equal(withOne.floorplan[0].photoId, 'fp');
  assert.deepEqual(withOne.gallery, []);

  const withMultiple = buildDeliveryModel(
    { data: { photos: [
      photo({ photoId: 'fp1', folder: 'Floorplan', filename: 'main-floor.jpg' }),
      photo({ photoId: 'fp2', folder: 'Floorplan', filename: 'basement.jpg' }),
    ] } },
    OPTS,
  );
  assert.equal(withMultiple.floorplan.length, 2);
  assert.deepEqual(withMultiple.floorplan.map((p) => p.photoId), ['fp2', 'fp1']); // sorted by filename

  const without = buildDeliveryModel({ data: { photos: [photo()] } }, OPTS);
  assert.deepEqual(without.floorplan, []);
});

test('buildDeliveryModel: a Floor Plan photo with hasLarge:true uses the _large.jpg render', () => {
  const project = { data: { photos: [photo({ photoId: 'fp', folder: 'Floorplan', hasLarge: true })] } };
  const model = buildDeliveryModel(project, OPTS);
  assert.ok(model.floorplan[0].url.endsWith('fp_large.jpg'));
});

test('renderDeliveryPage: a single Floor Plan photo renders as a static image, not a track, positioned before the neighborhood report', () => {
  const project = { data: { photos: [photo({ photoId: 'fp', folder: 'Floorplan' })], address: '1 Main St' } };
  project.data.photos.push({ photoId: 'report', filename: 'report.jpg', folder: 'Local Report', status: 'ok', hasThumb: true });
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('fp_thumb.jpg'));
  assert.ok(!out.includes('id="floorplanTrack"'));
  assert.ok(out.indexOf('fp_thumb.jpg') < out.indexOf('report_thumb.jpg')); // floor plan comes before local report
});

test('renderDeliveryPage: a single Floor Plan photo is height-capped so it fits on screen without scrolling', () => {
  const project = { data: { photos: [photo({ photoId: 'fp', folder: 'Floorplan' })] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('class="frame-img floorplan-single lightbox-trigger"'));
  assert.ok(out.includes('.floorplan-single{') && out.includes('max-height:min(90vh,1000px)'));
});

test('renderDeliveryPage: more than one Floor Plan photo renders the auto-advancing track', () => {
  const project = { data: { photos: [
    photo({ photoId: 'fp1', folder: 'Floorplan', filename: 'a.jpg' }),
    photo({ photoId: 'fp2', folder: 'Floorplan', filename: 'b.jpg' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('id="floorplanTrack"'));
  assert.ok(out.includes('fp1_thumb.jpg'));
  assert.ok(out.includes('fp2_thumb.jpg'));
});

test('renderDeliveryPage: a single Drone Callout photo renders as a static image, not a track', () => {
  const project = { data: { photos: [photo({ photoId: 'drone', folder: 'Drone Callout' })] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('drone_thumb.jpg'));
  assert.ok(!out.includes('id="aerialTrack"'));
});

test('renderDeliveryPage: more than one Drone Callout photo renders the auto-advancing track', () => {
  const project = { data: { photos: [
    photo({ photoId: 'drone1', folder: 'Drone Callout', filename: 'a.png' }),
    photo({ photoId: 'drone2', folder: 'Drone Callout', filename: 'b.png' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('id="aerialTrack"'));
  assert.ok(out.includes('drone1_thumb.jpg'));
  assert.ok(out.includes('drone2_thumb.jpg'));
});

test('renderDeliveryPage: Callout is 16:9 (aerial-slide/aerial-single), Floor Plan keeps the default ratio', () => {
  const project = { data: { photos: [
    photo({ photoId: 'drone', folder: 'Drone Callout' }),
    photo({ photoId: 'fp', folder: 'Floorplan' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('aerial-single'));
  const fpImgTag = out.slice(out.indexOf('fp_thumb.jpg') - 200, out.indexOf('fp_thumb.jpg') + 50);
  assert.ok(!fpImgTag.includes('aerial-single')); // floor plan img has no aerial-single class

  const multiProject = { data: { photos: [
    photo({ photoId: 'drone1', folder: 'Drone Callout', filename: 'a.png' }),
    photo({ photoId: 'drone2', folder: 'Drone Callout', filename: 'b.png' }),
  ] } };
  const multiModel = buildDeliveryModel(multiProject, OPTS);
  const multiOut = renderDeliveryPage(multiModel);
  assert.ok(multiOut.includes('gallery-slide aerial-slide lightbox-trigger'));
});

test('renderDeliveryPage: Callout auto-advances every 5s, the main gallery/Floor Plan stay at 2s', () => {
  const project = { data: { photos: [
    photo({ photoId: 'drone1', folder: 'Drone Callout', filename: 'a.png' }),
    photo({ photoId: 'drone2', folder: 'Drone Callout', filename: 'b.png' }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes("setupTrack('aerialTrack', 'aerialPrev', 'aerialNext', 1000, 5000)"));
  assert.ok(out.includes("setupTrack('galTrack', 'galPrev', 'galNext', 0, 2000, true)"));
});

test('renderDeliveryPage: Callout and Floor Plan images/slides are lightbox triggers with the full-res URL', () => {
  const project = { data: { photos: [
    photo({ photoId: 'drone', folder: 'Drone Callout', hasLarge: true }),
    photo({ photoId: 'fp', folder: 'Floorplan', hasLarge: true }),
  ] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('class="frame-img aerial-single lightbox-trigger" data-full="' + model.aerial[0].url + '"'));
  assert.ok(out.includes('class="frame-img floorplan-single lightbox-trigger" data-full="' + model.floorplan[0].url + '"'));
  assert.ok(out.includes('id="lightbox"'));
  assert.ok(out.includes('id="lightboxImg"'));
});

test('renderDeliveryPage: the lightbox markup is omitted when there is no Callout or Floor Plan', () => {
  const model = buildDeliveryModel({ data: { address: '1 Main St', photos: [photo()] } }, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(!out.includes('id="lightbox"'));
});

test('renderDeliveryPage: the lightbox stays hidden by default (a `.lightbox{display:flex}` rule alone would win over [hidden] and show it permanently)', () => {
  const project = { data: { photos: [photo({ photoId: 'drone', folder: 'Drone Callout' })] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('<div class="lightbox" id="lightbox" hidden>'));
  assert.ok(out.includes('.lightbox[hidden]{display:none;}'));
});

test('renderDeliveryPage: video autoplays, loops, and the page script unmutes it at 60% volume', () => {
  const project = { data: { videos: [{ videoId: 'v1', folder: 'Video', status: 'ok', streamUid: 'abc' }] } };
  const model = buildDeliveryModel(project, OPTS);
  const out = renderDeliveryPage(model);
  assert.ok(out.includes('iframe.videodelivery.net/abc?autoplay=true&amp;muted=true&amp;loop=true'));
  assert.ok(out.includes('id="deliveryVideo"'));
  assert.ok(out.includes('embed.cloudflarestream.com/embed/sdk.latest.js'));
  assert.ok(out.includes('player.volume = 0.6;'));
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

test('renderDeliveryPage ends with the "Photos by: FRANVISION MEDIA" credit, after the closing section', () => {
  const html = renderDeliveryPage(buildDeliveryModel({ id: OPTS.jobId, data: { address: '1 Main St' } }, OPTS));
  assert.match(html, /<footer class="credit">Photos by: FRANVISION MEDIA<\/footer>/);
  assert.ok(html.indexOf('class="closing') < html.indexOf('class="credit"'));
});
