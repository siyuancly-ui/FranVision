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
  coverPhotoFolder, closingPhotoFolder, droneCalloutFolder,
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

  // Manual-override folders (Cover Photo / Closing Photo / Drone Callout) --
  // a human drops one photo in, no data-entry needed. Job Generator doesn't
  // create these by default yet, so most jobs won't have anything in them;
  // that's fine, everything below falls back cleanly.
  const coverOverride = coverPhotoFolder ? pickPhotos(photos, [coverPhotoFolder])[0] : null;
  const closingOverride = closingPhotoFolder ? pickPhotos(photos, [closingPhotoFolder])[0] : null;
  const aerialPhoto = droneCalloutFolder ? pickPhotos(photos, [droneCalloutFolder])[0] : null;

  // No override -> falls back to the 3rd / 5th gallery photo by filename
  // (confirmed 2026-09-15) -- the very first/last shot in a folder is often
  // an awkward establishing angle, not the best hero/closing candidate.
  // Clamped to whatever's actually available in a small gallery, and kept
  // distinct from each other whenever more than one photo exists.
  const heroFallback = fallbackPhoto(galleryPhotos, 2);
  let closingFallback = fallbackPhoto(galleryPhotos, 4);
  // Only avoid a duplicate pick when BOTH slots are actually relying on
  // this fallback -- a Cover Photo override wins its own slot regardless
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
    aerial: aerialPhoto ? toImgLarge(aerialPhoto) : null,
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
${headerHtml()}
${heroHtml(model)}
${section('<section>\n  <div class="section-head"><p class="eyebrow">Aerial Teaser</p><h2 class="section-title">See it from above</h2></div>', model.video && videoHtml(model.video))}
${section('<section class="section-alt">\n  <div class="section-head"><p class="eyebrow">Virtual Walkthrough</p><h2 class="section-title">Walk the space</h2></div>', model.tour && tourHtml(model.tour))}
${section('<section>\n  <div class="section-head"><p class="eyebrow">Full Gallery</p><h2 class="section-title">Every room, every angle</h2></div>', model.gallery.length > 0 && galleryHtml(model.gallery))}
${section('<section class="section-alt">\n  <div class="section-head"><p class="eyebrow">Aerial Overview</p><h2 class="section-title">The neighborhood at a glance</h2></div>', model.aerial && aerialHtml(model.aerial))}
${section('<section>\n  <div class="section-head"><p class="eyebrow">The Neighborhood</p><h2 class="section-title">What\'s nearby</h2></div>', model.localReport && localReportHtml(model.localReport))}
${closingHtml(model)}
<footer class="site">FranVision Media — Photography for real estate professionals</footer>`;
  return page(model.address ? `${model.address} — FranVision Media` : 'FranVision Delivery Page', body);
}

function headerHtml() {
  return `<header class="site">
  <div class="logo-mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="#23211C" stroke-width="1.5"><circle cx="12" cy="13" r="6.2"/><path d="M8.6 7.4l1-1.9h4.8l1 1.9" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="13" r="2.3"/></svg>
  </div>
</header>`;
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
  return `  <div class="media-frame">
    <div class="media-box" style="cursor:default;">
      <iframe src="${escapeHtml(video.playbackUrl)}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>
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

function galleryHtml(gallery) {
  const slides = gallery.map((p) => `<div class="gallery-slide" style="background-image:url('${escapeHtml(p.url)}');background-size:cover;background-position:center;"></div>`).join('\n    ');
  return `  <div class="gallery-wrap">
    <button class="gallery-arrow prev" id="galPrev" aria-label="Previous photo"><svg viewBox="0 0 24 24" fill="none" stroke="#23211C" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg></button>
    <div class="gallery-track" id="galTrack">
    ${slides}
    </div>
    <button class="gallery-arrow next" id="galNext" aria-label="Next photo"><svg viewBox="0 0 24 24" fill="none" stroke="#23211C" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg></button>
  </div>`;
}

// Drone Callout: a manually pre-annotated aerial photo (design-spec item 6)
// -- a static image, same "drop one file in, no data entry" shape as
// Local Report. No annotation/label-placement logic here, same reasoning.
function aerialHtml(aerial) {
  return `  <div class="media-frame">
    <img src="${escapeHtml(aerial.url)}" alt="Aerial overview" style="width:100%;border-radius:6px;display:block;">
  </div>`;
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
    <div class="closing-card-address"><p class="eyebrow">Location</p><p>${escapeHtml(model.address)}</p></div>
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
  header.site{background:var(--bg-header);border-bottom:1px solid var(--line);padding-block:18px;display:flex;justify-content:center;}
  .logo-mark{width:44px;height:44px;border-radius:50%;border:1.5px solid var(--ink);display:flex;align-items:center;justify-content:center;}
  .logo-mark svg{width:22px;height:22px;display:block;}
  .hero{position:relative;height:min(78vh,680px);min-height:420px;overflow:hidden;background-color:#3a3450;}
  .hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg, rgba(10,8,14,0.55) 0%, rgba(10,8,14,0) 42%);}
  .hero-address{position:absolute;right:28px;bottom:26px;z-index:2;font-family:"Arima Madurai","Segoe Script",cursive;font-weight:400;font-size:24px;color:#fff;text-align:right;text-shadow:0 1px 10px rgba(0,0,0,0.35);margin:0;}
  section{padding-block:64px;}
  .section-alt{background:var(--bg-content-alt);}
  .section-head{max-width:640px;margin:0 auto 28px;text-align:center;}
  .eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;margin:0 0 8px;}
  .section-title{font-size:26px;font-weight:600;margin:0;letter-spacing:-0.01em;}
  .media-frame{max-width:var(--maxw);margin:0 auto;padding-inline:24px;}
  .media-box{position:relative;aspect-ratio:16/9;border-radius:var(--radius-m);overflow:hidden;background:#222;width:100%;}
  .tour-box{aspect-ratio:16/9;border-radius:var(--radius-m);overflow:hidden;background:#1c1f28;}
  .gallery-wrap{position:relative;}
  .gallery-track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 12vw;scrollbar-width:none;}
  .gallery-track::-webkit-scrollbar{display:none;}
  .gallery-slide{flex:0 0 76%;max-width:900px;aspect-ratio:3/2;border-radius:var(--radius-m);scroll-snap-align:center;}
  .gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:var(--paper);box-shadow:0 1px 4px rgba(0,0,0,0.12);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:3;}
  .gallery-arrow.prev{left:14px;} .gallery-arrow.next{right:14px;}
  .gallery-arrow svg{width:16px;height:16px;}
  .closing{position:relative;height:92vh;min-height:560px;overflow:hidden;background-size:cover;background-position:center;}
  .closing-card{
    position:absolute;left:50%;bottom:10%;transform:translateX(-50%);
    width:min(1100px,92%);display:flex;background:var(--paper);
    border-radius:var(--radius-m);overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.28);
  }
  .closing-card .map-embed{flex:1 1 50%;height:320px;border:0;display:block;}
  .closing-card-address{flex:1 1 50%;background:var(--bg-content-alt);display:flex;flex-direction:column;justify-content:center;padding:32px 40px;}
  .closing-card-address .eyebrow{text-align:left;margin-bottom:10px;}
  .closing-card-address p:last-child{font-size:16px;margin:0;}
  .closing-standalone{padding-block:48px;display:flex;justify-content:center;}
  .closing-standalone .closing-card{position:static;transform:none;width:min(1100px,100%);box-shadow:none;border:1px solid var(--line);}
  @media (max-width:700px){
    .closing-card{flex-direction:column;}
    .closing-card .map-embed{height:220px;}
    .closing{height:70vh;}
  }
  footer.site{padding:32px 24px 44px;text-align:center;color:var(--ink-soft);font-size:12.5px;letter-spacing:.02em;}
  .notfound{max-width:520px;margin:20vh auto;text-align:center;padding-inline:24px;}
  .notfound h1{font-size:22px;}
  @media (max-width:520px){
    .section-title{font-size:22px;}
    .gallery-slide{flex-basis:88%;}
    .gallery-track{padding:0 6vw;}
    .hero-address{font-size:20px;}
  }
`;

const SCRIPT = `<script>
(function(){
  var track = document.getElementById('galTrack');
  if(!track) return;
  var slideWidth = function(){ return track.firstElementChild ? track.firstElementChild.getBoundingClientRect().width + 16 : 0; };
  var prev = document.getElementById('galPrev'), next = document.getElementById('galNext');
  if(prev) prev.addEventListener('click', function(){ track.scrollBy({left:-slideWidth(), behavior:'smooth'}); });
  if(next) next.addEventListener('click', function(){ track.scrollBy({left:slideWidth(), behavior:'smooth'}); });
})();
</script>`;
