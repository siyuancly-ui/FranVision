// The standalone Gallery page: /delivery/<address-slug>/<token>.
//
// A separate page from the delivery page ("All in One") -- that page does not
// link here; the link only goes into the post-payment part of the Delivery
// Email (job-generator/delivery-email.js). Delivery is gated on payment, so the
// URL must not be guessable from the sequential jobId (FVS-YYYYMMDD-NNN):
// `token` is a random 128-bit value (32 hex) minted server-side, once per Job,
// by Supabase's jg_gallery_token() (job-generator/supabase/gallery.sql) and
// resolved back to the jobId here via the gallery_tokens table
// (supabase.js#getGalleryJobId). Nothing is derived from the jobId, and no
// signing secret exists on any machine. The address slug is cosmetic only and
// never inspected, same as the delivery page's pretty URL.
//
// Pure like render.js: index.js hands in the raw `projects` row, everything
// here is string building, unit-tested without a network.

import { buildDeliveryModel, creditHtml, escapeHtml, heroHtml, page, slugifyAddress } from './render.js';

// Cheap shape check before any database lookup (rejects raw jobIds, junk, and
// anything that could be a query-string injection attempt).
export function isGalleryToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
}

// "/delivery/<address-slug>/<token>" -- what the Delivery Email links to.
export function galleryPath(address, token) {
  return `/delivery/${slugifyAddress(address) || 'photos'}/${token}`;
}

const DEFAULT_ASPECT = 1.5;

// opts = the same folder config buildDeliveryModel takes (hero/address/photo
// selection are reused as-is, so the Gallery hero always matches the delivery
// page's), plus jobId/supabaseUrl. `pendingCopySources` = source paths whose
// 2048px MLS copy is still queued for generation (supabase.js#listPendingCopySources).
//
// The grid = the main photos followed by the Callout (aerial) photos, like the
// delivery page's own order. Both ZIPs are built from exactly these photos.
export function buildGalleryModel(project, opts, pendingCopySources = new Set()) {
  const base = buildDeliveryModel(project, opts);
  const raw = (project && project.data && project.data.photos) || [];
  const byId = new Map(raw.map((p) => [p.photoId, p]));
  const calloutIds = new Set(base.aerial.map((a) => a.photoId));
  const seen = new Set();
  const grid = [...base.gallery, ...base.aerial].filter((g) => !seen.has(g.photoId) && seen.add(g.photoId));
  const inGrid = grid.map((g) => byId.get(g.photoId)).filter(Boolean);

  // Originals need only the synced source file. The MLS ZIP is the photos that
  // HAVE a 2048px copy: an old Callout photo (synced before 2026-09-23, when
  // Callout copies began) never got one and is simply left out; a MAIN photo with
  // no copy, or any copy still queued for generation, means "not ready" -- the
  // MLS ZIP is never a silently smaller archive, it turns on by itself later.
  const mlsPhotos = inGrid.filter((p) => p.downloadDropboxPath);
  const mainMissingCopy = inGrid.some((p) => !calloutIds.has(p.photoId) && !p.downloadDropboxPath);
  const anyPending = mlsPhotos.some((p) => pendingCopySources.has(p.dropboxPath));

  return {
    found: base.found,
    jobId: opts.jobId,
    address: base.address,
    hero: base.hero,
    photos: grid.map((g) => ({
      photoId: g.photoId,
      url: g.url,
      aspect: g.width > 0 && g.height > 0 ? g.width / g.height : DEFAULT_ASPECT,
      hasWeb: Boolean((byId.get(g.photoId) || {}).downloadDropboxPath),
      name: String((byId.get(g.photoId) || {}).filename || ''),
      canDownload: Boolean((byId.get(g.photoId) || {}).dropboxPath),  // single-photo original download
    })),
    // The ids the download route sends to photo-sync-worker for each ZIP (the grid
    // is the single source of truth for what a ZIP contains).
    originalPhotoIds: inGrid.map((p) => p.photoId),
    mlsPhotoIds: mlsPhotos.map((p) => p.photoId),
    originalReady: inGrid.length > 0 && inGrid.every((p) => p.dropboxPath),
    mlsReady: mlsPhotos.length > 0 && !mainMissingCopy && !anyPending,
  };
}

// Content-Disposition for a single-photo download: an ASCII fallback plus the real
// (possibly non-ASCII) name via RFC 5987, quotes/control characters stripped.
export function attachmentDisposition(filename) {
  const name = String(filename || 'photo.jpg').replace(/[\u0000-\u001f\\/"]/g, '').trim() || 'photo.jpg';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function zipFilename(address, jobId, kind) {
  const slug = slugifyAddress(address) || jobId;
  return `${slug}-${kind === 'mls' ? 'mls' : 'original'}-photos.zip`;
}

export function renderGalleryNotFoundPage() {
  return page('Gallery', `
<div class="notfound">
  <p class="eyebrow">FranVision Media</p>
  <h1>This gallery link isn't valid</h1>
  <p>Please use the link from your delivery email, or reach out to Franky directly.</p>
</div>`, { bare: true });
}

// Shown instead of a download when the photos/ZIP aren't ready (or a lookup
// hiccuped). Deliberately plain and reassuring -- clients are not technical.
export function renderGalleryPreparingPage(backHref) {
  return page('Gallery', `
<div class="notfound">
  <p class="eyebrow">Photos</p>
  <h1>Your download is still being prepared</h1>
  <p>This usually takes just a few minutes after your photos are uploaded. Please try again shortly.</p>
  ${backHref ? `<p><a href="${escapeHtml(backHref)}">&larr; Back to the gallery</a></p>` : ''}
</div>`, { bare: true });
}

// The download glyph: arrow down into a tray (the studio's chosen icon).
const DL_ICON = '<svg class="dl-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 3.5v11m0 0-4.4-4.4M12 14.5l4.4-4.4M4 15.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const CHEV_L = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M15 4.5 7.5 12 15 19.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="m9 4.5 7.5 7.5L9 19.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SUN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

// Button/photo URLs hang off this page's own path (`base`, i.e.
// galleryPath(address, token)), so the token travels in the URL, never a query.
export function renderGalleryPage(model, { base }) {
  const preparing = (label) => `<span class="dl-btn is-disabled" title="Still preparing -- please check back in a few minutes">${DL_ICON}<span class="dl-label">${label}&hellip;</span></span>`;
  const zipBtn = (kind, label) => `<a class="dl-btn" href="${base}/zip/${kind}" aria-label="Download ${label}" data-dl>${DL_ICON}<span class="dl-label">${label}</span></a>`;
  const buttons = [];
  if (model.photos.length > 0) {
    buttons.push(model.originalReady ? zipBtn('original', 'All Original Photos (ZIP)') : preparing('Preparing Original Photos'));
    buttons.push(model.mlsReady ? zipBtn('mls', 'All MLS Photos (ZIP)') : preparing('Preparing MLS Photos'));
  }

  // Layout follows the Zenfolio sample the studio already uses: full-height
  // hero (big serif address bottom-right, scroll chevron; no brand text up here;
  // the "Photos by" credit is the page footer), then a sticky bar -- address left, the
  // download buttons right (where the sample has its icons).
  const heroExtra = `<a class="hero-chevron" href="#photos" aria-label="Scroll to photos"><svg viewBox="0 0 56 24" width="56" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3l26 17L54 3"/></svg></a>`;
  const bar = `<header class="g-bar">
  <div class="g-bar-inner">
    <div class="g-bar-title">${model.address ? `<div class="g-bar-addr">${escapeHtml(model.address)}</div>` : ''}</div>
    ${buttons.length ? `<div class="g-bar-actions">${buttons.join('')}</div>` : ''}
  </div>
</header>`;

  // Grid tiles: on hover (like the sample) the photo dims, its file name shows in the
  // middle and a download icon appears bottom-left -- one click saves that photo's
  // original without opening it.
  const dlHref = (p) => `${base}/download/${encodeURIComponent(p.photoId)}`;
  const figures = model.photos.map((p, i) =>
    `<figure class="g-item" data-i="${i}" style="aspect-ratio:${p.aspect.toFixed(4)}"><img src="${escapeHtml(p.url)}" alt="" loading="${i < 9 ? 'eager' : 'lazy'}" decoding="async"><div class="g-hover">${p.name ? `<span class="g-name">${escapeHtml(p.name)}</span>` : ''}${p.canDownload ? `<a class="g-dl" href="${escapeHtml(dlHref(p))}" download aria-label="Download ${escapeHtml(p.name || 'photo')}" title="Download">${DL_ICON}</a>` : ''}</div></figure>`,
  ).join('\n');

  // Lightbox data: thumb shows instantly, the 2048 web copy loads over it.
  const data = model.photos.map((p) => ({
    t: p.url,
    w: p.hasWeb ? `${base}/photo/${encodeURIComponent(p.photoId)}` : null,
    n: p.name,
    d: p.canDownload ? dlHref(p) : null,
  }));

  const body = `
${heroHtml(model, heroExtra)}
${bar}
<main class="g-wrap" id="photos">
  ${model.photos.length ? `<div class="g-masonry" id="masonry">\n${figures}\n</div>` : '<p class="g-empty">Photos are still being prepared — please check back shortly.</p>'}
</main>
${creditHtml()}
<div class="lb" id="lb" hidden>
  <div class="lb-stage" id="lbStage"><img id="lbImg" src="" alt=""></div>
  <button class="lb-ui lb-close" id="lbClose" type="button" aria-label="Close">${X_ICON}</button>
  <div class="lb-ui lb-top"><a class="lb-dl" id="lbDl" href="#" download aria-label="Download this photo" title="Download">${DL_ICON}</a></div>
  <div class="lb-ui lb-theme" id="lbTheme" role="group" aria-label="Background"><button type="button" data-theme="light" aria-label="Light background">${SUN_ICON}</button><button type="button" data-theme="dark" aria-label="Dark background">${MOON_ICON}</button></div>
  <button class="lb-ui lb-nav lb-prev" id="lbPrev" type="button" aria-label="Previous photo">${CHEV_L}</button>
  <button class="lb-ui lb-nav lb-next" id="lbNext" type="button" aria-label="Next photo">${CHEV_R}</button>
  <div class="lb-ui lb-bottom"><div class="lb-name" id="lbName"></div><div class="lb-strip" id="lbStrip"></div><div class="lb-count" id="lbCount"></div></div>
</div>`;

  return page(model.address ? `${model.address} — Photos` : 'Photos', body, {
    bare: true,
    extraHead: GALLERY_HEAD,
    extraCss: GALLERY_CSS,
    extraBody: `<script>window.__GALLERY__=${JSON.stringify(data).replace(/</g, '\\u003c')};</script>\n<script>${GALLERY_SCRIPT}</script>`,
  });
}

const GALLERY_HEAD = '<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Montserrat:wght@300;400;500&family=Lato:wght@400;700&display=swap" rel="stylesheet">';

const GALLERY_CSS = `
  html{scroll-behavior:smooth;}
  .hero{height:85vh;height:85svh;min-height:420px;}
  .hero-address{font-family:Fraunces,Georgia,"Times New Roman",serif;font-weight:400;font-size:clamp(26px,3.2vw,56px);line-height:1.15;right:9%;bottom:12%;left:9%;text-align:right;text-shadow:0 2px 16px rgba(0,0,0,0.4);}
  .hero-chevron{position:absolute;left:50%;bottom:22px;z-index:2;transform:translateX(-50%);color:#fff;opacity:.9;line-height:0;}
  .hero-chevron:hover{opacity:1;}
  .g-bar{position:sticky;top:0;z-index:20;background:rgba(251,251,253,0.96);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-bottom:1px solid rgba(35,33,28,0.10);}
  .g-bar-inner{max-width:1180px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:20px;}
  .g-bar-addr{font-family:Montserrat,-apple-system,sans-serif;font-weight:300;font-size:clamp(15px,1.6vw,22px);letter-spacing:.02em;text-transform:uppercase;color:#4a473f;line-height:1.25;}
  .g-bar-actions{display:flex;gap:10px;flex-shrink:0;}
  /* Raised, slightly grey buttons (not the flat outline of a cookie banner): a soft
     top-to-bottom grey gradient, a drop shadow and an inner highlight, pressed = inset. */
  .dl-btn{display:inline-flex;align-items:center;gap:9px;padding:10px 18px;border:1px solid #a9a9b0;border-radius:999px;background:linear-gradient(180deg,#fbfbfc 0%,#e3e3e7 55%,#d3d3d9 100%);color:#3a3a40;font-family:Montserrat,-apple-system,sans-serif;font-size:13px;font-weight:500;letter-spacing:.01em;text-decoration:none;white-space:nowrap;box-shadow:0 3px 7px rgba(30,30,40,0.22),0 1px 2px rgba(30,30,40,0.18),inset 0 1px 0 rgba(255,255,255,0.9);text-shadow:0 1px 0 rgba(255,255,255,0.7);transition:box-shadow .15s,transform .15s,background .15s;}
  .dl-btn:hover{background:linear-gradient(180deg,#ffffff 0%,#ececf0 55%,#dcdce2 100%);box-shadow:0 5px 11px rgba(30,30,40,0.26),0 1px 3px rgba(30,30,40,0.2),inset 0 1px 0 #fff;transform:translateY(-1px);}
  .dl-btn:active{transform:translateY(1px);background:linear-gradient(180deg,#d3d3d9 0%,#e0e0e5 100%);box-shadow:inset 0 2px 4px rgba(30,30,40,0.3);}
  .dl-ico{flex-shrink:0;}
  .dl-btn.is-busy{opacity:.65;pointer-events:none;}
  .dl-btn.is-disabled{opacity:.5;cursor:default;pointer-events:none;box-shadow:0 1px 2px rgba(30,30,40,0.12);}
  #photos{scroll-margin-top:84px;}
  .g-wrap{max-width:1180px;margin:0 auto;padding:8px 8px 48px;}
  .g-masonry{column-count:3;column-gap:8px;}
  .g-masonry.is-laid-out{display:flex;gap:8px;align-items:flex-start;column-count:auto;}
  .g-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:8px;}
  .g-item{position:relative;margin:0 0 8px;break-inside:avoid;background:#e6e4dc;cursor:zoom-in;overflow:hidden;}
  .is-laid-out .g-item{margin:0;}
  .g-item img{width:100%;height:100%;object-fit:cover;display:block;}
  /* hover (sample): dim, file name centred, download icon bottom-left */
  .g-hover{position:absolute;inset:0;background:rgba(0,0,0,0.42);opacity:0;transition:opacity .18s;display:flex;align-items:center;justify-content:center;pointer-events:none;}
  .g-item:hover .g-hover,.g-item:focus-within .g-hover{opacity:1;pointer-events:auto;}
  .g-name{color:#fff;font-family:Lato,Montserrat,-apple-system,sans-serif;font-size:13px;letter-spacing:.02em;padding:5px 12px;border-radius:4px;background:rgba(0,0,0,0.28);max-width:86%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .g-dl{position:absolute;left:10px;bottom:9px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:#fff;border-radius:50%;cursor:pointer;}
  .g-dl:hover{background:rgba(255,255,255,0.22);}
  .g-dl .dl-ico{width:22px;height:22px;}
  .g-empty{text-align:center;color:#6b665b;padding:64px 0;}
  /* Lightbox (sample): black stage, close top-left, download top-centre, theme pill
     top-right, arrows at the sides, and a bottom band with file name / thumbnail
     strip / counter. Controls fade out when idle and return on any movement. */
  .lb{position:fixed;inset:0;z-index:50;background:#000;color:#fff;font-family:Lato,Montserrat,-apple-system,sans-serif;}
  .lb[hidden]{display:none;}
  .lb.lb-light{background:#fff;color:#2b2b30;}
  .lb-stage{position:absolute;top:60px;bottom:65px;left:0;right:0;display:flex;align-items:center;justify-content:center;}
  .lb-stage img{max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;}
  .lb-ui{transition:opacity .35s;}
  .lb.is-idle .lb-ui{opacity:0;pointer-events:none;}
  .lb.is-idle{cursor:none;}
  .lb button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0;}
  .lb-close{position:absolute;top:16px;left:18px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:50%;opacity:.9;}
  .lb-top{position:absolute;top:14px;left:0;right:0;display:flex;justify-content:center;gap:22px;pointer-events:none;}
  .lb-dl{pointer-events:auto;display:flex;align-items:center;justify-content:center;width:40px;height:40px;color:inherit;border-radius:50%;opacity:.92;}
  .lb-dl .dl-ico{width:26px;height:26px;}
  .lb-dl[hidden]{display:none;}
  .lb-close:hover,.lb-dl:hover{background:rgba(128,128,128,0.25);}
  .lb-theme{position:absolute;top:10px;right:16px;display:flex;align-items:center;border:1px solid rgba(128,128,128,0.45);border-radius:999px;padding:3px;gap:2px;}
  .lb-theme button{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;opacity:.6;}
  .lb-theme button.is-on{background:#fff;color:#222;opacity:1;box-shadow:0 1px 3px rgba(0,0,0,0.35);}
  .lb.lb-light .lb-theme button.is-on{background:#222;color:#fff;}
  .lb-nav{position:absolute;top:50%;transform:translateY(-50%);width:56px;height:56px;display:flex;align-items:center;justify-content:center;border-radius:50%;opacity:.9;}
  .lb-nav:hover{background:rgba(128,128,128,0.22);}
  .lb-prev{left:22px;} .lb-next{right:22px;}
  .lb-nav[hidden]{display:none;}
  .lb-bottom{position:absolute;left:0;right:0;bottom:0;height:152px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;padding-bottom:14px;background:rgba(0,0,0,0.5);}
  .lb.lb-light .lb-bottom{background:rgba(255,255,255,0.55);}
  .lb-name{font-size:13px;opacity:.75;letter-spacing:.02em;min-height:18px;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .lb-strip{display:flex;align-items:center;justify-content:center;gap:14px;height:72px;}
  .lb-thumb{width:57px;height:57px;border-radius:4px;overflow:hidden;opacity:.72;flex:0 0 57px;transition:opacity .15s;}
  .lb-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
  .lb-thumb:hover{opacity:1;}
  .lb-thumb.is-cur{width:70px;height:70px;flex-basis:70px;opacity:1;box-shadow:0 0 0 2px rgba(255,255,255,0.85);}
  .lb.lb-light .lb-thumb.is-cur{box-shadow:0 0 0 2px rgba(0,0,0,0.6);}
  .lb-thumb.is-empty{visibility:hidden;pointer-events:none;}
  .lb-count{font-size:13px;opacity:.7;letter-spacing:.06em;}
  @media (max-width:900px){
    .g-bar-inner{flex-direction:column;align-items:flex-start;gap:12px;padding:14px 16px;}
    .g-bar-actions{width:100%;}
    .dl-btn{flex:1 1 0;text-align:center;white-space:normal;padding:9px 10px;font-size:12px;line-height:1.3;}
    #photos{scroll-margin-top:120px;}
  }
  @media (max-width:640px){
    .hero-address{right:6%;left:6%;bottom:14%;}
    .g-wrap{padding-inline:4px;}
    .lb-nav{width:40px;height:40px;} .lb-prev{left:6px;} .lb-next{right:6px;}
    .lb-bottom{height:128px;} .lb-strip{gap:8px;height:56px;} .lb-thumb{width:44px;height:44px;flex-basis:44px;} .lb-thumb.is-cur{width:54px;height:54px;flex-basis:54px;} .lb-thumb.far{display:none;}
    .lb-stage{top:56px;bottom:56px;}
    .g-dl{width:32px;height:32px;}
  }
`;

// Masonry: photos go into the currently-shortest column (using each photo's
// known aspect ratio, so no layout shift as images load) -- keeps the shoot
// order reading left-to-right instead of CSS columns' top-to-bottom. Without
// JS the CSS `column-count` version above is the fallback.
const GALLERY_SCRIPT = `
(function(){
  var data = window.__GALLERY__ || [];
  var grid = document.getElementById('masonry');
  var items = grid ? Array.prototype.slice.call(grid.children) : [];
  var cols = 0;
  function colCount(){ var w = window.innerWidth; return w < 640 ? 2 : w < 1500 ? 3 : 4; }
  function layout(){
    if (!grid) return;
    var n = colCount();
    if (n === cols) return;
    cols = n;
    var heights = [], cs = [];
    for (var i = 0; i < n; i++) { heights.push(0); var c = document.createElement('div'); c.className = 'g-col'; cs.push(c); }
    items.forEach(function(el){
      var ar = parseFloat(el.style.aspectRatio) || 1.5, m = 0;
      for (var j = 1; j < n; j++) if (heights[j] < heights[m]) m = j;
      cs[m].appendChild(el); heights[m] += 1 / ar;
    });
    grid.textContent = '';
    cs.forEach(function(c){ grid.appendChild(c); });
    grid.classList.add('is-laid-out');
  }
  layout();
  var rt; window.addEventListener('resize', function(){ clearTimeout(rt); rt = setTimeout(layout, 120); });

  // Lightbox (Zenfolio-sample layout): thumbnail strip + file name + counter at the
  // bottom, download top-centre, arrows at the sides (none past the first/last photo),
  // day/night background, and controls that fade out when idle.
  var lb = document.getElementById('lb'), img = document.getElementById('lbImg'), count = document.getElementById('lbCount');
  var nameEl = document.getElementById('lbName'), strip = document.getElementById('lbStrip'), dl = document.getElementById('lbDl');
  var prevBtn = document.getElementById('lbPrev'), nextBtn = document.getElementById('lbNext');
  var cur = -1, idleT = null;

  function wake(){
    lb.classList.remove('is-idle');
    clearTimeout(idleT);
    idleT = setTimeout(function(){ if (!lb.hidden) lb.classList.add('is-idle'); }, 3000);
  }
  function setTheme(t){
    lb.classList.toggle('lb-light', t === 'light');
    Array.prototype.forEach.call(document.querySelectorAll('#lbTheme button'), function(b){ b.classList.toggle('is-on', b.getAttribute('data-theme') === t); });
    try { localStorage.setItem('galleryLbTheme', t); } catch (e) {}
  }
  var saved = 'dark'; try { saved = localStorage.getItem('galleryLbTheme') === 'light' ? 'light' : 'dark'; } catch (e) {}
  setTheme(saved);
  Array.prototype.forEach.call(document.querySelectorAll('#lbTheme button'), function(b){
    b.addEventListener('click', function(e){ e.stopPropagation(); setTheme(b.getAttribute('data-theme')); wake(); });
  });

  function buildStrip(){
    strip.textContent = '';
    for (var k = -4; k <= 4; k++) {
      var i = cur + k, b = document.createElement('button');
      b.type = 'button';
      b.className = 'lb-thumb' + (k === 0 ? ' is-cur' : '') + (Math.abs(k) >= 3 ? ' far' : '');
      if (i < 0 || i >= data.length) { b.className += ' is-empty'; b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); }
      else {
        var im = document.createElement('img'); im.src = data[i].t; im.alt = ''; b.appendChild(im);
        b.setAttribute('aria-label', 'Photo ' + (i + 1));
        (function(j){ b.addEventListener('click', function(e){ e.stopPropagation(); show(j); wake(); }); })(i);
      }
      strip.appendChild(b);
    }
  }
  function show(i){
    if (!data.length) return;
    cur = Math.max(0, Math.min(data.length - 1, i));
    var d = data[cur];
    img.src = d.t; // thumb right away, sharper copy replaces it once loaded
    if (d.w) {
      var big = new Image(), at = cur;
      big.onload = function(){ if (cur === at) img.src = d.w; };
      big.src = d.w;
    }
    nameEl.textContent = d.n || '';
    count.textContent = (cur + 1) + ' / ' + data.length;
    if (d.d) { dl.href = d.d; dl.hidden = false; if (d.n) dl.setAttribute('download', d.n); } else { dl.hidden = true; }
    prevBtn.hidden = cur === 0; nextBtn.hidden = cur === data.length - 1;
    buildStrip();
    [cur + 1, cur - 1].forEach(function(k){ var n = data[k]; if (n && n.w) new Image().src = n.w; });
  }
  function open(i){ lb.hidden = false; document.body.style.overflow = 'hidden'; show(i); wake(); }
  function close(){ lb.hidden = true; lb.classList.remove('is-idle'); clearTimeout(idleT); document.body.style.overflow = ''; img.src = ''; cur = -1; }
  if (grid) grid.addEventListener('click', function(e){
    if (e.target.closest && e.target.closest('.g-dl')) return;   // the tile's own download icon: just download
    var f = e.target.closest ? e.target.closest('.g-item') : null;
    if (f) open(parseInt(f.getAttribute('data-i'), 10));
  });
  document.getElementById('lbClose').onclick = close;
  prevBtn.onclick = function(e){ e.stopPropagation(); show(cur - 1); wake(); };
  nextBtn.onclick = function(e){ e.stopPropagation(); show(cur + 1); wake(); };
  dl.addEventListener('click', function(e){ e.stopPropagation(); wake(); });
  document.getElementById('lbStage').addEventListener('click', function(e){ if (e.target === this || e.target === img) { if (lb.classList.contains('is-idle')) wake(); else close(); } });
  ['mousemove', 'mousedown', 'touchstart'].forEach(function(ev){ lb.addEventListener(ev, function(){ if (!lb.hidden) wake(); }, { passive: true }); });
  document.addEventListener('keydown', function(e){
    if (lb.hidden) return;
    wake();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  });
  var x0 = null;
  lb.addEventListener('touchstart', function(e){ x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', function(e){
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) show(cur + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Download buttons: the zip streams from Dropbox so it can take a few
  // seconds to start -- give the click visible feedback (only the text changes,
  // the icon stays).
  Array.prototype.forEach.call(document.querySelectorAll('[data-dl]'), function(a){
    a.addEventListener('click', function(){
      var lab = a.querySelector('.dl-label'); if (!lab) return;
      var t = lab.textContent; a.classList.add('is-busy'); lab.textContent = 'Preparing your download…';
      setTimeout(function(){ a.classList.remove('is-busy'); lab.textContent = t; }, 6000);
    });
  });
})();
`;
