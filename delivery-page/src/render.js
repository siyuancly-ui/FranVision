// Pure data shaping + HTML rendering for the delivery page. No fetch here --
// index.js hands in the raw Supabase `projects` row and the env vars that
// name which Dropbox folders map to which section; everything below is
// synchronous and unit-testable without a network.
//
// Section presence is data-driven (v1 rule from
// franvision-delivery-page-design-spec.md: "field/data present -> render,
// absent -> hide"), NOT yet driven by which services/packages the Job's
// client purchased -- that needs job-generator/pricing data flowing into
// Supabase, which doesn't exist yet. See that doc's "Section visibility is
// service-driven, not fixed" note before extending this.

// Pretty delivery-page path: "/<address-slug>/<jobId>" when an address is
// known, else the plain "/delivery/<jobId>" path (no address to build a
// slug from yet). The address segment is PURELY cosmetic -- lookup always
// uses the jobId segment verbatim (see index.js's routing), so an unusual
// address (odd punctuation, non-ASCII, etc.) slugifying to something ugly
// or even empty can never break the actual link, only how pretty it looks.
export function slugifyAddress(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deliveryPath(jobId, address) {
  const slug = slugifyAddress(address);
  return slug ? `/${slug}/${encodeURIComponent(jobId)}` : `/delivery/${encodeURIComponent(jobId)}`;
}

export function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// variant: 'thumb' (default, ~1024px, the gallery/Feature-Sheet-Builder
// size) or 'large' (~2048px, photo-sync-worker's LARGE_THUMB_FOLDERS
// render -- only exists when the photo record has hasLarge:true).
function photoUrl(supabaseUrl, jobId, photoId, variant) {
  const suffix = variant === 'large' ? '_large.jpg' : '_thumb.jpg';
  return `${supabaseUrl}/storage/v1/object/public/photos/${encodeURIComponent(jobId)}/${photoId}${suffix}`;
}

// Photos in one of `folders` (case-insensitive), synced ok, thumbnail ready,
// sorted by filename for a stable/predictable order.
function pickPhotos(photos, folders) {
  const wanted = new Set(folders.map((f) => f.trim().toLowerCase()));
  return (photos || [])
    .filter((p) => p && p.status === 'ok' && p.hasThumb && wanted.has(String(p.folder || '').toLowerCase()))
    .sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || '')));
}

// The photo at `index` in a filename-sorted list, clamped to the last
// available one if the gallery is smaller than that. Null for an empty list.
function fallbackPhoto(list, index) {
  if (!list.length) return null;
  return list[index] || list[list.length - 1];
}

function pickVideo(videos, folders) {
  const wanted = new Set(folders.map((f) => f.trim().toLowerCase()));
  return (videos || []).find((v) => v && v.status === 'ok' && wanted.has(String(v.folder || '').toLowerCase())) || null;
}

// project: the raw `projects` row ({ id, data, ... }) from Supabase, or null
// if the Job has no row yet (nothing synced, nothing manually entered).
export function buildDeliveryModel(project, {
  jobId, supabaseUrl, galleryFolders, localReportFolder, videoFolders,
  coverClosingFolder, droneCalloutFolder, floorplanFolder,
}) {
  const data = (project && project.data) || {};
  const photos = data.photos || [];
  const videos = data.videos || [];

  const galleryPhotos = pickPhotos(photos, galleryFolders);
  const toImg = (p) => ({ photoId: p.photoId, url: photoUrl(supabaseUrl, jobId, p.photoId), width: p.width, height: p.height });
  // Full-bleed slots (hero/closing/local-report/aerial): use the large
  // (w2048h1536) render when photo-sync-worker generated one for this
  // photo's folder (LARGE_THUMB_FOLDERS), else fall back to the small
  // thumb -- e.g. the hero/closing AUTO fallback below comes from the
  // main gallery, which never gets a large render on purpose (see
  // photo-sync-worker/CLAUDE.md), so this just gracefully stays small.
  const toImgLarge = (p) => ({ photoId: p.photoId, url: photoUrl(supabaseUrl, jobId, p.photoId, p.hasLarge ? 'large' : 'thumb'), width: p.width, height: p.height });

  // Manual-override folder (Cover&Closing / Drone Callout) -- a human drops
  // photo(s) in, no data-entry needed. Cover&Closing merges what used to be
  // two separate folders (confirmed 2026-09-17): pickPhotos already sorts by
  // filename, so within that one folder the lowest-numbered photo becomes
  // the cover/hero override and the highest-numbered becomes the closing
  // override -- a single photo is treated as cover-only (closing still falls
  // back normally below), and anything beyond two photos just leaves the
  // middle ones unused. Job Generator doesn't create this folder by default
  // yet, so most jobs won't have anything in it; that's fine, everything
  // below falls back cleanly.
  const coverClosingPhotos = coverClosingFolder ? pickPhotos(photos, [coverClosingFolder]) : [];
  const coverOverride = coverClosingPhotos[0] || null;
  const closingOverride = coverClosingPhotos.length > 1 ? coverClosingPhotos[coverClosingPhotos.length - 1] : null;
  const aerialPhotos = droneCalloutFolder ? pickPhotos(photos, [droneCalloutFolder]) : [];
  // Floor Plan / Site Plan (2026-09-18) -- same "drop file(s) in Dropbox, no
  // data entry" shape as Local Report/Drone Callout. Can be more than one
  // page (main floor, second floor, basement), so this is an array like
  // aerial, not a single photo like Local Report.
  const floorplanPhotos = floorplanFolder ? pickPhotos(photos, [floorplanFolder]) : [];

  // No override -> falls back to the 3rd / 5th gallery photo by filename
  // (confirmed 2026-09-15) -- the very first/last shot in a folder is often
  // an awkward establishing angle, not the best hero/closing candidate.
  // Clamped to whatever's actually available in a small gallery, and kept
  // distinct from each other whenever more than one photo exists.
  const heroFallback = fallbackPhoto(galleryPhotos, 2);
  let closingFallback = fallbackPhoto(galleryPhotos, 4);
  // Only avoid a duplicate pick when BOTH slots are actually relying on
  // this fallback -- a Cover&Closing override wins its own slot regardless
  // of what the closing fallback would otherwise have picked.
  if (!coverOverride && closingFallback && heroFallback && closingFallback.photoId === heroFallback.photoId && galleryPhotos.length > 1) {
    const last = galleryPhotos[galleryPhotos.length - 1];
    closingFallback = last.photoId !== heroFallback.photoId ? last : galleryPhotos[0];
  }

  const heroPhoto = coverOverride ? toImgLarge(coverOverride) : (heroFallback ? toImgLarge(heroFallback) : null);
  const closingPhoto = closingOverride
    ? toImgLarge(closingOverride)
    : (closingFallback ? toImgLarge(closingFallback) : heroPhoto);

  const localReportPhoto = pickPhotos(photos, [localReportFolder])[0];
  const video = pickVideo(videos, videoFolders);

  const tourUrl = typeof data.tourUrl === 'string' && data.tourUrl.trim() ? data.tourUrl.trim() : null;
  const tourType = data.tourType === '3d_tour' ? '3d_tour' : data.tourType === 'floor_tour' ? 'floor_tour' : null;
  const address = typeof data.address === 'string' && data.address.trim() ? data.address.trim() : null;

  return {
    found: Boolean(project),
    jobId,
    address,
    hero: heroPhoto,
    video: video ? { playbackUrl: `https://iframe.videodelivery.net/${video.streamUid}`, thumbnailUrl: video.thumbnailUrl || null } : null,
    tour: tourUrl ? { url: tourUrl, type: tourType } : null,
    gallery: galleryPhotos.map(toImg),
    // Array, not a single photo -- Drone Callout can hold more than one
    // (design-spec allows it), rendered as a static image when there's
    // just one, or a gallery-style auto-advancing track when there's more.
    aerial: aerialPhotos.map(toImgLarge),
    // Array, same reasoning as aerial -- a static image when there's one
    // page, an auto-advancing track when there's more than one.
    floorplan: floorplanPhotos.map(toImgLarge),
    localReport: localReportPhoto ? toImgLarge(localReportPhoto) : null,
    closing: closingPhoto,
  };
}

function section(open, inner) {
  return inner ? `${open}\n${inner}\n</section>` : '';
}

export function renderNotFoundPage(jobId) {
  return page('Delivery Page', `
<div class="notfound">
  <p class="eyebrow">FranVision Media</p>
  <h1>This delivery page isn't ready yet</h1>
  <p>We couldn't find a Job matching <strong>${escapeHtml(jobId)}</strong>. If you followed a link from your agent, double-check it, or reach out to Franky directly.</p>
</div>`, { bare: true });
}

export function renderDeliveryPage(model) {
  const body = `
${heroHtml(model)}
${section('<section>', model.video && videoHtml(model.video))}
${section('<section class="section-alt">', model.tour && tourHtml(model.tour))}
${section('<section>', model.gallery.length > 0 && galleryHtml(model.gallery))}
${section('<section class="section-alt">', model.aerial.length > 0 && aerialHtml(model.aerial))}
${section('<section>', model.floorplan.length > 0 && floorplanHtml(model.floorplan))}
${section('<section class="section-alt">', model.localReport && localReportHtml(model.localReport))}
${closingHtml(model)}
${(model.aerial.length > 0 || model.floorplan.length > 0) ? lightboxHtml() : ''}`;
  return page(model.address ? `${model.address} — FranVision Media` : 'FranVision Delivery Page', body);
}

// Shared fullscreen viewer for Callout/Floor Plan (2026-09-18) -- any element
// with class `lightbox-trigger` + a `data-full` URL opens here on click (see
// SCRIPT). Only rendered when at least one of those sections is present.
function lightboxHtml() {
  return `  <div class="lightbox" id="lightbox" hidden>
    <button class="lightbox-close" id="lightboxClose" aria-label="Close">&times;</button>
    <img id="lightboxImg" src="" alt="">
  </div>`;
}

function heroHtml(model) {
  if (!model.hero && !model.address) return '';
  const bg = model.hero ? `background-image:url('${escapeHtml(model.hero.url)}');background-size:cover;background-position:center;` : '';
  const addr = model.address
    ? `<p class="hero-address">${escapeHtml(model.address)}</p>`
    : '';
  return `<section class="hero" style="${bg}">${addr}</section>`;
}

function videoHtml(video) {
  // autoplay requires muted (browser autoplay policy); loop suits a teaser.
  const src = `${video.playbackUrl}?autoplay=true&muted=true&loop=true`;
  return `  <div class="media-frame">
    <div class="media-box" style="cursor:default;">
      <iframe src="${escapeHtml(src)}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>
    </div>
  </div>`;
}

function tourHtml(tour) {
  return `  <div class="media-frame">
    <div class="tour-box" style="padding:0;">
      <iframe src="${escapeHtml(tour.url)}" style="width:100%;height:100%;border:0;" allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy"></iframe>
    </div>
  </div>`;
}

// Shared by the main gallery and a multi-photo Drone Callout/Floor Plan (see
// aerialHtml/floorplanHtml) -- same auto-advancing track, same visual
// treatment, distinguished only by element ids so the page script can run
// each independently (see SCRIPT's setupTrack, which also staggers their
// auto-advance timing so two tracks never scroll in lockstep). `opts.slideClass`
// adds an extra class per slide (e.g. `aerial-slide` for Callout's 16:9
// override -- the main gallery/Floor Plan keep the default 3:2). `opts.lightbox`
// marks slides clickable to open the shared fullscreen viewer (see SCRIPT).
function trackHtml(images, ids, opts = {}) {
  const slideClass = opts.slideClass ? ` ${opts.slideClass}` : '';
  const clickClass = opts.lightbox ? ' lightbox-trigger' : '';
  const slides = images.map((p) => `<div class="gallery-slide${slideClass}${clickClass}" data-full="${escapeHtml(p.url)}" style="background-image:url('${escapeHtml(p.url)}');background-size:cover;background-position:center;"></div>`).join('\n    ');
  return `  <div class="gallery-wrap">
    <button class="gallery-arrow prev" id="${ids.prev}" aria-label="Previous photo"><svg viewBox="0 0 24 24" fill="none" stroke="#23211C" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg></button>
    <div class="gallery-track" id="${ids.track}">
    ${slides}
    </div>
    <button class="gallery-arrow next" id="${ids.next}" aria-label="Next photo"><svg viewBox="0 0 24 24" fill="none" stroke="#23211C" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg></button>
  </div>`;
}

function galleryHtml(gallery) {
  return trackHtml(gallery, { track: 'galTrack', prev: 'galPrev', next: 'galNext' });
}

// Drone Callout: manually pre-annotated aerial photo(s) (design-spec item 6)
// -- "drop file(s) in, no data entry" shape, same as Local Report. A single
// photo is a static image; more than one reuses the gallery's auto-
// advancing track (confirmed 2026-09-15), staggered against the main
// gallery's timing so they don't scroll at the same moment, and auto-
// advancing on its own 5s cadence (2026-09-18, slower than the main
// gallery's 2s -- see SCRIPT's setupTrack). **16:9 (2026-09-18)**, not the
// main gallery's 3:2 (`.aerial-slide` overrides `.gallery-slide`'s aspect-
// ratio; the single-photo case uses the same ratio via `.aerial-single`).
// Both the single image and each track slide open the shared fullscreen
// lightbox on click (`.lightbox-trigger`, see SCRIPT).
function aerialHtml(photos) {
  if (photos.length === 1) {
    return `  <div class="media-frame">
    <img class="frame-img aerial-single lightbox-trigger" data-full="${escapeHtml(photos[0].url)}" src="${escapeHtml(photos[0].url)}" alt="Aerial overview">
  </div>`;
  }
  return trackHtml(photos, { track: 'aerialTrack', prev: 'aerialPrev', next: 'aerialNext' }, { slideClass: 'aerial-slide', lightbox: true });
}

// Floor Plan / Site Plan (2026-09-18) -- same "drop file(s) in, no data
// entry" shape as Drone Callout, positioned right above the neighborhood
// report. A single page is a static image; more than one (main floor,
// second floor, basement) reuses the gallery's auto-advancing track,
// staggered against the other tracks so none of them scroll in lockstep.
// Both the single image and each track slide open the shared fullscreen
// lightbox on click (`.lightbox-trigger`, see SCRIPT) -- unlike Callout,
// keeps the default 3:2 ratio (only Callout asked for 16:9). The single-
// photo case is also height-capped (`.floorplan-single`, 2026-09-19) --
// unlike a photo, a floor plan's own aspect ratio is whatever the export
// happened to be (often much taller/narrower than a 3:2 photo), so
// scaling it to the full content width the way `.frame-img` does for
// Local Report could make it far taller than one screen. Capping height
// instead (width shrinks to fit, `object-fit:contain` so nothing crops)
// keeps the whole plan visible without scrolling on a typical laptop
// screen; the multi-page track keeps the regular 3:2 slide sizing.
function floorplanHtml(photos) {
  if (photos.length === 1) {
    return `  <div class="media-frame">
    <img class="frame-img floorplan-single lightbox-trigger" data-full="${escapeHtml(photos[0].url)}" src="${escapeHtml(photos[0].url)}" alt="Floor plan">
  </div>`;
  }
  return trackHtml(photos, { track: 'floorplanTrack', prev: 'floorplanPrev', next: 'floorplanNext' }, { lightbox: true });
}

// v1: the neighborhood report is a manually cropped HoodQ screenshot (see
// design-spec item 7), a plain image -- not the structured, color-coded
// Schools/Parks/Transit/Safety layout in the visual mockup. Rebuilding that
// structured layout needs real per-category data, which only exists if/when
// the "Future automation goal" (HoodQ API, if one exists) gets built.
function localReportHtml(localReport) {
  return `  <div class="media-frame">
    <img src="${escapeHtml(localReport.url)}" alt="Neighborhood report" style="width:100%;border-radius:6px;display:block;">
  </div>`;
}

// Google Maps confirmed as the provider (design-spec item 8, 2026-09-15).
// The no-API-key `output=embed` form is enough for a static single-pin map.
function googleMapsEmbedUrl(address) {
  return `https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed`;
}

function closingHtml(model) {
  if (!model.closing && !model.address) return '';

  const card = model.address
    ? `<div class="closing-card">
    <iframe class="map-embed" src="${escapeHtml(googleMapsEmbedUrl(model.address))}" loading="lazy" title="Map"></iframe>
    <div class="closing-card-address"><p>${escapeHtml(model.address)}</p></div>
  </div>`
    : '';

  if (model.closing) {
    // One composited section -- the map/address card floats over the closing
    // photo (matches the Zenfolio reference), not two stacked blocks.
    return `<section class="closing" style="background-image:url('${escapeHtml(model.closing.url)}');">${card}</section>`;
  }

  // No closing photo (rare -- a Job with an address but no synced photos
  // yet) -- just the card, centered on the normal page background.
  return `<section class="closing-standalone">${card}</section>`;
}

function page(title, body, opts = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Arima+Madurai:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${body}
${opts.bare ? '' : SCRIPT}
</body>
</html>`;
}

const CSS = `
  :root{
    --bg-header: rgb(251,251,253);
    --bg-content: #FBFBF3;
    --bg-content-alt: #F6F6EC;
    --ink: #23211C;
    --ink-soft: #6E6858;
    --line: rgba(35,33,28,0.10);
    --paper: #ffffff;
    --radius-m: 6px;
    --maxw: 1180px;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg-content);color:var(--ink);font-family:-apple-system,"system-ui","Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}
  img{max-width:100%;display:block;}
  .wrap{max-width:var(--maxw);margin:0 auto;padding-inline:24px;}
  .hero{position:relative;height:min(78vh,680px);min-height:420px;overflow:hidden;background-color:#3a3450;}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg, rgba(10,8,14,0.55) 0%, rgba(10,8,14,0) 42%);}
  .hero-address{position:absolute;right:28px;bottom:26px;z-index:2;font-family:"Arima Madurai","Segoe Script",cursive;font-weight:400;font-size:24px;color:#fff;text-align:right;text-shadow:0 1px 10px rgba(0,0,0,0.35);margin:0;}
  section{padding-block:36px;}
  .section-alt{background:var(--bg-content-alt);}
  .eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;margin:0 0 8px;}
  .media-frame{max-width:var(--maxw);margin:0 auto;padding-inline:24px;}
  .media-box{position:relative;aspect-ratio:16/9;border-radius:var(--radius-m);overflow:hidden;background:#222;width:100%;}
  .tour-box{aspect-ratio:16/9;border-radius:var(--radius-m);overflow:hidden;background:#1c1f28;}
  .gallery-wrap{position:relative;}
  .gallery-track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 12vw;scrollbar-width:none;}
  .gallery-track::-webkit-scrollbar{display:none;}
  .gallery-slide{flex:0 0 76%;max-width:900px;aspect-ratio:3/2;border-radius:var(--radius-m);scroll-snap-align:center;}
  .aerial-slide{aspect-ratio:16/9;}
  .gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:var(--paper);box-shadow:0 1px 4px rgba(0,0,0,0.12);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3;}
  .gallery-arrow.prev{left:14px;} .gallery-arrow.next{right:14px;}
  .gallery-arrow svg{width:16px;height:16px;}
  .frame-img{width:100%;border-radius:var(--radius-m);display:block;}
  .aerial-single{aspect-ratio:16/9;object-fit:cover;}
  .floorplan-single{width:auto;max-width:100%;height:auto;max-height:min(90vh,1000px);margin:0 auto;object-fit:contain;}
  .lightbox-trigger{cursor:zoom-in;}
  .lightbox{position:fixed;inset:0;background:rgba(10,8,14,0.92);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px;}
  .lightbox[hidden]{display:none;}
  .lightbox img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px;}
  .lightbox-close{position:absolute;top:20px;right:24px;width:40px;height:40px;border-radius:50%;border:none;background:rgba(255,255,255,0.14);color:#fff;font-size:26px;line-height:1;cursor:pointer;}
  .lightbox-close:hover{background:rgba(255,255,255,0.24);}
  .closing{position:relative;height:92vh;min-height:560px;overflow:hidden;background-size:cover;background-position:center;}
  .closing-card{
    position:absolute;left:50%;bottom:10%;transform:translateX(-50%);
    width:min(1100px,92%);display:flex;background:var(--paper);
    border-radius:var(--radius-m);overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.28);
  }
  .closing-card .map-embed{flex:1 1 50%;height:320px;border:0;display:block;}
  .closing-card-address{flex:1 1 50%;background:var(--bg-content-alt);display:flex;flex-direction:column;justify-content:center;padding:32px 40px;}
  .closing-card-address p{font-size:16px;margin:0;}
  .closing-standalone{padding-block:48px;display:flex;justify-content:center;}
  .closing-standalone .closing-card{position:static;transform:none;width:min(1100px,100%);box-shadow:none;border:1px solid var(--line);}
  @media (max-width:700px){
    .closing-card{flex-direction:column;}
    .closing-card .map-embed{height:220px;}
    .closing{height:70vh;}
  }
  .notfound{max-width:520px;margin:20vh auto;text-align:center;padding-inline:24px;}
  .notfound h1{font-size:22px;}
  @media (max-width:520px){
    .gallery-slide{flex-basis:88%;}
    .gallery-track{padding:0 6vw;}
    .hero-address{font-size:20px;}
  }
`;

const SCRIPT = `<script>
(function(){
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // phaseOffsetMs staggers this track's auto-advance start against any
  // other track on the page (e.g. the aerial track starts 1s after the
  // main gallery) so two tracks never scroll at the same moment.
  // intervalMs (default 2000) is how often it auto-advances -- Callout runs
  // slower, 5000ms, since 16:9 photos read a bit differently (2026-09-18).
  function setupTrack(trackId, prevId, nextId, phaseOffsetMs, intervalMs){
    var track = document.getElementById(trackId);
    if(!track) return;
    var slideWidth = function(){ return track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 16 : 0; };
    var atEnd = function(){ return track.scrollLeft + track.clientWidth >= track.scrollWidth - 4; };
    function goNext(){ atEnd() ? track.scrollTo({left:0, behavior:'smooth'}) : track.scrollBy({left:slideWidth(), behavior:'smooth'}); }
    function goPrev(){ track.scrollBy({left:-slideWidth(), behavior:'smooth'}); }

    var prev = document.getElementById(prevId), next = document.getElementById(nextId);
    var timer = null;
    function startAuto(){ if(!reduceMotion) timer = setInterval(goNext, intervalMs || 2000); }
    function resetAuto(){ if(timer) clearInterval(timer); startAuto(); }

    if(prev) prev.addEventListener('click', function(){ goPrev(); resetAuto(); });
    if(next) next.addEventListener('click', function(){ goNext(); resetAuto(); });
    if(phaseOffsetMs) setTimeout(startAuto, phaseOffsetMs); else startAuto();
  }

  setupTrack('galTrack', 'galPrev', 'galNext', 0);
  setupTrack('aerialTrack', 'aerialPrev', 'aerialNext', 1000, 5000);
  setupTrack('floorplanTrack', 'floorplanPrev', 'floorplanNext', 2000);

  // Fullscreen viewer for Callout/Floor Plan (2026-09-18) -- any
  // .lightbox-trigger (a single static image or a track slide) opens the
  // shared overlay on click; Esc, the close button, or clicking the
  // backdrop itself all close it.
  var lightbox = document.getElementById('lightbox');
  if(lightbox){
    var lightboxImg = document.getElementById('lightboxImg');
    function openLightbox(url){ lightboxImg.src = url; lightbox.hidden = false; }
    function closeLightbox(){ lightbox.hidden = true; lightboxImg.src = ''; }
    document.querySelectorAll('.lightbox-trigger').forEach(function(el){
      el.addEventListener('click', function(){ openLightbox(el.dataset.full || el.src); });
    });
    document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function(e){ if(e.target === lightbox) closeLightbox(); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeLightbox(); });
  }
})();
</script>`;
