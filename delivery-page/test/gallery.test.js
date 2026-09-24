import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliveryModel, renderDeliveryPage } from '../src/render.js';
import { attachmentDisposition, isGalleryToken, galleryPath, buildGalleryModel, renderGalleryPage, zipFilename } from '../src/gallery.js';

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

test('buildGalleryModel: main photos then Callout photos in the grid; both ZIPs come from exactly those', () => {
  const callout = (n, extra = {}) => ph(n, { folder: 'Callout', filename: `aerial-${n}.jpg`, dropboxPath: `/j/HDR Photos/Callout/${n}.jpg`, downloadDropboxPath: `/m/Callout/${n}.jpg`, ...extra });
  const m = buildGalleryModel(project([callout(9), ph(1), ph(2), ph(3), callout(8)]), OPTS);
  assert.equal(m.photos.length, 5);
  assert.deepEqual(m.photos.map((p) => p.photoId), ['p1', 'p2', 'p3', 'p8', 'p9']);   // main first, then Callout (by filename)
  assert.equal(m.photos[0].aspect, 1024 / 683);
  assert.equal(m.photos[1].aspect, 1);
  assert.deepEqual(m.originalPhotoIds, ['p1', 'p2', 'p3', 'p8', 'p9']);
  assert.deepEqual(m.mlsPhotoIds, ['p1', 'p2', 'p3', 'p8', 'p9']);
  assert.equal(m.originalReady, true);
  assert.equal(m.mlsReady, true);
  assert.ok(m.hero);
});

test('Callout photos from before 2026-09-23 (no MLS copy) are in the grid and the Original ZIP, left out of the MLS ZIP, and never block it', () => {
  const oldCallout = ph(8, { folder: 'Callout', filename: 'aerial-8.jpg', downloadDropboxPath: undefined });
  const m = buildGalleryModel(project([ph(1), ph(2), oldCallout]), OPTS);
  assert.deepEqual(m.photos.map((p) => p.photoId), ['p1', 'p2', 'p8']);
  assert.deepEqual(m.originalPhotoIds, ['p1', 'p2', 'p8']);
  assert.deepEqual(m.mlsPhotoIds, ['p1', 'p2']);
  assert.equal(m.originalReady, true);
  assert.equal(m.mlsReady, true);                       // not stuck on "Preparing" because of an old Callout
  assert.equal(m.photos[2].hasWeb, false);
});

test('MLS ZIP is "not ready" while any copy is still queued for generation, or a MAIN photo has no copy -- never a smaller archive', () => {
  const pending = new Set(['/j/HDR Photos/2.jpg']);
  const queued = buildGalleryModel(project([ph(1), ph(2)]), OPTS, pending);
  assert.equal(queued.mlsReady, false);
  assert.equal(queued.originalReady, true);
  assert.equal(buildGalleryModel(project([ph(1), ph(2)]), OPTS, new Set()).mlsReady, true);        // queue drained -> turns on by itself
  const mainNoCopy = buildGalleryModel(project([ph(1), ph(2, { downloadDropboxPath: undefined })]), OPTS);
  assert.equal(mainNoCopy.mlsReady, false);
  assert.equal(mainNoCopy.originalReady, true);
  assert.equal(mainNoCopy.photos[1].hasWeb, false);
  assert.equal(buildGalleryModel(project([]), OPTS).originalReady, false);
  // a queued copy for a Callout photo also holds the MLS ZIP back (it WILL have one)
  const callQueued = buildGalleryModel(project([ph(1), ph(8, { folder: 'Callout', dropboxPath: '/j/HDR Photos/Callout/8.jpg', downloadDropboxPath: '/m/Callout/8.jpg' })]), OPTS, new Set(['/j/HDR Photos/Callout/8.jpg']));
  assert.equal(callQueued.mlsReady, false);
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
  assert.match(html, /is-disabled[^>]*>[\s\S]*?Preparing MLS Photos/);
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

// The Gallery's hero must ALWAYS be the same photo as the delivery page's ("All in One") hero.
// Guaranteed structurally (buildGalleryModel calls buildDeliveryModel; both render via heroHtml)
// -- this pins it against anyone giving the Gallery its own pick later.
const heroUrl = (html) => /class="hero" style="background-image:url\('([^']+)'\)/.exec(html)?.[1] || null;

test('Gallery hero photo === delivery page hero photo, in every selection scenario', () => {
  const many = Array.from({ length: 8 }, (_, i) => ph(i + 1));
  const scenarios = {
    'auto pick (3rd photo by filename)': many,
    'a large-render fallback photo': many.map((p, i) => (i === 2 ? { ...p, hasLarge: true } : p)),
    'Cover&Closing override wins': [...many, ph(20, { folder: 'Cover&Closing', filename: 'a-cover.jpg', hasLarge: true }), ph(21, { folder: 'Cover&Closing', filename: 'z-closing.jpg', hasLarge: true })],
    'a single photo only': [ph(1)],
    'two photos (clamped pick)': [ph(1), ph(2)],
    'unsorted input order': [...many].reverse(),
    'pending/failed photos mixed in': [ph(1, { status: 'pending_review' }), ...many, ph(30, { hasThumb: false })],
  };
  for (const [name, photos] of Object.entries(scenarios)) {
    const proj = project(photos);
    const fromDelivery = heroUrl(renderDeliveryPage(buildDeliveryModel(proj, OPTS)));
    const fromGallery = heroUrl(renderGalleryPage(buildGalleryModel(proj, OPTS), { base: '/delivery/x/TOK' }));
    assert.ok(fromDelivery, `${name}: delivery page has a hero`);
    assert.equal(fromGallery, fromDelivery, name);
  }
  assert.equal(heroUrl(renderGalleryPage(buildGalleryModel(project([]), OPTS), { base: '/delivery/x/TOK' })), heroUrl(renderDeliveryPage(buildDeliveryModel(project([]), OPTS)))); // both null with no photos
});

test('the two big buttons use the tray-arrow icon instead of the word "Download" in their visible label (aria-label keeps the full name)', () => {
  const html = renderGalleryPage(buildGalleryModel(project([ph(1), ph(2)]), OPTS), { base: '/delivery/x/TOK' });
  const btns = [...html.matchAll(/<a class="dl-btn"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[0]);
  assert.equal(btns.length, 2);
  for (const b of btns) {
    assert.match(b, /<svg class="dl-ico"/);
    assert.doesNotMatch(b.replace(/aria-label="[^"]*"/, ''), /Download/);       // no "Download" word on the button face
  }
  assert.match(btns[0], /aria-label="Download All Original Photos \(ZIP\)"[\s\S]*<span class="dl-label">All Original Photos \(ZIP\)<\/span>/);
  assert.match(btns[1], /aria-label="Download All MLS Photos \(ZIP\)"[\s\S]*<span class="dl-label">All MLS Photos \(ZIP\)<\/span>/);
});

test('every grid tile has a hover overlay with the file name and its own download link; a photo with no original has no download icon', () => {
  const m = buildGalleryModel(project([ph(1, { filename: 'FVM001.jpg' }), ph(2, { filename: 'FVM002.jpg', dropboxPath: undefined })]), OPTS);
  const html = renderGalleryPage(m, { base: '/delivery/x/TOK' });
  assert.equal((html.match(/class="g-hover"/g) || []).length, 2);
  assert.match(html, /<span class="g-name">FVM001\.jpg<\/span><a class="g-dl" href="\/delivery\/x\/TOK\/download\/p1" download/);
  assert.match(html, /<span class="g-name">FVM002\.jpg<\/span><\/div>/);            // name only, no icon
  assert.doesNotMatch(html, /\/download\/p2/);
});

test('lightbox follows the sample: stage, close, top download, day/night pill, side arrows, bottom name + thumbnail strip + counter; NO share button', () => {
  const html = renderGalleryPage(buildGalleryModel(project([ph(1), ph(2), ph(3)]), OPTS), { base: '/delivery/x/TOK' });
  for (const id of ['lbStage', 'lbClose', 'lbDl', 'lbTheme', 'lbPrev', 'lbNext', 'lbName', 'lbStrip', 'lbCount']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html.toLowerCase(), /share/);
  // the lightbox download is a pill: the WORD + a round arrow badge (not just an icon)
  assert.match(html, /id="lbDl"[^>]*><span class="lb-dl-text">Download<\/span><span class="lb-dl-circle"><svg class="dl-ico"/);
  const data = JSON.parse(/window\.__GALLERY__=(\[.*?\]);<\/script>/s.exec(html)[1]);
  assert.equal(data.length, 3);
  assert.deepEqual(Object.keys(data[0]).sort(), ['d', 'n', 't', 'w']);
  assert.equal(data[0].d, '/delivery/x/TOK/download/p1');
  assert.equal(data[0].n, '01.jpg');
});

test('attachmentDisposition: safe ASCII fallback + UTF-8 name, no quotes/slashes/control characters', () => {
  assert.equal(attachmentDisposition('FVM001.jpg'), `attachment; filename="FVM001.jpg"; filename*=UTF-8''FVM001.jpg`);
  assert.equal(attachmentDisposition('客厅 1.jpg'), `attachment; filename="__ 1.jpg"; filename*=UTF-8''%E5%AE%A2%E5%8E%85%201.jpg`);
  assert.equal(attachmentDisposition('a"b/c\\d\n.jpg'), `attachment; filename="abcd.jpg"; filename*=UTF-8''abcd.jpg`);
  assert.equal(attachmentDisposition(''), `attachment; filename="photo.jpg"; filename*=UTF-8''photo.jpg`);
});
