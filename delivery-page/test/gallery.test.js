import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGalleryToken, galleryPath, buildGalleryModel, renderGalleryPage, zipFilename } from '../src/gallery.js';

const OPTS = {
  jobId: 'FVS-20260924-001', supabaseUrl: 'https://sb.test', galleryFolders: ['HDR Photos', 'MLS'],
  localReportFolder: 'Local Report', videoFolders: ['Video'], coverClosingFolder: 'Cover&Closing',
  droneCalloutFolder: 'Callout', floorplanFolder: 'Floorplan',
};
const ph = (n, extra = {}) => ({
  photoId: `p${n}`, filename: `${String(n).padStart(2, '0')}.jpg`, folder: 'HDR Photos', status: 'ok', hasThumb: true,
  width: 1024, height: n % 2 ? 683 : 1024, dropboxPath: `/j/HDR Photos/${n}.jpg`, downloadDropboxPath: `/j/MLS for download/${n}.jpg`, ...extra,
});
const project = (photos, address = '12 Main St, Toronto') => ({ id: OPTS.jobId, data: { address, photos } });

test('isGalleryToken accepts only the 32-hex random token (never a raw jobId or junk)', () => {
  assert.equal(isGalleryToken('8779efe254f329f0766d73328550ae62'), true);
  for (const bad of ['', 'FVS-20260924-001', '8779efe254f329f0766d73328550ae6', '8779efe254f329f0766d73328550ae622',
    '8779EFE254F329F0766D73328550AE62', '8779efe254f329f0766d73328550ae6&', undefined, null, 42]) {
    assert.equal(isGalleryToken(bad), false, String(bad));
  }
});

test('galleryPath: address slug + token, cosmetic slug falls back when no address', () => {
  assert.equal(galleryPath('12 Main St, Toronto', 'TOK'), '/delivery/12-main-st-toronto/TOK');
  assert.equal(galleryPath(null, 'TOK'), '/delivery/photos/TOK');
});

test('buildGalleryModel: grid photos, aspect ratios, and which download buttons apply', () => {
  const m = buildGalleryModel(project([ph(1), ph(2), ph(3), ph(4, { folder: 'Callout' })]), OPTS);
  assert.equal(m.photos.length, 3); // Callout is not part of the grid
  assert.equal(m.photos[0].aspect, 1024 / 683);
  assert.equal(m.photos[1].aspect, 1);
  assert.deepEqual(m.photoIds, ['p1', 'p2', 'p3']);   // the grid decides the ZIP contents
  assert.equal(m.originalReady, true);
  assert.equal(m.mlsReady, true);
  assert.ok(m.hero);

  // ONE photo without its 2048 copy -> the whole MLS ZIP is "not ready" (never a smaller archive)
  const partial = buildGalleryModel(project([ph(1), ph(2, { downloadDropboxPath: undefined })]), OPTS);
  assert.equal(partial.originalReady, true);
  assert.equal(partial.mlsReady, false);
  assert.equal(partial.photos[1].hasWeb, false);
  assert.equal(buildGalleryModel(project([]), OPTS).originalReady, false);
});

test('buildGalleryModel copes with a missing project / missing dimensions', () => {
  const none = buildGalleryModel(null, OPTS);
  assert.equal(none.found, false);
  assert.deepEqual(none.photos, []);
  const m = buildGalleryModel(project([ph(1, { width: undefined, height: undefined })]), OPTS);
  assert.equal(m.photos[0].aspect, 1.5);
});

test('renderGalleryPage: hero address + both English buttons, grid, lightbox, token carried on links', () => {
  const m = buildGalleryModel(project([ph(1), ph(2), ph(3)]), OPTS);
  const html = renderGalleryPage(m, { base: '/delivery/12-main-st-toronto/TOK' });
  assert.match(html, /12 Main St, Toronto/);
  assert.match(html, /Download All Original Photos \(ZIP\)/);
  assert.match(html, /Download All MLS Photos \(ZIP\)/);
  assert.match(html, /href="\/delivery\/12-main-st-toronto\/TOK\/zip\/original"/);
  assert.match(html, /href="\/delivery\/12-main-st-toronto\/TOK\/zip\/mls"/);
  // the gallery's own links (downloads, lightbox images) never carry the raw jobId
  // (the 1024px preview thumbs are the same public Supabase URLs the delivery page shows)
  assert.doesNotMatch((html.match(/href="[^"]*"/g) || []).join(' ') + html.split('window.__GALLERY__=')[1].split('</script>')[0].replace(/"t":"[^"]*"/g, ''), /FVS-20260924-001/);
  assert.equal((html.match(/class="g-item"/g) || []).length, 3);
  assert.match(html, /id="lb"/);
  assert.match(html, /<footer class="credit">Photos by: FRANVISION MEDIA<\/footer>/);
  assert.doesNotMatch(html.split('<footer')[0].replace(/<style>[\s\S]*?<\/style>/, ''), /franvision media/i); // no brand text in the hero/bar
  assert.match(html, /\/delivery\/12-main-st-toronto\/TOK\/photo\/p1/);
  // the delivery page's own script/video SDK is not pulled in
  assert.doesNotMatch(html, /embed\.cloudflarestream\.com/);
});

test('renderGalleryPage: a ZIP that is not ready shows a disabled "Preparing" button instead of a link; no photos -> no buttons', () => {
  const m = buildGalleryModel(project([ph(1), ph(2, { downloadDropboxPath: undefined })]), OPTS);
  const html = renderGalleryPage(m, { base: '/delivery/x/TOK' });
  assert.match(html, /href="\/delivery\/x\/TOK\/zip\/original"/);
  assert.doesNotMatch(html, /zip\/mls/);
  assert.match(html, /is-disabled[^>]*>Preparing MLS Photos/);
  const empty = renderGalleryPage(buildGalleryModel(project([]), OPTS), { base: '/delivery/x/TOK' });
  assert.match(empty, /still being prepared/);
  assert.doesNotMatch(empty, /class="dl-btn/);
});

test('renderGalleryPage escapes hostile content (address, and </script> in inline data)', () => {
  const m = buildGalleryModel(project([ph(1)], '<img src=x onerror=alert(1)>'), OPTS);
  const html = renderGalleryPage(m, { base: '/delivery/x/TOK' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html.split('window.__GALLERY__=')[1].split('</script>')[0], /</);
});

test('zipFilename', () => {
  assert.equal(zipFilename('12 Main St, Toronto', 'J1', 'original'), '12-main-st-toronto-original-photos.zip');
  assert.equal(zipFilename('12 Main St, Toronto', 'J1', 'mls'), '12-main-st-toronto-mls-photos.zip');
  assert.equal(zipFilename(null, 'FVS-1', 'mls'), 'FVS-1-mls-photos.zip');
});
